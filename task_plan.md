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
  - Deviated from the original dependency plan: `wrangler types` (not `@cloudflare/workers-types`) is now Cloudflare's recommended source of runtime types — swapped mid-phase after `wrangler types` itself flagged the older package as superseded. Initially added `@types/node` per that same prompt, then **removed it during the Phase 2 recheck** — an independent review found it silently shadowed Workers globals (`setTimeout` typechecked as returning `NodeJS.Timeout` instead of `number`) despite being unused in `src/`. Replaced with `"types": []` in `tsconfig.json` so only the generated `worker-configuration.d.ts` supplies ambient globals; revisit only if a specific `node:*` import is actually needed later.
  - Verified for real, not just statically: `tsc --noEmit` clean, `wrangler deploy --dry-run` succeeds (shows both bindings), and `wrangler dev` actually boots and serves `GET /` → `200 {"name":"cf-cal-replication","status":"skeleton"}`.
  - Committed (`420609a`) and pushed.

- [x] **Phase 2: Database Migration** — done, then independently rechecked (code-reviewer agent) and patched again
  - First pass: 5 tables (`users`, `accounts` [2-role + tag], `sync_tokens`, `event_mappings`, `sync_logs`), audit P2 #1 FK-cascade fix, one `UNIQUE` index on `event_mappings(source_account_id, source_event_id, target_account_id)`. Verified against real local D1: constraints, FK enforcement, cascade delete all behaved correctly.
  - **Recheck (independent code-reviewer pass) found real defects the first pass missed**, all fixed and re-verified against a reset local D1 instance:
    - **Critical**: `.gitignore` covered `.dev.vars` but not `.env`/`.env.*` — the shipped `.env.example` makes `cp .env.example .env` the natural move, and wrangler actually reads `.env` for local dev, so this was a real path to committing secrets even though nothing had leaked yet. Fixed.
    - **Duplicate-delivery bug in the schema** (same class as the topology bug caught earlier, this time at the data layer): nothing stopped two source events from claiming the same `(target_account_id, target_event_id)`. Fixed with a second `UNIQUE` index + `CHECK(source_account_id <> target_account_id)`. Verified: self-mapping rejected, duplicate-target-ownership rejected, legitimate fan-out (same source → different targets) still allowed.
    - **Every FK child column except `accounts.user_id` was unindexed** — confirmed via `EXPLAIN QUERY PLAN` that cascades and the logs-page query were full table scans. Added indexes on `event_mappings(user_id)`, `sync_tokens(account_id)`, `sync_logs(user_id, created_at DESC)`; re-ran `EXPLAIN QUERY PLAN` and confirmed every one now shows `SEARCH ... USING INDEX`, zero scans.
    - **`accounts.email` had no uniqueness constraint** — same Google account could link twice to one user, which under the full-mesh topology means real duplicate delivery to one calendar. Fixed with `UNIQUE(user_id, email COLLATE NOCASE)`; verified a case-different duplicate is rejected.
    - **`accounts.status` had no value domain** despite being filtered on by the sync engine spec. Added `CHECK(status IN ('active','revoked','error'))`; verified.
    - **`TEXT PRIMARY KEY` accepted `NULL`** (SQLite quirk) and `DEFAULT`-having columns accepted explicit `NULL`. Added `NOT NULL` throughout; verified both rejections.
    - **Timestamps were space-separated, not RFC3339** — would silently miscompare against Google Calendar's own RFC3339 timestamps. Switched to `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; verified output format.
    - **`updated_at` never refreshed on `UPDATE`** despite §5.3 step 6 rewriting `sync_tokens` every cron run. Added `AFTER UPDATE` triggers on `event_mappings`/`sync_tokens` rather than trusting every future call site to set it by hand; verified a real `UPDATE` moves `updated_at` while `created_at` stays fixed.
  - `src/types.ts` also fixed in the same pass: `Env` was hand-duplicating `DB`/`TOKEN_STORE` instead of extending the generated `Cloudflare.Env`, so it could silently drift from `wrangler.jsonc`. Now `export interface Env extends Cloudflare.Env { ...secrets }`; compiles clean.
  - `wrangler.jsonc` `compatibility_date` was set to "today," which was *ahead* of the installed `workerd` build (confirmed via the build date in `worker-configuration.d.ts`'s header) — local dev couldn't have implemented behavior gated to a date past its own build. Pinned to the actual build date instead. `plan.md` §5.1's stale example date and §8's stale command references (`npm run check`, `wrangler dry-run`) fixed to match reality.
  - Re-verified everything after all fixes: `tsc --noEmit` clean, `wrangler deploy --dry-run` clean, migration re-applied to a reset local D1 (14 statements), full constraint/index/trigger/cascade test suite re-run and passing.
  - `plan.md` §4 updated to match the final as-built schema, with the recheck findings documented inline.
  - Not committed to git yet — pending user go-ahead.

- [ ] **Phase 3: Auth & Token Manager**
  - Files: `src/types.ts` (extend Env — already restructured to `extends Cloudflare.Env`, ready), `src/services/tokenManager.ts`, `src/routes/auth.ts` (PKCE login/callback/connect), `src/middleware/auth.ts` (Primary-only session guard)
  - Must resolve audit gaps: token encryption mechanism (dedicated secret, not reused `SESSION_SECRET`), PKCE `state`/`code_verifier` storage location.
  - **New from the Phase 2 recheck — design risk, not yet a bug (nothing writes tokens yet)**: KV is eventually consistent (up to ~60s global propagation) and rate-limited to ~1 write/s per key. If the cron sync and a dashboard-triggered token refresh both fire for the same account, and Google has refresh-token rotation on, the loser overwrites a fresh refresh token with a stale one and the account silently de-auths. Consider D1 with a conditional update, or a Durable Object as a refresh mutex, instead of writing tokens straight to KV — decide before writing `tokenManager.ts`, since it's cheap now and expensive to retrofit.
  - Verify: `npx tsc --noEmit`; manual OAuth round-trip against a real Google test project once deployed to `wrangler dev`.

- [ ] **Phase 4: Sync Engine & Cron Handler**
  - Files: `src/services/syncEngine.ts`, `src/index.ts` (`scheduled` + `fetch` entrypoints)
  - Implements the finalized algorithm exactly (plan.md §5.3): per-source delta fetch → blanket replica-skip filter (not per-target) → transparency-flip/cancellation routed to removal → role-based fan-out (secondary→primary, primary→every secondary, secondary→every other secondary) → origin-preserving PATCH/POST → `nextSyncToken` persistence.
  - Must resolve audit gap: concurrency guard using `sync_logs.status = 'in_progress'` before cron/manual trigger overlap.
  - **New from the Phase 2 recheck**: add test tooling (`vitest` + `@cloudflare/vitest-pool-workers`) *before* writing the sync engine, not after — this is the part of the system that can silently corrupt real calendars, and the topology fan-out table / loop guard / transparency-flip-as-deletion / 410-Gone recovery are all pure logic that's cheap to unit test against a real D1 fixture (the migration applies directly) and expensive to debug against live Google data.
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
- **Caught by an independent recheck, not self-caught**: my own Phase 1+2 verification (manual constraint tests, dry-run, real `wrangler dev` boot) all passed, but missed 9 real issues — including the exact same class of duplicate-delivery bug as above, this time in the DB schema instead of the sync algorithm — that a fresh code-reviewer pass with no prior context found. Pattern: my own verification tends to test the specific cases I was already worried about; an independent pass tests things I wasn't looking for. Worth doing a fresh-eyes recheck after each phase that touches correctness-critical logic, not just at the end.

## Known follow-ups (not blocking, not forgotten)
- `sync_logs` has an index now but no retention policy — grows unbounded (≥6 rows/hour/user at the 10-minute cron interval). Add a periodic cleanup when the cron handler exists (Phase 4), or accept it and monitor D1 size.
- `tsconfig.json` now sets `"types": []` (see Phase 1 entry) — fine while `src/` uses no Node builtins; if a later phase needs a specific `node:*` import under `nodejs_compat`, revisit rather than blanket-reinstalling `@types/node`.
- No linter/formatter configured yet. Fine at this size; worth adding (Biome or ESLint+Prettier) before the codebase or contributor count grows.

## Status
**Phase 2 done and independently rechecked, Phase 3 next.** Phase 1 committed and pushed (`420609a`). Phase 2's migration — plus 9 fixes found by an independent code-reviewer pass (1 critical: secrets-gitignore gap; the rest correctness/performance in the schema and `src/types.ts`) — is re-verified against a reset local D1 instance and on disk, not yet committed. Phase 3 (Auth & Token Manager) is next: needs the token-encryption-mechanism, PKCE-state-storage, *and* newly-flagged KV-concurrency decisions before writing `tokenManager.ts`/`routes/auth.ts`.
