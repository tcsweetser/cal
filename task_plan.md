# Task Plan: CAL — Calendar Replication & Anti-Double-Booking System (Implementation)

## Goal
Implement the Cloudflare Worker described in `plan.md` / `claude_code_prompt.md`: TypeScript + Hono + D1 + KV + Cron, with the audited sync topology (origin-tracking loop guard, transparency-flip-as-removal), ending in a working `wrangler dev` instance with type-checked, buildable code.

## Spec status (source of truth)
- `plan.md` — detailed architecture, schema, sync-engine algorithm. Audited and patched: P0 topology bug fixed, update/transparency-flip propagation added, `accounts.role` collapsed to a finalized 2-role + tag model, and a duplicate-delivery bug in the loop guard (found while finalizing that model) fixed.
- `claude_code_prompt.md` — original build prompt, fully synced to `plan.md` as of this session (roles/tags, topology, loop-prevention mechanism, dashboard copy).
- Both files agree on: **role model** — `primary` (exactly one) / `secondary` (at least one, each with a required `tag` ∈ `business`/`side_hustle`/`personal`, label-only, no sync effect); **topology** — single-hop fan-out only (secondary→primary, primary→every secondary, secondary→every other secondary); **loop guard** — blanket-skip any event carrying `syncEngine` metadata as a relay source (not a per-target origin comparison — that version caused duplicate delivery once every secondary became a sync source, see `plan.md` §2 for the trace); **origin metadata** (`originAccountId`/`originEventId`) still written and preserved across `PATCH`, now for provenance/deletion-cascade rather than loop prevention; **transparency-flip = removal**.

## Pre-Phase-1 blockers (must resolve before touching code)
- [x] **Stray secret-shaped files**: resolved — user decided to keep `gemini-code-*` as reference-only, not delete. Added `.gitignore` with `gemini-code-*` pattern so they never enter git history even once `git init` happens.
- [x] **`accounts.role` ambiguity** (P1 #3 from audit): resolved — collapsed to 2 roles (`primary`/`secondary`) with a required `tag` column on secondary accounts (`business`/`side_hustle`/`personal`, single tag per account, label-only). `migrations/0001_initial_schema.sql` draft in `plan.md` §4 already reflects this (`role` CHECK 2 values, new `tag` CHECK 3 values, composite CHECK enforcing tag presence tied to role). "At least one secondary account" and "exactly one primary account" are noted as application-level invariants, not expressible as a single-row `CHECK`.

## Phases (mirrors plan.md §7, with concrete file targets + verification per phase)

- [x] **Phase 1: Project Skeleton & Config** — done
  - Files created: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `.env.example`, `src/types.ts` (Env interface), `src/index.ts` (minimal Hono fetch handler + scheduled stub, needed for the build to actually run — full logic is Phase 4). `.gitignore` extended with `node_modules/`, `.wrangler/`, `.dev.vars`, `dist/`, generated `worker-configuration.d.ts`.
  - Deviated from the original dependency plan: `wrangler types` (not `@cloudflare/workers-types`) is now Cloudflare's recommended source of runtime types — swapped mid-phase after `wrangler types` itself flagged the older package as superseded. Added `@types/node` since `nodejs_compat` is set.
  - Verified for real, not just statically: `tsc --noEmit` clean, `wrangler deploy --dry-run` succeeds (shows both bindings), and `wrangler dev` actually boots and serves `GET /` → `200 {"name":"cf-cal-replication","status":"skeleton"}`.
  - Not committed to git yet — pending user go-ahead.

- [ ] **Phase 2: Database Migration**
  - Unblocked — role/tag model finalized above.
  - Files: `migrations/0001_initial_schema.sql` (users, accounts [2-role + tag], sync_tokens, event_mappings, sync_logs — per plan.md §4, with FK cascade fix noted in audit P2 #1, still open)
  - Verify: `wrangler d1 migrations apply DB --local` applies cleanly; spot-check schema with `wrangler d1 execute DB --local --command ".schema"`; confirm the composite `CHECK` rejects a `primary` row with a non-null `tag` and a `secondary` row with a null `tag`.

- [ ] **Phase 3: Auth & Token Manager**
  - Files: `src/types.ts` (extend Env), `src/services/tokenManager.ts`, `src/routes/auth.ts` (PKCE login/callback/connect), `src/middleware/auth.ts` (Primary-only session guard)
  - Must resolve audit gaps: token encryption mechanism (dedicated secret, not reused `SESSION_SECRET`), PKCE `state`/`code_verifier` storage location.
  - Verify: `npx tsc --noEmit`; manual OAuth round-trip against a real Google test project once deployed to `wrangler dev`.

- [ ] **Phase 4: Sync Engine & Cron Handler**
  - Files: `src/services/syncEngine.ts`, `src/index.ts` (`scheduled` + `fetch` entrypoints)
  - Implements the finalized algorithm exactly (plan.md §5.3): per-source delta fetch → blanket replica-skip filter (not per-target) → transparency-flip/cancellation routed to removal → role-based fan-out (secondary→primary, primary→every secondary, secondary→every other secondary) → origin-preserving PATCH/POST → `nextSyncToken` persistence.
  - Must resolve audit gap: concurrency guard using `sync_logs.status = 'in_progress'` before cron/manual trigger overlap.
  - Verify: `npx tsc --noEmit`; unit-style dry run against a mocked Calendar API response covering: create fans out to all correct targets, update (origin preserved across PATCH), cancel/transparency-flip deletes *all* mapped replicas (not just one), and a replica is never itself picked up as a relay source (regression test for the duplicate-delivery bug caught this session).

- [ ] **Phase 5: Dashboard UI & AI Assistant Placeholder**
  - Files: `src/routes/dashboard.ts`, `src/routes/api.ts`, `src/views/{layout,dashboard,mappings,logs}.tsx`, `src/services/aiAssistantService.ts` (interface stub only)
  - Verify: `npx tsc --noEmit`; `wrangler dev` — manually load `/dashboard`, `/dashboard/mappings`, `/dashboard/logs`, trigger `/api/trigger-sync`.

- [ ] **Phase 6: Verification & Documentation**
  - Files: `README.md` (Google Cloud Console OAuth setup, KV/D1 provisioning, `wrangler secret put` instructions)
  - Verify: fresh-clone smoke test — follow README from scratch in a clean directory (or at least dry-run the documented commands).

## Decisions Made
- Roles finalized as 2-value (`primary`/`secondary`) + required `tag` on secondary accounts (`business`/`side_hustle`/`personal`), single tag per account, label-only (user decision, this session).
- Topology finalized as single-hop fan-out (secondary→primary, primary→every secondary, secondary→every other secondary) — no multi-hop relay needed under the 2-role model.
- Loop guard reverted from per-target origin-comparison back to blanket-skip-of-replicas — the per-target version was correct for the earlier 3-tier hub topology but caused duplicate event delivery under the finalized full-mesh topology (every secondary is always a source). Origin metadata (`originAccountId`/`originEventId`) is retained for provenance and the deletion cascade, not for loop prevention.
- Stray `gemini-code-*` files kept as reference, excluded via `.gitignore` rather than deleted.
- Implementation plan follows `plan.md` §7 phase order unchanged; this file adds concrete file targets and a verification command per phase.

## Errors Encountered
- **Self-caught, this session**: the per-target origin-comparison loop guard (designed to fix the original P0 bug) silently reintroduced a *different* correctness bug — duplicate event delivery — once the role model was generalized to "every secondary is always a sync source." Caught during a deliberate re-trace before any code was written; no implementation impact, but flagging per the pattern: every change to the loop-prevention mechanism needs a full re-trace against the current topology, not just the specific case it was designed to fix.

## Status
**Phase 1 done, Phase 2 next.** Skeleton worker builds, type-checks, dry-run deploys, and boots under `wrangler dev` with a real HTTP response. Repo is on GitHub (`git@github.com:tcsweetser/cal.git`) with a PolyForm Noncommercial license. Phase 1's files are on disk but not yet committed — awaiting go-ahead. Phase 2 (D1 migration) is unblocked and next.
