# CAL → Lovable porting options (monetization-driven)

Scope note: this file only exists to compare options. Nothing outside `./lovable/` has been touched, and no
build-out has started on any option — see `task_plan.md`.

## The fact that shapes everything

CAL is currently **hard-wired to exactly one owner**: `routes/auth.ts` rejects any login where the email
isn't a single `PRIMARY_ACCOUNT_EMAIL` env var. There's no self-serve signup, no billing, no plan tiers —
none of that exists yet, on any stack. So "monetize CAL" always means building a real multi-tenant
signup + billing layer from scratch. The four options below differ only in **where** that layer lives and
**how much of the existing Workers app carries over untouched.** Full detail in `notes.md`.

The parts of CAL that are genuinely hard and already proven in production — the sync engine's Workers
subrequest-limit tuning, the KV-gated daily recurring-series audit, encrypted token custody, and the
security-reviewed public booking/poll flows — are the parts most expensive to redo and least likely to
benefit from a rewrite. That's the throughline across the recommendation below.

---

## Option A — Full port: React + Supabase (all-Lovable)

Rebuild everything on Lovable's stack: Supabase Postgres replaces D1+KV, Supabase Edge Functions +
`pg_cron` replace the Cron Trigger, Supabase Auth handles signup/session, Stripe (native Lovable
integration) handles billing, React/shadcn replaces the server-rendered Hono JSX views.

**Gains**: one stack, fastest *frontend* iteration via Lovable's AI editor, Stripe wired in a few clicks,
Resend carries over almost as-is (already the email provider).

**Costs**:
- The sync engine's Workers-specific tuning (rolling 42-day window sized to stay under CF's subrequest
  limit, the KV-gated once-daily audit) has to be *re-derived* against Supabase's cron/function limits, not
  just copied — and those limits haven't been checked yet (see `notes.md`'s open question).
- Encrypted token-custody code (AES-GCM via Web Crypto) has to move to Postgres/Edge Function crypto
  primitives — doable, but it's the single most security-sensitive piece of the app, and it's currently
  working and reviewed.
- The two public, HTML-only, no-JSON-API booking flows (`/book/:id`, `/meet/:id`) were deliberately built
  without a REST surface after a security review found real bugs in that exact area. Porting into a
  React+Supabase app means either preserving that constraint deliberately or re-deriving its protections.
- Supabase Auth is built for "one identity per user"; CAL needs "one user, N linked *external* Google
  accounts with custody of their refresh tokens" — this stays custom on Supabase too, so it's not actually
  a win Option A gets and others don't.
- Highest total effort and highest risk of quietly losing a subtlety the current code already handles
  (several DB helper comments reference bugs found by a *second*, independent security review — see
  `notes.md`).

**Best fit if**: the goal is "leave Cloudflare entirely" for reasons beyond monetization (e.g., team
familiarity, hiring, wanting Lovable's editor as the primary dev workflow going forward).

---

## Option B — Keep the CF Workers backend, new frontend + billing in Lovable

Leave `src/` almost untouched. Build a new customer-facing app in Lovable (React on Supabase) that: (1)
owns signup, login, and Stripe billing itself, (2) talks to the existing Hono API for everything
calendar-related. The existing app's JSON API surface (`routes/api.ts`) would need to grow to cover what
the dashboard views currently render server-side, and the primary-account gate in `auth.ts` needs to
become "any paying user," but the sync engine, token custody, and booking flows don't move.

**Gains**: doesn't touch the parts of the app that are hardest to get right and already work in production;
Stripe/signup in Lovable is genuinely a good fit for that half of the problem; smallest blast radius.

**Costs**:
- Two deployed systems instead of one (Cloudflare Worker + Supabase/Lovable app), talking over a network
  boundary that doesn't exist today — new auth-between-services problem (the Lovable app needs to
  authenticate its calls to the Worker on behalf of a logged-in user).
- The public `/book/:id` / `/meet/:id` flows would most naturally *stay* server-rendered on the Worker
  (they're unauthenticated by design, not "logged-in user of the SaaS"), so the product ends up with two
  different UI stacks for two different audiences (paying dashboard users → Lovable; invited third
  parties → existing Hono views). Not necessarily wrong, but worth being deliberate about rather than
  drifting into it.
- CAL's Hono/D1/KV app still needs the multi-tenant gate removed either way — that work doesn't disappear,
  it just happens on the Workers side instead of the Supabase side.

**Best fit if**: the goal is "monetize what already works, minimize rewrite risk" — this is the option that
best matches "full port, a CF backend, and other reasonable options" as a middle ground.

---

## Option C — Lovable/Supabase as the product shell, Workers as an internal sync service

A variant of B, one step further: the Lovable/Supabase app becomes the *only* thing the customer ever sees
or that other code calls directly — it owns users, billing, and even the D1-equivalent tenant data model in
Postgres — while the existing Worker is kept alive purely as an internal microservice that does one job:
run the Google Calendar sync engine and booking/poll logic against Google's APIs, invoked by the Supabase
side (e.g., a scheduled Edge Function calls the Worker's `/api/trigger-sync`-shaped endpoint, or the Worker
keeps its own Cron Trigger and just reads/writes to Supabase Postgres instead of D1).

**Gains**: single source of truth for tenant/billing data (Postgres), but the Worker keeps doing the one
thing it's already tuned for (subrequest-limited sync against Google, on Cloudflare's edge, on its own
Cron Trigger) without re-deriving those limits against a different platform.

**Costs**:
- Most architecturally complex of the four — two platforms, a cross-platform data model (Worker writes to
  Supabase Postgres instead of D1), and a real integration boundary to design and secure.
- Only makes sense if the team is comfortable operating two platforms long-term; if the eventual goal is
  "off Cloudflare," this option delays that rather than achieving it.

**Best fit if**: monetization needs to ship fast (reuse the proven sync engine unchanged) *and* there's an
appetite for a slightly more complex two-platform architecture as a deliberate, permanent shape — not just
a stepping stone.

---

## Option D — Stay entirely on Cloudflare; add Stripe + multi-tenant signup directly

No Lovable involved. Add a `stripe` dependency (or Stripe's HTTP API via `fetch`, matching this codebase's
existing no-SDK style for Google/Resend), a `subscriptions`/`plan` D1 table, a real signup flow, and relax
the `PRIMARY_ACCOUNT_EMAIL` gate to "any user with an active subscription." Frontend stays server-rendered
Hono JSX, or gets a light client-side layer added later if needed.

**Gains**: lowest total effort of any option — no new platform, no network boundary between "product" and
"sync engine," reuses everything already proven (crypto, sync engine, booking security review, CI/CD via
Workers Builds already set up per `TODO.md`). Cloudflare has no first-party Stripe integration the way
Lovable does, but Stripe's own API/webhooks work fine called from a Worker via `fetch`, same pattern as
Resend today.

**Costs**: doesn't touch the frontend at all — if a goal here (separate from monetization) is a nicer
customer-facing UI or Lovable's AI-driven editing workflow, Option D doesn't deliver that. Loses whatever
motivated looking at Lovable in the first place, if there's more to it than monetization.

**Best fit if**: monetization is the *only* goal right now and the earlier "why Lovable at all" question
(asked before this doc) resolves toward "mainly wanted an easier way to iterate the dashboard UI" rather
than "want off Cloudflare" — in which case Option D ships fastest, and a Lovable-built frontend (Option B)
can still be layered on later without having been blocked on it now.

---

## Recommendation (tentative — pending your answers below)

Option B, with Option D as the fallback if minimizing new moving parts outweighs wanting Lovable's frontend
workflow. Option A carries the most rewrite risk for the least monetization-specific benefit — the security-
sensitive parts (token custody, public booking flows) don't get easier on Supabase, they just get rebuilt.
Option C is compelling only if a permanent two-platform architecture is actually wanted, not just tolerated.

## Open questions before going further
1. **Pricing/plan shape**: flat subscription, per-connected-account, usage-based (e.g. per sync), or
   something else? Affects the billing data model regardless of which option is chosen.
2. **Who are paying customers relative to today's single owner?** Does the primary/secondary
   role model (one main calendar + N secondaries) map cleanly to "one paying customer," or do you want
   e.g. teams/orgs sharing a subscription?
3. **How much do you want off Cloudflare, independent of monetization?** This was asked before but not yet
   answered, and it's the main thing separating A/C from B/D.
4. **Timeline pressure** — is there a reason to ship monetization fast (favors D), or is this a longer-term
   rearchitecture where getting the UI/platform right matters more than speed (opens up A/C)?
5. Want me to build a throwaway prototype of any one option's riskiest unknown first — e.g. actually test
   Supabase's `pg_cron`/Edge Function limits against CAL's real sync workload shape, before committing to
   A or C? That's the one open question in `notes.md` I can't resolve by reading docs alone.
