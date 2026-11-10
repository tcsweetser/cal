# TODO

Triaged 2026-11-10. P0: handle now. P1: next. P2: can wait. Details for the queue and resource items are in `task_plan.md` under "D1 incident follow-up bundle (2026-11-10)".

## P0

- [ ] Confirm the D1 fix in production. On or after 2026-11-11 01:00 UTC, `npx wrangler d1 info cal-replication-db -c wrangler.local.jsonc` should show `rows_read_24h` in the low thousands (it was 3,634,237). The 5M/day limit is account-wide, so HIT Pacific's production database shares it.

## P1

- [x] (Built on branch `feat/series-replication`, pending review and deploy. Cutover steps are in `DEPLOYMENT.md`.) One-off events more than 42 days ahead are never replicated. The window filter drops them, the sync token advances, and only recurring series have the daily audit to pick them up later. Moving an event beyond the window has the same cause and leaves its replica at the old time. Known since August (`task_plan.md`, "pre-existing structural gap") but never tracked. Anything booked 6+ weeks ahead doesn't block the other calendars.
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
