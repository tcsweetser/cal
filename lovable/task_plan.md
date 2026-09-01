# Task Plan: CAL → Lovable Porting Options

## Goal
Produce a well-founded options doc comparing ways to bring CAL (Cloudflare Workers calendar-sync app) into Lovable — full port, keep-CF-backend + Lovable frontend, and any other reasonable middle ground — so the user can pick a direction. No existing repo files are touched; everything lives under `./lovable/`.

## Constraints (from user)
- Do NOT modify any file outside `./lovable/`.
- Options only for now — no implementation/build-out until a direction is chosen.
- Be iterative — come back with questions as they surface, don't guess silently on load-bearing unknowns.

## Phases
- [x] Phase 1: Set up planning files
- [x] Phase 2: Inventory CAL's current architecture (routes, DB schema, cron/background work, external integrations, anything Workers-specific) → notes.md
- [x] Phase 3: Inventory Lovable/Supabase capabilities relevant to CAL's needs (cron, edge functions, auth, secrets/encryption, DB) → notes.md (from Lovable's own MCP instructions; flagged as not independently hands-on-verified yet)
- [x] Phase 4: Draft options doc with tradeoffs (options.md) — 4 options (A full port, B CF backend + Lovable frontend/billing, C Lovable shell + Worker as internal sync service, D stay on CF entirely) + tentative recommendation (B, fallback D)
- [x] Phase 5: Surface open questions to user, revise per feedback — answers received 2026-09-02, logged above
- [x] Phase 6: Research real Cloudflare Workers vs. Supabase/Lovable pricing at scale → notes.md "Cost at
      scale" section, sourced from developers.cloudflare.com and supabase.com directly; Lovable's own $/mo
      tiers cross-checked via third-party trackers only (not yet confirmed against lovable.dev's own page)
- [~] Phase 7: **PAUSED at user's request (2026-09-02), before any Lovable project was created — no credits
      spent.** Full test plan, preconditions, and step-by-step instructions for whichever session picks this
      back up are written to `testing.md`. Do not start Phase 7 without re-reading `testing.md` first.
- [ ] Phase 8: Revise options.md recommendation using real cost data + prototype findings

## Key Questions (to resolve before/while drafting)
1. What's actually motivating the port — easier frontend iteration, moving off Cloudflare, something else? (asked already, not yet fully answered — see decision below, still open)
2. Does Lovable/Supabase support scheduled background jobs comparable to CF Cron Triggers (10-min sync tick + daily audit)? Not verified hands-on — flagged as an open question in options.md, not assumed.
3. How would encrypted OAuth token storage (currently custom, Workers-side) map onto Supabase (Vault? pgcrypto? edge function env?). Relevant mainly to Options A/C.
4. Public unauthenticated booking routes (`/book/:id`, `/meet/:id`) — HTML-only, no JSON API surface, by design. Does that constraint carry into a Lovable/React+Supabase app or does it relax? Covered in options.md per-option.
5. (new, from user mid-Phase-2) Pricing/plan shape, who counts as "a paying customer" relative to the primary/secondary account model, timeline pressure — all posed back to user in options.md.

## Decisions Made
- **Key goal is monetization** (user, mid-Phase-2). Changed the framing of the whole options doc: found via
  code inspection that CAL currently has zero billing/multi-tenancy code and is hard-gated to exactly one
  owner (`PRIMARY_ACCOUNT_EMAIL` check in `routes/auth.ts`) — so "add monetization" always means building
  real multi-tenant signup + billing, on any stack. See notes.md's "Critical finding" section.
- **Answers to options.md's 5 questions (user, 2026-09-02)**:
  1. Pricing TBA but a **~USD 5/month flat base rate is the likely shape** — plan the billing model around a
     simple flat subscription first, not usage-based, unless that changes.
  2. Enterprise/org billing: **TBA, develop when real customers ask for it** — don't overbuild multi-tenancy
     beyond "one paying user" for now; keep the data model extensible, not front-load org/team billing.
  3. **Lovable vs. Cloudflare cost-at-scale is now an explicit open question the user wants answered**, not
     just an architecture-risk question — "neither is free" at scale. Needs real pricing research, not
     assumption.
  4. **No timeline pressure to ship fast — "testing and more testing," parallel development explicitly on the
     table.** This reframes Option D (fastest) as no longer favored by default; there's room for A/B/C to be
     explored properly, potentially more than one in parallel.
  5. **Yes — explicitly derisk Lovable hands-on.** "Lovable is an unknown risk right now, exploring lovable is
     part of this process." This means actually building something small in Lovable (using the now-authenticated
     MCP connection), not just reading docs, to test the cron/edge-function question from notes.md.
- **Given point 4, the "tentative recommendation: B, fallback D" from the first options.md pass is no longer
  well-supported** — that recommendation was weighted toward minimizing effort/risk under an assumed
  time-pressure that the user has now explicitly said doesn't apply. Revisit the recommendation once cost data
  and a real Lovable prototype exist.

## Errors Encountered
(none yet)

## Status
**PAUSED (2026-09-02).** Cost research (Phase 6) is done and written up in `notes.md`. Phase 7 (hands-on
Lovable prototype) is fully scoped in `testing.md` but not started — user asked to pin it here. **Next
session: read `testing.md` first**, it has everything needed to resume (preconditions, exact MCP tool calls,
step-by-step plan, success criteria) without re-deriving context from this conversation.
