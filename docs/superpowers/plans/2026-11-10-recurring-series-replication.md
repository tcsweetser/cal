# Recurring Series Replication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replicate recurring series as series (recurrence rule plus per-instance exceptions) and single events at any distance ahead, replacing the 42-day window and the daily recurring audit, with a safe per-account cutover from today's per-instance replicas.

**Architecture:** Sync fetches with `singleEvents=false`, classifies each item as single, series, exception or cancelled top-level, and routes series and exceptions to a new `seriesReplication.ts` module with its own D1 tables. A per-account cutover state machine drains old queue items the legacy way, resets the sync position, refetches in the new mode, and then deletes legacy instance replicas under the call budget. A pause flag plus a removal batch provides rollback.

**Tech Stack:** TypeScript, Cloudflare Workers (Hono, D1, KV, Durable Object alarm), Google Calendar API v3, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-11-10-recurring-series-replication-design.md`

## Global Constraints

- Workers Free plan: 50 external subrequests per invocation. Every Google call spends one unit of the shared `CallBudget` (`MAX_CALENDAR_API_CALLS_PER_RUN` = 35), including legacy cleanup and rollback.
- Queue rule from `bfd3407`: drop a queue item only when Google answers 400 for it (`isUnprocessableEvent`). Any other failure keeps it queued and stops that account's drain (`retryLater`).
- Per-tick D1 reads stay bounded: every new query is by primary key or an indexed prefix, and new per-tick queries get a `meteredDb` rows-read test (`test/helpers/meteredD1.ts`).
- Replica payload unchanged: summary "Busy" ("Personal Time" from the primary), `transparency: "opaque"`, `reminders: { useDefault: false, overrides: [] }`, `extendedProperties.private.syncEngine = "cf-cal-replication"` plus `originAccountId`, `originEventId`, `syncGroupId`.
- Fetch parameters: `singleEvents=false`, `showDeleted=true`, `maxResults=250`. A full fetch uses `timeMin=now` and no `timeMax`.
- Migrations are additive and use `IF NOT EXISTS`. The next number is `0010`.
- Public repo: no real event ids, calendar ids or email addresses in tracked files or tests.
- Every task: `npm run typecheck` and `npm test` pass before its commit. Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never push or deploy. Every push to `master` deploys to production. Task 10 ends by asking the owner.

## Review Focus

1. **An event converted between single and recurring keeps its id.** Its old replicas must be removed before the new kind is replicated, otherwise both stay. (Task 5 and Task 7 tests.)
2. **Series creation split across ticks by the call budget.** When some targets are done and others aren't, the next run creates only the missing replica series, never a second one. (Task 5 test.)
3. **A series in a daylight-saving zone** (`Australia/Sydney`). The source exception's id suffix is a UTC instant, so it must still address the right replica instance. (Task 3 test.)
4. **An exception-only delta for an already-mapped series** (no series item in the delta) patches the target instance. (Task 6 test.)
5. **The cutover fetch of a series with more past exceptions than one run's budget** drains over several runs. The series is processed before its exceptions, and no exception is patched twice. (Task 7 test.)

---

### Task 1: Move shared sync helpers out of `syncEngine.ts`

Pure move, no behaviour change. `syncEngine.ts` is 645 lines, and the new modules need these helpers without importing `syncEngine.ts` (that would be circular).

**Files:**
- Create: `src/services/syncShared.ts`
- Modify: `src/services/syncEngine.ts` (remove the moved code, import it instead)

**Interfaces:**
- Produces (exported from `src/services/syncShared.ts`, signatures unchanged from today's private versions): `MAX_CALENDAR_API_CALLS_PER_RUN`, `class CallBudget`, `class TokenCache`, `interface BatchResult { processed: number; errors: string[]; retryLater?: boolean }`, `errMessage(err: unknown): string`, `isReplica(event: GoogleCalendarEvent): boolean`, `isUnprocessableEvent(err: unknown): boolean`, `targetsFor(source: AccountRow, allAccounts: AccountRow[]): Array<{ account: AccountRow; summary: string }>`, `buildReplicaPayload(userId: string, source: AccountRow, event: GoogleCalendarEvent, summary: string): Record<string, unknown>`, `deleteMappedReplicas(env: Env, tokens: TokenCache, mappings: EventMappingRow[], budget: CallBudget): Promise<BatchResult>`, `processCreateOrUpdate(env: Env, tokens: TokenCache, userId: string, source: AccountRow, event: GoogleCalendarEvent, allAccounts: AccountRow[], budget: CallBudget): Promise<number>`.

- [ ] **Step 1:** Move the items above verbatim, with their comments, into `syncShared.ts`, and import them in `syncEngine.ts`.
- [ ] **Step 2:** Run `npm run typecheck && npm test`. Expected: 117 tests pass, unchanged.
- [ ] **Step 3:** Commit `refactor: move shared sync helpers into syncShared.ts`.

### Task 2: Schema for series replication and cutover

**Files:**
- Create: `migrations/0010_series_replication.sql`
- Create: `src/db/seriesSchema.ts`
- Test: `test/seriesSchema.test.ts`

**Interfaces:**
- Produces, in `migrations/0010_series_replication.sql`:
  - `series_mappings(id TEXT PRIMARY KEY, user_id, source_account_id, source_series_id, target_account_id, target_series_id, fingerprint TEXT NOT NULL, created_at, updated_at)`. FKs to `users`/`accounts` with `ON DELETE CASCADE`. Unique index on `(source_account_id, source_series_id, target_account_id)`; index on `(target_account_id, target_series_id)`; index on `(user_id)`.
  - `exception_mappings(series_mapping_id TEXT NOT NULL REFERENCES series_mappings(id) ON DELETE CASCADE, original_start TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY (series_mapping_id, original_start))`.
  - `series_cutover(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, reset_at TEXT, completed_at TEXT)`.
  - `legacy_instance_cleanup(mapping_id TEXT PRIMARY KEY REFERENCES event_mappings(id) ON DELETE CASCADE, source_account_id TEXT NOT NULL, source_series_id TEXT NOT NULL, target_account_id TEXT NOT NULL, target_event_id TEXT NOT NULL, instance_date TEXT NOT NULL)`, where `instance_date` is `YYYYMMDD`. Index on `(source_account_id, instance_date)`. The migration does **not** populate it; Task 8's reset does, per account.
- Produces, in `src/db/seriesSchema.ts`:
  - `interface SeriesMappingRow` (all columns above) and `interface LegacyCleanupRow` (all columns above).
  - `findSeriesMapping(db, sourceAccountId: string, sourceSeriesId: string, targetAccountId: string): Promise<SeriesMappingRow | null>`
  - `listSeriesMappingsForSource(db, sourceAccountId: string, sourceSeriesId: string): Promise<SeriesMappingRow[]>`
  - `listSeriesIdsForSourceAccount(db, sourceAccountId: string): Promise<string[]>` (distinct; used only by 410 recovery)
  - `createSeriesMapping(db, input: { id; userId; sourceAccountId; sourceSeriesId; targetAccountId; targetSeriesId; fingerprint }): Promise<void>`
  - `updateSeriesFingerprint(db, id: string, fingerprint: string): Promise<void>`
  - `deleteSeriesMapping(db, id: string): Promise<void>`
  - `isReplicaSeries(db, targetAccountId: string, seriesId: string): Promise<boolean>`
  - `getExceptionFingerprint(db, seriesMappingId: string, originalStart: string): Promise<string | null>`
  - `upsertExceptionFingerprint(db, seriesMappingId: string, originalStart: string, fingerprint: string): Promise<void>`
  - `deleteExceptionRows(db, seriesMappingId: string): Promise<void>`
  - `isEventQueued(db, accountId: string, eventId: string): Promise<boolean>` (uses the existing unique `(account_id, event_id)` index on `sync_queue`)
  - `getCutoverState(db, accountId: string): Promise<{ reset_at: string | null; completed_at: string | null } | null>`
  - `markCutoverReset(db, userId: string, accountId: string): Promise<void>`: one `db.batch` that does `INSERT OR IGNORE INTO legacy_instance_cleanup ... SELECT` from this account's `event_mappings` rows whose `source_event_id` contains `_` (series id = text before `_`, `instance_date` = the 8 characters after it), deletes the account's `sync_tokens` and `pending_sync_tokens` rows, and upserts `series_cutover.reset_at = now`.
  - `markCutoverComplete(db, accountId: string): Promise<void>`
  - `listLegacyCleanup(db, sourceAccountId: string, today: string, limit: number): Promise<LegacyCleanupRow[]>`: rows with `instance_date >= today` ordered ascending first; if fewer than `limit`, then rows with `instance_date < today` ordered descending.
  - `deleteLegacyCleanupRow(db, mappingId: string): Promise<void>`
  - `listSeriesMappingsForUser(db, userId: string, limit: number): Promise<SeriesMappingRow[]>` and `countSeriesMappingsForUser(db, userId: string): Promise<number>` (rollback only, not per tick)

- [ ] **Step 1: Write the failing tests** in `test/seriesSchema.test.ts`:
  - `"a series mapping is found by source series and target, and isReplicaSeries recognises its target id"`
  - `"deleting a series mapping removes its exception rows"`: asserts `getExceptionFingerprint` returns `null` after `deleteSeriesMapping`.
  - `"markCutoverReset queues only this account's instance mappings, with their instance dates, and clears its sync position"`: seeds `event_mappings` with ids `ser1_20261124T000000Z`, `ser1_20260901`, `single1`, and one on another account; seeds `sync_tokens`/`pending_sync_tokens`. Asserts 2 cleanup rows with `instance_date` `20261124` and `20260901`, no token rows for the account, and `reset_at` set.
  - `"listLegacyCleanup returns future instances first, then the most recent past ones"`: `today = "20261110"`, limit 3, rows dated 20261201, 20261111, 20261020, 20260901. Expects order `20261111, 20261201, 20261020`.
  - `"per-tick lookups read a bounded number of rows"`: with 300 series mappings and 300 queue rows seeded, `findSeriesMapping`, `isReplicaSeries`, `getExceptionFingerprint` and `isEventQueued` each read fewer than 5 rows (`meteredDb`).
- [ ] **Step 2:** Run `npx vitest run test/seriesSchema.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Write the migration and the helpers with the signatures above.
- [ ] **Step 4:** Run `npx vitest run test/seriesSchema.test.ts`, then `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: add series replication and cutover tables`.

### Task 3: Recurrence classification and fingerprints

**Files:**
- Create: `src/services/recurrence.ts`
- Modify: `src/services/googleCalendar.ts` (add `recurrence?: string[]` and `originalStartTime?: GoogleEventDateTime` to `GoogleCalendarEvent`)
- Test: `test/recurrence.test.ts`

**Interfaces:**
- Produces:
  - `type FetchedKind = "single" | "series" | "exception" | "cancelled-top-level"`
  - `classifyEvent(event: GoogleCalendarEvent): FetchedKind`. `recurringEventId` present means exception. Otherwise, `status === "cancelled"` means cancelled-top-level (a cancelled series stub may lack `recurrence`). Otherwise, `recurrence` present means series. Otherwise single.
  - `instanceSuffix(exceptionId: string, seriesId: string): string | null`: returns the text from `_` onwards when `exceptionId` starts with `${seriesId}_`, else `null`.
  - `originalStartKey(event: GoogleCalendarEvent): string`: `originalStartTime.dateTime ?? originalStartTime.date`.
  - `seriesFingerprint(event: GoogleCalendarEvent): string`: stable JSON of `{ recurrence, start, end, status, transparency }`. The title is excluded.
  - `exceptionFingerprint(event: GoogleCalendarEvent): string`: stable JSON of `{ start, end, status, transparency }`.
  - `queueOrder(event: GoogleCalendarEvent): number`: series 0, cancelled-top-level 1, exception 2, single 3 (used to sort a fetch before enqueueing).

- [ ] **Step 1: Write the failing tests:**
  - `"classifies singles, series, exceptions and cancelled stubs"`: one case per kind, including a cancelled item with only `id` and `status`, which is cancelled-top-level, and a cancelled exception with only `id`, `recurringEventId` and `originalStartTime`, which is exception.
  - `"instanceSuffix extracts the original-start suffix and rejects foreign ids"`: `("abc_20261124T000000Z", "abc")` gives `"_20261124T000000Z"`; `("abc_20260901", "abc")` gives `"_20260901"`; `("xyz_20261124T000000Z", "abc")` gives `null`.
  - `"a Sydney-zone series keeps its suffix across daylight saving"`: an exception id `ser_20270115T230000Z` for series `ser` gives `"_20270115T230000Z"`, and that suffix appended to replica id `rep` is `"rep_20270115T230000Z"` (Review Focus 3).
  - `"fingerprints ignore the title but catch time, rule, status and transparency changes"`.
- [ ] **Step 2:** Run `npx vitest run test/recurrence.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement the functions above.
- [ ] **Step 4:** Run the test file, then the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: classify fetched events and fingerprint series`.

### Task 4: Google client for unexpanded fetches

**Files:**
- Modify: `src/services/googleCalendar.ts`
- Modify: `test/helpers/googleMock.ts`
- Test: `test/googleCalendar.test.ts` (create)

**Interfaces:**
- Produces:
  - `fetchEventsDelta(accessToken: string, source: { syncToken: string } | { timeMin: string }): Promise<EventsDeltaResult>`, always with `singleEvents=false`, `showDeleted=true`, `maxResults=250`. The `timeMax` option is removed. `syncEngine.ts` callers drop `timeMax` in this task.
  - `findInstanceByOriginalStart(accessToken: string, seriesId: string, originalStart: GoogleEventDateTime): Promise<GoogleCalendarEvent | null>`: one `events/{seriesId}/instances` call with `timeMin` = the original start and `timeMax` = original start + 48 hours. Returns the item whose `originalStartTime` is the same instant (or the same date, for all-day), else `null`.
  - Mock: `GoogleCalendarMock.listRequests: URLSearchParams[]`, recording every LIST query. `queueInstances` is reused for the instances endpoint.

- [ ] **Step 1: Write the failing tests:**
  - `"a full fetch asks for unexpanded series, deleted items, and no upper time bound"`: asserts `listRequests[0]` has `singleEvents=false`, `showDeleted=true`, `timeMin` set, and no `timeMax`.
  - `"an incremental fetch sends the sync token and the same expansion settings"`.
  - `"findInstanceByOriginalStart matches on original start, not current start"`: the queued instance has a moved `start` and the matching `originalStartTime`; asserts it's returned, and that a different original start returns `null`.
- [ ] **Step 2:** Run `npx vitest run test/googleCalendar.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement; update the `syncEngine.ts` call sites to stop passing `timeMax`.
- [ ] **Step 4:** Run the test file, then the full suite. Expected: all PASS. The client-side window filter in `syncEngine.ts` is still in place until Task 7, so the existing 42-day tests still hold.
- [ ] **Step 5:** Commit `feat: fetch Google events with series unexpanded`.

### Task 5: Series replication

**Files:**
- Create: `src/services/seriesReplication.ts`
- Test: `test/seriesReplication.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers, Task 2 `seriesSchema.ts`, Task 3 `seriesFingerprint`, `insertEvent`, `patchEvent`, `deleteEvent`, `getCalendarTimeZone`, `findEventMappingsBySource`.
- Produces:
  - `interface ReplicationContext { env: Env; tokens: TokenCache; budget: CallBudget; userId: string; source: AccountRow; allAccounts: AccountRow[] }`
  - `processSeries(ctx: ReplicationContext, event: GoogleCalendarEvent): Promise<BatchResult>`
  - `removeSeriesReplicas(ctx: ReplicationContext, sourceSeriesId: string): Promise<BatchResult>`: deletes each target's replica series (one call each) and the mapping rows. A failure that isn't `isUnprocessableEvent` and isn't `RefreshTokenInvalidError` sets `retryLater`, matching `deleteMappedReplicas`.

Behaviour of `processSeries`, per the spec's "Series replication":
- A cancelled or `transparent` series calls `removeSeriesReplicas` and returns.
- If `findEventMappingsBySource(source, event.id)` returns rows (the event used to be a single), `deleteMappedReplicas` runs first.
- A `dateTime` start with no `timeZone` gets the source calendar's zone from `getCalendarTimeZone`, which costs one budget unit.
- Per target from `targetsFor`, stopping when the budget runs out:
  - With no mapping: insert `buildReplicaPayload(...)` plus `recurrence: event.recurrence`, then `createSeriesMapping` with `seriesFingerprint(event)`.
  - With a mapping and a different fingerprint: PATCH the replica series with the same payload, `updateSeriesFingerprint`, then `deleteExceptionRows(mapping.id)`. Clearing on every series patch is a superset of the spec's "time change" rule; resent exceptions are re-applied.
  - With an `EventGoneError` on that PATCH: delete the mapping row and insert a fresh series.
  - With a matching fingerprint: no call.

- [ ] **Step 1: Write the failing tests** (mock plus real D1, one primary and two secondaries):
  - `"a new series from a secondary becomes one replica series on each other account"`: 2 inserts, each with `recurrence` equal to the source's and `start.timeZone` set, plus 2 mapping rows.
  - `"a resent unchanged series, or a rename, makes no Google call"`.
  - `"a changed rule patches each replica series and clears its exception rows"`: a split-style `UNTIL` added; asserts 2 patches and `getExceptionFingerprint` `null` afterwards.
  - `"a cancelled or free series deletes its replica series and mappings"`.
  - `"a series with no time zone takes the source calendar's"`.
  - `"a single event that becomes a series loses its single replicas first"` (Review Focus 1): seeded `event_mappings` for the id; asserts the deletes come before the inserts.
  - `"a budget cut between targets resumes without a second replica series"` (Review Focus 2): budget 1, run, then budget 35, run; asserts exactly 2 inserts in total.
- [ ] **Step 2:** Run `npx vitest run test/seriesReplication.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `processSeries` and `removeSeriesReplicas`.
- [ ] **Step 4:** Run the test file, then the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: replicate recurring series as series`.

### Task 6: Exception replication

**Files:**
- Modify: `src/services/seriesReplication.ts`
- Test: `test/seriesReplication.test.ts`
- Throwaway check: `/tmp/claude-1000/-home-terry-cal/73b3e0f1-4d69-44a1-834a-969e73c222e4/scratchpad/spike/spike.mjs` (not committed)

**Interfaces:**
- Consumes: Task 5 context; `processCreateOrUpdate` and `deleteMappedReplicas` from `syncShared.ts` (Task 1) for the single-event fallback.
- Produces: `processException(ctx: ReplicationContext, event: GoogleCalendarEvent): Promise<BatchResult>`.

Behaviour, per the spec's "Exception replication":
- **Waiting for its series:** if any target lacks a series mapping and `isEventQueued(source.id, event.recurringEventId)` is true, return `retryLater: true`.
- **No mapped targets:** if no target has a mapping and the series isn't queued, use the single-event path. A confirmed, opaque exception replicates as a single event in `event_mappings`. A cancelled or free one deletes any single replicas of `event.id`.
- **Per mapped target:**
  - `key = originalStartKey(event)` and `fp = exceptionFingerprint(event)`. Skip if the stored fingerprint equals `fp`.
  - The target instance id is `mapping.target_series_id + instanceSuffix(event.id, event.recurringEventId)`. If the suffix is `null`, or the PATCH throws `EventGoneError`, look the instance up once with `findInstanceByOriginalStart`. If it's still not found, record `fp` and move on.
  - A cancelled or `transparent` exception PATCHes `{ status: "cancelled" }`. Otherwise it PATCHes `{ start, end, status: "confirmed" }`, which also restores a previously cancelled instance.
  - `upsertExceptionFingerprint` after success.

- [ ] **Step 1: Verify the two API behaviours this task relies on**, against the spike calendar. Add a throwaway `spike.mjs` command that, on a fresh marked replica series, (a) PATCHes an instance with `{ status: "cancelled" }` and then `{ status: "confirmed", start, end }`, and (b) creates an all-day weekly series and lists its instance ids. Expected: (a) the instance ends up confirmed at the given time; (b) ids end `_YYYYMMDD`. If either differs, stop and report to the owner before continuing.
- [ ] **Step 2: Write the failing tests:**
  - `"a moved instance patches the matching replica instance by derived id"`: asserts a PATCH to `<replicaSeriesId>_<suffix>` with the new times.
  - `"a cancelled instance cancels the replica instance"`.
  - `"a resent unchanged exception makes no Google call"`.
  - `"an exception-only delta for a mapped series still patches the replica"` (Review Focus 4).
  - `"an exception waits while its series is still queued"`: asserts `retryLater` and no calls.
  - `"an exception whose series has no replica is treated as a single event"`: a busy exception on a free series gets one single-event insert per target.
  - `"a free instance on a busy series frees the replica slot, and restores it when busy again"`.
  - `"a derived id that 404s falls back to a lookup by original start"`.
- [ ] **Step 3:** Run `npx vitest run test/seriesReplication.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 4:** Implement `processException`.
- [ ] **Step 5:** Run the test file, then the full suite.
- [ ] **Step 6:** Commit `feat: mirror recurring-series exceptions onto replicas`.

### Task 7: Wire the new paths into sync and remove the window and the audit

**Files:**
- Modify: `src/services/syncEngine.ts`, `src/services/syncScheduler.ts`, `src/services/googleCalendar.ts` (remove `fetchRecurringInstances`), `src/db/schema.ts` (remove `trackRecurringSeriesIfNew`, `listRecurringSeriesNeedingAudit`, `advanceCoveredThrough`)
- Modify tests: `test/syncEngine.test.ts`, `test/syncScheduler.test.ts`. Delete `test/recurringSeriesCost.test.ts`.
- Test: `test/seriesSync.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 3, 5 and 6.
- Produces: `syncAccount` and `runFullSync` keep their signatures.

Changes:
- **Fetch:** `storedToken ? { syncToken } : { timeMin: now }`.
- **Filter before enqueueing:**
  - Drop `isReplica` items.
  - Drop cancelled exceptions whose `recurringEventId` passes `isReplicaSeries(db, account.id, …)`. These are bare replica stubs.
  - Drop non-cancelled **single** events that have already ended. This keeps today's past bound.
  - Series and exceptions are always queued.
  - Sort by `queueOrder` before `enqueueEvents`.
- **Drain dispatch by `classifyEvent`:**
  - series → `processSeries`
  - exception → `processException`
  - cancelled-top-level → `removeSeriesReplicas` plus `deleteMappedReplicas` of `findEventMappingsBySource`
  - single → if `listSeriesMappingsForSource(source, event.id)` is non-empty, `removeSeriesReplicas` first (Review Focus 1), then today's single logic
  - Any `retryLater` breaks the drain, as today.
- **410 recovery:** also check each id from `listSeriesIdsForSourceAccount` with `getEvent`, and call `removeSeriesReplicas` for any that are gone, under the same budget.
- **Removals:** `FUTURE_WINDOW_MS`, the upper bound of `withinSyncWindow` (rename it to `hasEnded` for singles), `runDailyRecurringAudit`, the tracking loop, `maybeRunDailyAudit`, and `DAILY_AUDIT_KV_KEY` in the scheduler.

- [ ] **Step 1: Write the failing end-to-end tests** in `test/seriesSync.test.ts`, one per row of the spec's observed-behaviour table, driven through `runFullSync` with queued LIST responses shaped like the spike's:
  - create series
  - move one instance
  - delete one instance
  - rename (no calls)
  - split (one patch plus a new series)
  - delete the newer half (only its replicas go)
  - series time change (patch, exception rows cleared, the stub for the old exception is a no-op)

  Also:
  - `"a single event 90 days out replicates immediately"`
  - `"a replica series and its bare cancelled stubs in a target's own delta are ignored"`
  - `"a series with 60 past exceptions drains over several runs, series first, with no exception patched twice"` (Review Focus 5)
  - `"a recurring series that becomes 'does not repeat' loses its replica series before the single replicates"` (Review Focus 1)
- [ ] **Step 2:** Run `npx vitest run test/seriesSync.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes above.
- [ ] **Step 4:** Delete the window and audit tests in `test/syncEngine.test.ts` (lines 512, 552, 620, 707, 760, 789) and `test/recurringSeriesCost.test.ts`. Change `test/syncScheduler.test.ts`'s `"a real alarm run executes the sync and daily audit, then re-arms"` to assert the sync runs and the alarm re-arms, with no audit. Keep the migration-0004 parsing test (line 828).
- [ ] **Step 5:** Run `npm run typecheck && npm test`. Expected: all pass.
- [ ] **Step 6:** Commit `feat: sync recurring series as series and drop the 42-day window`.

### Task 8: Per-account cutover and legacy cleanup

**Files:**
- Create: `src/services/cutover.ts`
- Modify: `src/services/syncEngine.ts`
- Test: `test/cutover.test.ts`

**Interfaces:**
- Consumes: Task 2 cutover helpers, Task 1 helpers, `hasQueuedEvents`.
- Produces:
  - `prepareCutover(env: Env, userId: string, account: AccountRow): Promise<"legacy-drain" | "ready">`. With no `reset_at` and a non-empty queue, it returns `"legacy-drain"`. With no `reset_at` and an empty queue, it calls `markCutoverReset` and returns `"ready"`. With `reset_at` set, it returns `"ready"`.
  - `noteCutoverProgress(env: Env, account: AccountRow): Promise<void>`: sets `completed_at` the first time the queue is empty after `reset_at`.
  - `runLegacyCleanup(env: Env, tokens: TokenCache, budget: CallBudget, accounts: AccountRow[], today: string): Promise<BatchResult>`. For accounts with `completed_at`, it takes `listLegacyCleanup` rows up to `budget.remaining`. If `findSeriesMapping(row.source_account_id, row.source_series_id, row.target_account_id)` exists, it calls `deleteEvent` on the target and `deleteEventMapping(row.mapping_id)`, which cascades the cleanup row. Otherwise it calls `deleteLegacyCleanupRow` and keeps the replica as history, since that series ended before cutover. A failure that isn't `isUnprocessableEvent` and isn't `RefreshTokenInvalidError` stops the cleanup for this run.

Wiring in `syncAccount`:
- Call `prepareCutover` first. On `"legacy-drain"`, drain with today's single-event logic for every item (old expanded instances included) and skip the fetch.
- After a drain in the new mode, call `noteCutoverProgress`.
- `runFullSync` calls `runLegacyCleanup` after the per-account loop, with the remaining budget.
- `today` is `new Date().toISOString().slice(0, 10).replace(/-/g, "")`.

- [ ] **Step 1: Write the failing tests:**
  - `"an account with old instance items queued drains them the old way before resetting"`: no LIST call while items remain; `reset_at` is set on the run where the queue empties.
  - `"the reset makes the next fetch a full unexpanded fetch"`: asserts `listRequests` has `timeMin` and no `syncToken`.
  - `"legacy future instance replicas are deleted only after their series has a replica on that target"`.
  - `"legacy instance replicas of a series that ended before cutover are kept"`: cleanup row gone, replica not deleted, `event_mappings` row kept.
  - `"legacy cleanup takes future instances first and stays within the call budget"`: 50 rows, budget 35; asserts 35 deletes, all dated today or later first.
  - `"single-event mappings are never touched by the cleanup"`.
  - `"an account connected after cutover resets immediately with nothing to clean up"`.
- [ ] **Step 2:** Run `npx vitest run test/cutover.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `cutover.ts` and the wiring.
- [ ] **Step 4:** Run the test file, then the full suite.
- [ ] **Step 5:** Commit `feat: per-account cutover to series replication`.

### Task 9: Rollback

**Files:**
- Create: `src/services/seriesRollback.ts`
- Modify: `src/routes/api.ts`, `src/services/syncScheduler.ts`
- Test: `test/seriesRollback.test.ts`

**Interfaces:**
- Produces:
  - `SERIES_ROLLBACK_KV_KEY = "series-replication:rollback"` (in `TOKEN_STORE`).
  - `runSeriesRollbackBatch(env: Env, userId: string): Promise<{ removed: number; remaining: number }>`: deletes replica series under a fresh `CallBudget` (`listSeriesMappingsForUser`, `deleteEvent`, `deleteSeriesMapping`). When none remain, it deletes the user's accounts' `sync_tokens`, `pending_sync_tokens` and `series_cutover` rows, so the reverted old code does a full refetch.
  - `POST /api/admin/series-rollback` (`requireAuth`): sets the KV flag and returns `{ status: "rollback started" }`.
  - `GET /api/admin/series-rollback` (`requireAuth`): returns `{ active: boolean, remaining: number }` via `countSeriesMappingsForUser`.
  - Scheduler: while the flag is set, `runScheduledSync` runs `runSeriesRollbackBatch` per user **instead of** `runFullSync`, so new code can't re-create what it's removing.

- [ ] **Step 1: Write the failing tests:**
  - `"while the rollback flag is set, ticks remove replica series and don't sync"`: asserts deletes, no LIST calls.
  - `"rollback removes at most one budget of series per tick and reports what remains"`.
  - `"when the last series is gone, sync positions and cutover state are cleared"`.
  - `"the rollback routes require a signed-in owner"`.
- [ ] **Step 2:** Run `npx vitest run test/seriesRollback.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the test file, then the full suite.
- [ ] **Step 5:** In `DEPLOYMENT.md`, add a "Series replication rollback" section:
  1. `POST /api/admin/series-rollback`.
  2. Wait for `GET` to report `remaining: 0`.
  3. Revert the series commits on `master` and push. The old code then refetches and rebuilds instance replicas.
  4. Delete the KV flag with `wrangler kv key delete`.
- [ ] **Step 6:** Commit `feat: rollback path for series replication`.

### Task 10: Docs, review and deployment readiness

**Files:**
- Modify: `DEPLOYMENT.md` (cutover section), `task_plan.md` (new entry), `TODO.md` (P1 item status)

- [ ] **Step 1:** Add a "Series replication cutover" section to `DEPLOYMENT.md`. It covers: what happens after deploy (legacy drain, reset, full fetch, series creation, legacy cleanup of future then past instances), the doubled busy blocks the owner accepted (about two hours, plus about two more for past instances), and how to watch progress. Progress checks:
  - the count of `legacy_instance_cleanup` rows
  - the count of `series_mappings` rows
  - `sync_logs` errors
  - `wrangler d1 info` `rows_read_24h`
- [ ] **Step 2:** Add a `task_plan.md` entry linking the spec and this plan. In `TODO.md`, mark the "One-off events more than 42 days ahead" P1 item as built and pending deploy.
- [ ] **Step 3:** Run `npm run typecheck && npm test`. Expected: all pass. Record the count.
- [ ] **Step 4:** Dispatch `code-reviewer` on `origin/master..HEAD`. Fix confirmed defects with a failing test first.
- [ ] **Step 5:** Commit `docs: series replication cutover and rollback`.
- [ ] **Step 6:** Stop, and ask the owner whether and when to push. A push deploys and starts the cutover. After deploy, watch the checks in Step 1. Then, with the owner's OK, delete the CAL spike calendar (`calendars.delete`) and the local spike token. Don't revoke the spike's Google grant: it's the same app and account as production.
