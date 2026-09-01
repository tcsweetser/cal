# Notes: CAL architecture inventory (for porting-options analysis)

## Current stack (as of 2026-09-01, commit 479bacd)
- Cloudflare Workers, Hono router, server-rendered JSX views (no client-side framework/build step).
- **D1** (SQLite): `users`, `accounts`, `sync_tokens`, `pending_sync_tokens`, `event_mappings`, `sync_queue`,
  `tracked_recurring_series`, `sync_logs`, `trusted_invites`, `email_verifications`, `scheduling_settings`,
  `meeting_polls`, `meeting_poll_slots`, `meeting_poll_votes` (8 migrations, all additive).
- **KV** (`TOKEN_STORE`): encrypted OAuth token blobs, keyed per account; also doubles as the gate for the
  once-a-day recurring-series audit (`DAILY_AUDIT_KV_KEY`, see index.ts).
- **Cron Trigger**: `*/10 * * * *` — runs `runFullSync` for every user, then (at most once/day, KV-gated)
  `runDailyRecurringAudit`. Cloudflare accounts have a small fixed budget of Cron Triggers, which is why the
  daily audit piggybacks on the 10-min tick instead of getting its own.
- **Encryption**: Web Crypto AES-256-GCM for OAuth tokens at rest (`lib/crypto.ts`), HMAC-signed short-lived
  cookies for the OAuth PKCE flow state, SHA-256 for email-verification-code hashing. All hand-rolled on top
  of the platform's native Web Crypto — no external crypto library.
- **Email**: Resend, plain HTTP API via `fetch` (`lib/emailService.ts`) — no SDK dependency.
- **Google integration**: OAuth2 + PKCE (`routes/auth.ts`), Calendar API sync engine (`services/syncEngine.ts`,
  `services/googleCalendar.ts`), free/busy lookups for the booking flows.
- **AI assistant service**: `services/aiAssistantService.ts` is an *interface stub only* — conflict detection /
  decline-response generation are typed but never implemented or wired to any model.
- Dependencies: just `hono` (runtime) + `wrangler`/`typescript`/`vitest` (dev). No React, no build step, no ORM.

## Critical finding: hard single-tenant gate
`routes/auth.ts::handleLoginCallback` rejects any login where
`email !== c.env.PRIMARY_ACCOUNT_EMAIL.toLowerCase()` (403 "This dashboard is restricted to the primary
account owner."). Despite the DB schema technically supporting multiple `users` rows (accounts, sync state,
etc. are all scoped by `user_id`), **the app is hard-wired at the route layer to exactly one owner**, set via
a single env var. There is currently no self-serve signup path at all.

**This is the single biggest fact shaping the monetization-driven options below**: turning this into a
multi-customer product means replacing that one `if` with real multi-tenant signup/onboarding — not a small
tweak, but also not a rewrite; the schema already has the right shape (`user_id` scoping everywhere) to carry it.

## Confirmed: zero existing billing/monetization/multi-tenancy code
`grep -rniE "stripe|billing|subscription|payment|plan_tier|monetiz"` across `src/` and `migrations/` — no hits.
Whichever option is chosen, billing is being built from scratch either way; it's not a wash between options.

## Public/unauthenticated surface (relevant to any rearchitecture)
- `/book/:id` and `/meet/:id` are deliberately **HTML-only, no JSON API surface** — a third party can book time
  or vote availability without a login, verified via a one-time emailed code. This constraint was a deliberate
  security decision (see `db/schema.ts` comments referencing a post-commit security review that found and
  fixed 6 issues, e.g. verified-invite-as-permanent-bearer-credential). Any rearchitecture that exposes a
  generic REST/GraphQL API surface needs to either preserve this HTML-only constraint for these two flows or
  consciously re-derive the same protections (rate limits, one-time-code binding, expiry) on top of a JSON API.

## Lovable / Supabase capability notes (from Lovable's own MCP server instructions — not independently verified
hands-on yet; treat as "should be true, confirm before committing architecture")
- Stack: React + Tailwind + shadcn/ui frontend; Supabase backend (Postgres, Auth, Storage, Edge Functions).
- Native integration catalog (per Lovable's docs, linked from its MCP server instructions) explicitly includes
  **Stripe** (payments) and **Resend** (email) — CAL already uses Resend, so email porting should be closer to
  a config change than a rewrite.
- Supabase supports scheduled jobs via `pg_cron` (Postgres-side) and scheduled Edge Function invocations —
  functionally comparable to CF Cron Triggers, but the exact reliability/limits envelope (concurrency, timeout,
  retry semantics) hasn't been checked against CAL's actual sync-engine needs (10-min tick across N users,
  each doing several Google API calls) — **flagged as an open question, not assumed safe**.
- No CF-KV equivalent as a first-class primitive; a KV-shaped need (like the daily-audit gate) would become a
  Postgres row/table on Supabase — mechanically fine, just a different shape than today's code.
- Supabase Auth would replace the hand-rolled session/cookie code in `middleware/auth.ts` + `routes/auth.ts`,
  but CAL's need is unusual: it's not "log in with Google," it's "OAuth into N *different* Google accounts and
  keep long-lived refresh tokens for each, per user" — Supabase Auth's social-login is built for the former
  (one identity per user), not the latter (arbitrary account-linking with token custody). This part likely
  stays custom either way, on either backend.

## Cost at scale (researched 2026-09-02, primary sources — see sources list at end)

User flagged this as an explicit open question ("Lovable vs Cloudflare is the big question here as well, at
scale, neither is free"). Real numbers, pulled from each platform's own pricing page, not third-party blogs:

**Cloudflare Workers Paid** — $5/mo flat minimum, and that one fee covers Workers requests, D1, and KV
together (no separate services to add up):
- 10M requests/mo included (+$0.30/M after), 30M CPU-ms/mo included (+$0.02/M after) — CPU-ms only counts
  actual compute, not time spent waiting on `fetch` (relevant to CAL: most of the sync engine's time is
  waiting on Google's API, not computing).
- D1: 5 GB storage included (+$0.75/GB-mo), 25 **billion** rows read/mo included (+$0.001/M), 50M rows
  written/mo included (+$1.00/M).
- KV: 1 GB storage included (+$0.50/GB-mo), 10M reads/mo included (+$0.50/M), 1M writes/mo included (+$5/M).
- Cron Triggers get up to 15 min CPU time per invocation (vs. 5 min for a normal request) — comfortably
  covers a 10-min sync tick.
- **At CAL's actual current scale (5 accounts, one owner) this is comfortably inside the free tier already**;
  even at hundreds of paying users the included D1/KV volumes are large relative to what a calendar-sync
  workload needs per user. The $5/mo minimum is the effective price floor from day one, not day-N.

**Supabase** (what a full-port or hybrid option would run on): $0 Free / **$25/mo Pro** / $599/mo Team /
custom Enterprise — a materially higher price floor than Cloudflare's, and it's **per project**, not per
account:
- Free: 500 MB DB, 500K Edge Function invocations/mo, 50K MAU — no compute credit (shared CPU), realistically
  a dev/demo tier only.
- Pro ($25/mo): 8 GB DB included (+$0.125/GB), 2M Edge Function invocations/mo included (+$2/M), 100K MAU
  included (+$0.00325/MAU), $10/mo compute credit (covers one Micro compute instance — anything more is
  extra). A 10-min-tick scheduled job invoked via Edge Function is ~4,320 invocations/mo per job — trivial
  against the 2M included, so invocation *volume* isn't the constraint; the compute credit / instance size is
  more likely to be, depending on how much work each sync tick does. Not independently load-tested yet (see
  Phase 7 below).

**Lovable itself is a third, separate cost axis from Supabase runtime hosting** — easy to conflate, so
worth stating plainly: Lovable Free/$25 Pro/$50 Business/custom Enterprise plans are **credits that pay for
Lovable's AI editor doing build/iteration work**, not for running the app in production. Two distinct paths
for where the app then actually runs:
- **"Lovable Cloud"** — a Supabase backend Lovable manages for you automatically, no separate Supabase
  account needed. Convenient, but its production *runtime* usage-based pricing (as opposed to the flat
  monthly credit allowance for *building*) isn't confirmed from primary sources yet — flagged as an open
  question, not assumed free or bundled.
- **"Connect your own Supabase project"** — full control, but now genuinely two separate bills: Lovable's
  subscription (build/iteration) *plus* Supabase's own Pro-tier-and-up bill (runtime hosting) as outlined
  above.

**Headline comparison**: Cloudflare's cost floor is $5/mo flat and stays flat-ish well past CAL's current
scale given the included volumes above. Any Lovable-based option's realistic cost floor for a real production
app is closer to **Lovable's own plan ($0-50/mo, for building) + Supabase Pro ($25/mo+, for running it)** —
i.e., structurally two bills instead of one, and a materially higher combined floor than staying on
Cloudflare, even before either platform's usage-based overages are considered. This doesn't settle the
architecture question (Option B/C keep the Cloudflare-side cost floor for the parts that stay on Workers
regardless), but it's a real, sourced data point for the "at scale, neither is free" question.

**Sources**:
- https://developers.cloudflare.com/workers/platform/pricing/
- https://supabase.com/pricing
- https://docs.lovable.dev/integrations/supabase (Lovable Cloud vs. self-managed Supabase)
- Lovable's own $0/$25/$50/custom plan tiers: multiple third-party trackers cross-checked (lowcode.agency,
  softr.io, eesel.ai) as of Sept 2026 — **not yet cross-checked against lovable.dev's own pricing page
  directly**, flagged as slightly less certain than the Cloudflare/Supabase numbers above, which came from
  the platforms' own docs.
