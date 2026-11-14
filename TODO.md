# TODO

Triaged 2026-11-10. P0: handle now. P1: next. P2: can wait. Details for the queue and resource items are in `task_plan.md` under "D1 incident follow-up bundle (2026-11-10)".

## P0

- [x] Confirm the D1 fix in production. On or after 2026-11-11 01:00 UTC, `npx wrangler d1 info cal-replication-db -c wrangler.local.jsonc` should show `rows_read_24h` in the low thousands (it was 3,634,237). The 5M/day limit is account-wide, so HIT Pacific's production database shares it.
  - **Passed, read 2026-11-14 04:51 UTC** (wrangler 4.120.1; the 24 h window is wholly after the fix): `rows_read_24h` 8,762, `read_queries_24h` 8,472, `rows_written_24h` 4,518. That is 0.18% of the 5M rows/day Free limit, down from 73% (about 415 times lower). It is above "low thousands", but rows read per query is about 1.0, so no query scans a table, and 8,472 queries over 144 ticks is about 59 per tick. HIT Pacific's production database is on the same account and shares the allowance.
  - The account has been on Workers Paid since 2026-11-11, where D1 includes 25B rows read per month and bills past that instead of failing. The per-tick reads still need to stay flat as the tables grow.

## P1

- [ ] Timed ↔ all-day change on a replica series or instance. Google's PATCH merges fields, so sending `{start: {date}}` to a timed replica (or `{dateTime}` to an all-day one) is probably rejected with a 400, and a 400 drops the queue item. The replica then stays at the old time, so the moved meeting shows free on that target. Fix: send the other field as `null`, as single events already do. Check the API behaviour with the spike script first. (Fable review, Minor 4.)
- [x] (Deployed 2026-11-10 as `be20da9`; all 5 accounts cut over by 09:30 UTC, legacy cleanup 0, no errors. Cutover steps are in `DEPLOYMENT.md`.) One-off events more than 42 days ahead are never replicated. The window filter drops them, the sync token advances, and only recurring series have the daily audit to pick them up later. Moving an event beyond the window has the same cause and leaves its replica at the old time. Known since August (`task_plan.md`, "pre-existing structural gap") but never tracked. Anything booked 6+ weeks ahead doesn't block the other calendars.
- [ ] Retry counter or per-target parking, plus an alert on repeated error runs. Today one persistently failing target (5xx, 401, 403, or no stored tokens) holds every source queue that replicates to it, and only the logs page shows it.
- [ ] Booking slot picker builds a new `Intl.DateTimeFormat` per candidate, up to 1,344 per request. Measured 35-75 ms in Node against the 10 ms Free CPU limit, so invitees may get error 1102. Fix: one formatter per time zone. Confirm in production observability first.
- [ ] Settle the D1 calls-per-invocation limit on Free: the D1 docs page says 50, the Workers page says 1,000. The code assumes 1,000; if 50 is enforced, large deltas and the drain loop are already at risk.

## P2

Sync correctness, rare paths:
- [ ] Deterministic client-supplied event ids, so a retried insert can't create a second replica. Check Google's id rules and deleted-id behaviour first.
- [ ] A failed re-fetch after a 410 loses reconciliation, and a 5xx on a reconciliation delete isn't retried.
- [ ] Track recurring series before enqueueing, so a failed tracking batch can't lose the series. Small reorder in `syncAccount`.
- [ ] Mass cancellations (a deleted long series) bypass `CallBudget` and can reach the D1 call cap, leaving the lock stuck for 15 minutes. Self-heals over later ticks.
- [ ] Changes made while a target was revoked aren't replayed when it reconnects.
- [ ] `CallBudget` doesn't count list pages, retries or token refreshes, so the 50-subrequest cap is reachable. Since the drain fix this stalls a run instead of losing events.

Series replication follow-ups (deferred in review, 2026-11-10). None can show a meeting as free except where stated. The worst case is doubled or stale busy:
- [ ] A failed single-replica delete (400 or revoked target) doesn't return `retryLater`, so the series insert or exception patch goes ahead and the target shows doubled busy until the item is reprocessed.
- [ ] A cancelled or free exception whose replica instance can't be found keeps any stale busy single on that target for good.
- [ ] With mixed mapped and unmapped targets and the series not queued, the exception is skipped silently (add a `console.warn`), and a free exception doesn't delete a stale single on the unmapped target.
- [ ] A still-confirmed exception next to a series converted to "does not repeat" replicates as an extra standalone busy single, until the source is deleted.
- [ ] A single still running at fetch time but ended by drain time skips `processSingleEvent`, so its replica isn't updated. Untested.
- [ ] After a series time change, each old exception's cancelled stub sends one cancel PATCH per target to a discarded instance id (K×T calls). Fix: when clearing exception rows, write the cancelled-stub fingerprint instead of deleting.
- [ ] `findInstanceByOriginalStart` reads one page of instances (250 within ±48 h), so it can miss only on series shorter than about 30 minutes apart.
- [ ] A series whose insert gets a 400 is dropped after one log line and has no replica. Search `sync_logs` for `failed: 400` now and then (0 since deploy).
- [ ] The 35-call budget and 60-item cap are per `runFullSync` (per user), not per DO invocation. Fine with one user; revisit before a second user can sign in.
- [ ] Steady state adds 3 primary-key reads of `series_cutover` and 2 indexed `listLegacyCleanup` queries per account per tick. Bounded; could be skipped once `completed_at` is set.
- [ ] Cutover and rollback paths, which only matter for a re-cutover or a rollback:
  - One persistent non-400 failure on a cleanup row stops cleanup for every account on every tick (`cutover.ts:92`). (Fable Minor 6.)
  - The cutover's full fetch has no reconciliation, so a source event deleted between the last old-mode sync and the first full fetch may keep a stale busy replica until the next 410. For this cutover the window was 08:20–09:30 UTC on 2026-11-10. (Fable Minor 7.)
  - A future-dated cleanup row with no series mapping is dropped as history. If that target later gets the replica series, the legacy future instances stay doubled. The code comment for these rows is inaccurate.
  - Re-running `markCutoverReset` leaves `completed_at` set.
  - Cleanup's 400 and revoked branches don't spend call budget. Rollback completion leaves `legacy_instance_cleanup` rows, rollback ticks write no `sync_logs` row, and the GET remaining count covers only the signed-in user.
- [ ] Missing tests:
  - `listLegacyCleanup` when the future half fills the limit, and when there are fewer rows than the limit.
  - A prefix-collision series id (`abcd_…` vs `abc`).
  - All-day exceptions at month and year end, and all-day exception bodies. The instance-lookup mock ignores `timeMin`/`timeMax`.
  - A revoked target or a 400 on series delete.
  - A budget cut between patches, and the budget running out right after a "gone" PATCH.
  - A PATCH that fails with 500 or another non-gone error: it should write no fingerprint and leave the exception rows.
  - A transparent exception on an unmapped series.
  - The loop guard on the target's delta after a replica series is deleted.
  - The series insert body's transparency, reminders and marker.
  - The cutover's third-tick fetch.
  - R22 with more than one account.
  - The second `prepareCutover` throwing.
- [ ] Tidy:
  - Split `src/services/syncEngine.ts` (447 lines), `test/seriesReplication.test.ts` (616) and `test/cutover.test.ts` (461).
  - Comment that all-day series rely on Google accepting a recurrence with no time zone (verified with the spike script).
  - Drop the `as string` on `originalStartKey`.
  - Remove the unused `_t` in a test and the unused `beforeEach` in `test/authReconnect.test.ts`.
  - Remove the double blank line in `syncEngine.ts` and wrap the `buildReplicaPayload` signature.
  - Check the moderate `npm audit` advisory for `hono` (it predates this work).

Resource use, none near a limit today:
- [ ] Sync-token churn: 5 rows written per account per tick even when nothing changed (82% of rows written, 3.6% of the daily limit).
- [ ] A failed KV write in `refreshTokens` discards the freshly issued token. Only matters if the account-wide 1,000 KV writes/day is reached.
- [ ] Email send caps are check-then-act, and invite/poll lists are uncapped (more than about 40 recipients exceeds the 50-subrequest cap partway).

Process:
- [ ] Dev branch + PR gate, so nothing reaches `master` (and therefore production) without review. Plan written up, nothing implemented yet: see `task_plan.md`'s "Phase 8 (planned, not started): dev branch workflow + PR gate". Scoped to git branch protection + a `dev` branch + a basic Actions CI check for now — a proper staging Cloudflare Worker/D1/KV and PR automation (preview URLs, etc.) are explicitly deferred to a later pass.

## Done

- [x] D1 rows_read incident (2026-11-10): `sync_logs` lock checks scanned the whole table on every tick, 3.6M rows/day against the 5M account-wide limit. Fixed with a partial index (migration 0009, `974c5cf`), then a follow-up bundle pushed as `bfd3407`: capped `Retry-After`, queue existence checks, batched recurring-series writes, and a queue drain that no longer drops events on transient failures.

- [x] Fix: all 4 secondary accounts silently going `revoked` in production — root-caused (not a code bug): Google caps refresh tokens at 7 days for OAuth apps in "Testing" publishing status with sensitive scopes, and `DEPLOYMENT.md` had wrongly said Testing status was fine indefinitely (now corrected). Fixed by adding a `/privacy` page (required by Google's Branding form; pushed separately, `8ab8f3e`) and publishing the OAuth app to "In production" via Google Cloud Console. A second bug surfaced during reconnect (connect flow 409'd on any existing row, even a revoked one, with no recovery path) — fixed and pushed (`60b5931`) with a regression test (`test/authReconnect.test.ts`). All 5 accounts (primary + 4 secondaries) confirmed `active` in production D1. Full writeup in `task_plan.md`'s "Production incident (2026-08-21)" section. **Fully resolved.**

- [x] UI redesign: integrate `docs/mockups/CAL_UI_Mockups.html` into the real Hono JSX views — Implemented (Phase 9 in `task_plan.md`): sidebar shell + centered public-card shell sharing one design-token system, real Google name/photo in the sidebar (new `profile` OAuth scope, `migrations/0008_user_profile.sql`), badge-tier fixes for all real status enums, booking's slot picker restyled to radio rows. 77/77 tests passing, `tsc`/`wrangler --dry-run` clean, smoke-tested via `wrangler dev` + curl (no browser extension available to visually confirm — recommend a manual click-through soon). Not committed yet.

- [x] Appointment dialog: allow a trusted party (authorized by the owner) to add appointments, secured via a one-time code (or similar mechanism). — Implemented (Phase 7.2 in `task_plan.md`): real availability via `freeBusy`, configurable duration/buffer/workday settings, in-person/remote with Google Meet. 48/48 tests passing, `tsc`/`wrangler --dry-run` clean. Committed locally (`d4235ff` and earlier), **not pushed yet**.
- [x] Multi-party meeting planner: coordinates availability across multiple parties to find a mutually agreed date/time; requires a one-time code that expires once the meeting has been held. — Implemented (Phase 7.3 in `task_plan.md`): propose slots, invite participants by email, live vote tally, finalize books the earliest fully-available *future* slot (remote/Meet included), link stays valid through the meeting's end time. A follow-up independent security review of the new public `/book`/`/meet` surface (this project's established pattern) found and fixed 6 real issues — most seriously, a verified invite link acted as a permanent bearer credential for anyone who later obtained the URL, with no proof of their own inbox control; see task_plan.md's "Post-implementation independent security review of Phase 7.3" section for the full list. All fixed, each with a regression test. Independently verified: `tsc`/`wrangler --dry-run` clean, 77/77 tests passing (up from 66). Committed locally (`d4235ff`), **not pushed yet**.
- [x] Full deployment guide (`DEPLOYMENT.md`) — added, covering fresh-clone to production walkthrough, Google Cloud Console OAuth setup (with a note on optionally using `claude-in-chrome` interactively, supervised, for that step), and a troubleshooting table. Linked from README.

What are the best options to deploy this upon commit/push?
Should be create a test/prod branch structure?
- Decided: Cloudflare Workers Builds (native Git integration), secret-env-var approach — matches your other Workers-with-bindings projects' shape (`wrangler deploy` on `master`, `wrangler versions upload` on other branches for previews) but keeps real D1/KV IDs out of git, since (unlike those projects) this repo is public.
- **Repo side is done**: `scripts/write-ci-wrangler-config.js` (new) assembles `wrangler.local.jsonc` from two secret build env vars at build time; `npm run ci:write-wrangler-config` runs it. Verified locally (`tsc`/`wrangler --dry-run` still clean after a round-trip through the script).
- **Repo is now connected** (you did this yourself in the dashboard). Two things still need fixing there before the first push will build successfully — deploy command and secret env vars — full cut-and-paste values are in `cf-workers-builds-setup.txt` (gitignored, real IDs, not tracked).
- Reminder, same as before: once the trigger is fixed, every push to `master` auto-deploys to production immediately — including the Phase 7.1-7.4 trusted-invite/meeting-poll work, committed locally (`d4235ff`) but not yet pushed.
- **Done, verified working (2026-08-17)**: pushed `master` (`1ef7c60`), first build failed (`D1_DATABASE_ID` secret missing on the trigger), second failed identically (secret had been added to the Worker's own **Settings → Variables & Secrets** instead of the **Builds → production trigger → Build variables and secrets** panel — two separate places in the dashboard), third succeeded. Full CI/CD pipeline (push → build → deploy) confirmed live.
  - **Gotcha hit during this deploy, worth remembering for any future var**: `CAL_FROM_ADDRESS` had drifted to being a plain dashboard `vars` entry instead of a real secret (`DEPLOYMENT.md` says `wrangler secret put`). `wrangler deploy` fully replaces the remote `vars` set with whatever `wrangler.jsonc` declares (nothing), so the CI deploy silently wiped it — real secrets (`RESEND_API_TOKEN` etc.) were untouched since `wrangler deploy` never manages those. Fixed by re-setting it via `wrangler secret put CAL_FROM_ADDRESS`. Lesson: any Worker config value needs to be either a real secret (`wrangler secret put`) or declared in `wrangler.jsonc`'s `vars` — anything set only as a plain dashboard variable will get wiped by the next CI deploy.
  - **Second gotcha, same session**: clicking through the live site turned up `D1_ERROR: no such table` on `/dashboard/settings`, `/invites`, `/meeting-polls` — migrations 0005-0007 had been merged (Phase 7.1-7.3) but never applied to production D1, because `wrangler deploy` only ships code/bindings and never touches D1 schema on its own; that's a manual step, always was. Fixed by running `wrangler d1 migrations apply cal-replication-db --remote` by hand, then folding a migrations step into the production trigger's deploy command (see `DEPLOYMENT.md`'s "Continuous deployment" section) so future migrations apply automatically on every push to `master` — accepted the tradeoff of no review gate on schema changes now (mitigated by this project's migrations convention of always additive `IF NOT EXISTS`), rather than wait for Phase 8's PR gate below.

~~Delete the comparison document from the repo, repo history and any commits.~~ Done — `COMPARISON.md` was never committed (confirmed via `git log --all -- COMPARISON.md`, no hits), so it was just deleted from disk; no history rewrite was needed.
