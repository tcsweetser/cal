# Recurring series replication: design

Date: 2026-11-10. Status: agreed in conversation, not yet planned.

## Why

CAL replicates each account's events onto the other linked accounts as busy blocks. Today it expands recurring series into individual instances (`singleEvents=true`) and only replicates events within a 42-day window, because a series that never ends expands into hundreds of instances (one production delta once queued 4,355). Two problems follow:

- **Single events booked more than 42 days ahead are never replicated.** The window filter drops them, the sync token advances, and Google never sends them again unless they change. Moving a replicated event beyond 42 days leaves its replica at the old time.
- **Recurring series need a daily audit** (`runDailyRecurringAudit`, `tracked_recurring_series`) to add each day's newly in-window instances, with its own failure modes.

The window exists only because of recurring series. The owner is happy for a single event 90 days out to replicate immediately. The fix is to replicate a recurring series as a series (its recurrence rule) rather than as instances, so a never-ending series costs one event per target and no window is needed.

## Goals

- Every single event replicates as soon as it's booked, however far ahead.
- Every recurring series replicates as one replica series per target calendar, which Google expands itself, so never-ending series are fully covered.
- Edited, moved and cancelled instances of a series are mirrored on the replica series.
- "This and following" edits (series splits) are handled.
- Per-tick D1 cost stays flat as data grows. D1 limits are account-wide and shared with another production database.

## Non-goals

- Copying titles, descriptions, attendees, locations or Meet links. Replicas stay "Busy" (or "Personal Time" from the primary), with reminders off, as today.
- Changing the replication topology (`targetsFor`).
- Deleting replicas of past single events. They stay as history, as they do today. (Past recurring-instance replicas are a special case of the cutover; see below.)

## Anti-goals (failure even if it technically works)

- A window where a real meeting shows as free on a target calendar. The booking page (`/book`) uses free/busy on those calendars, so an invitee could book over it.
- Replicas being replicated back (loops).
- Duplicate replicas left permanently.
- D1 rows read or calls per tick growing with table size or series length.
- Losing work on transient failures. The queue rules from `bfd3407` stay: an item is dropped only when Google answers 400 for it; anything else keeps it queued and stops that account's drain.

## Constraints

- Workers Free plan: 50 external subrequests per invocation (`MAX_CALENDAR_API_CALLS_PER_RUN` = 35 leaves headroom); 10-minute DO alarm ticks; 15-minute wall time.
- The existing staged sync stays: fetch only when an account's queue is empty, queue every fetched item, drain under the call budget, advance the sync token only once the queue is empty.
- The repo is public: no real event ids, calendar ids or email addresses in tracked files or tests.
- CAL only reads and writes each account's primary calendar.

## Observed Google behaviour (spike, 2026-11-10)

A throwaway script ran against a secondary calendar with `singleEvents=false` and `showDeleted=true`, taking an incremental snapshot after each change made in the Google Calendar UI. Google's docs are silent on most of this, so these observations are the basis for the design.

| Action | What the next incremental sync returned |
|---|---|
| Create a weekly, never-ending series | One entry: `recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"]`, `start`/`end` with `timeZone` |
| Move one instance ("This event") | The series (unchanged) plus the instance as its own entry: `recurringEventId`, `originalStartTime`, new `start`/`end` |
| Delete one instance ("This event") | The series, the earlier moved instance again, and the deleted instance as `status: "cancelled"` with `recurringEventId` and `originalStartTime`. The series' `recurrence` did not change (no EXDATE added) |
| Rename the series ("All events") | The series and every exception again, all with the new title; exceptions kept their own times and status |
| Change time from one instance on ("This and following") | The original series with `UNTIL=<day before, 23:59:59 local, in UTC>` added to its RRULE, its existing exceptions, and a new, independent series (new id, no `recurringEventId`) starting at the split point |
| Delete "All events" from the newer half of a split | Only the newer series, `status: "cancelled"`. The original series was untouched |
| Change the series' time ("All events") when it has a moved instance | The series with its new `start`/`end`, plus the old exception as `status: "cancelled"`. Google discarded the exception on the source; nothing re-created it |
| API: PATCH a replica series' `start`/`end` when it has a moved instance | Every instance moves and gets a new id (the suffix follows the new start time). The moved instance is discarded: its old id reads `cancelled` |

Also observed:

- **Incremental sync works with `singleEvents=false`.** `syncToken` with `singleEvents=false` and `showDeleted=true` returned 200 and correct deltas.
- **Bundles are resent.** Any change to a series resends the series and all its exceptions, changed or not.
- **Instance ids are predictable.** An instance's id is `<seriesId>_<original start in UTC, basic format>`, e.g. `<seriesId>_20261124T000000Z`. This format is not documented.
- **The replica marker is inherited.** A series inserted via the API with `extendedProperties.private` keeps that property on every instance returned by `events.instances`, including an instance after it was moved with PATCH. The `isReplica` loop guard works on series and exceptions.
- **A long-running series is returned by a `timeMin` fetch.** A list with `singleEvents=false` and `timeMin=now` returned a series that started three weeks earlier, together with its exception.
- **Moving an instance via the API works by id.** PATCH to `/events/<seriesId>_<suffix>` with new `start`/`end` (and `timeZone`) succeeded without listing instances first; the spike found the id via `events.instances`.

From Google's docs: a recurring event's `start.timeZone` and `end.timeZone` are required, and the recurrence expands in that zone. A cancelled exception is only guaranteed to carry `id`, `recurringEventId` and `originalStartTime`.

## Design (decided)

### Fetch

- All fetches use `singleEvents=false` and `showDeleted=true`.
- The initial fetch, and the refetch after a 410, use `timeMin=now` and **no `timeMax`**. Without expansion, a never-ending series is one item, so there's nothing to bound.
- Remove `FUTURE_WINDOW_MS`, the upper bound in `withinSyncWindow`, `runDailyRecurringAudit` with its KV gate, `fetchRecurringInstances`, and the use of `tracked_recurring_series`. Dropping the table itself can wait for a later migration.
- Keep the past bound for single events: a non-cancelled single event that has already ended isn't queued. Cancellations are always queued.

### Classifying each fetched item

| Item | How to recognise it | Handling |
|---|---|---|
| Single event | no `recurrence`, no `recurringEventId` | As today, without the future bound |
| Series | has `recurrence` | Series replication, below |
| Exception | has `recurringEventId` | Exception replication, below |
| Any replica | `extendedProperties.private.syncEngine` marker | Ignored, as today |

### Series replication

- For each target from `targetsFor`, insert one replica series: the source's `recurrence` lines unchanged, the source's `start`/`end` including `timeZone`, the usual summary, `transparency: opaque`, reminders off, and the private marker plus `originEventId`/`originAccountId` as today.
- Record the source series, target account and target series in a new series mapping table, together with a fingerprint of what was replicated: recurrence, start, end, time zone, status and transparency. Title is excluded, since replicas don't copy it.
- If a series comes back whose fingerprint matches the stored one, make no Google call. This covers bundle resends and renames.
- If the fingerprint differs, PATCH the replica series. This covers time changes and the `UNTIL` added by a split.
- When a series' start or end time changes, Google discards its exceptions on both the source and the replica (observed). So after patching the replica series, delete that series' exception rows. Cancelled entries for the old exception ids then arrive and are harmless no-ops. Any exceptions still present in the same bundle are re-applied under their new ids.
- A cancelled series deletes the replica series on each target (deleting a series removes all its instances) and its mapping rows, including its exception rows.
- A series that becomes `transparency: transparent` (free) deletes its replica series, mirroring how single events are handled today.
- A split needs no special case: the original series is a changed series, and the new half is a new series.

### Exception replication

- An exception is mapped by (series mapping, original start). Its target instance id is the target series id plus the source exception's id suffix after the source series id. This depends on the undocumented format above; see "Left to the builder".
- A moved or edited exception PATCHes the target instance with the new `start`/`end`.
- A cancelled exception cancels the target instance.
- Store a fingerprint per exception (start, end, status) and skip unchanged ones, as for series.
- Mirror every exception in a bundle, past ones included. A replica series also expands into the past, so past moved or cancelled instances must be mirrored for the replica's history to be accurate (owner's decision, 2026-11-10).
- If an exception arrives before its series has a replica on that target, it waits only while that series is itself still queued for the account. Otherwise it's logged and dropped: the series was free, rejected or cancelled, so there's nothing to attach it to. (My call, from the builder review.)
- On a target account's own changes, a cancelled stub can arrive without the replica marker. A stub whose `recurringEventId` is a known replica series id (from the series mapping table) is ignored like any other replica. (My call.)
- Free/busy on exceptions (my call): the exception fingerprint includes transparency. A free exception on a busy series cancels that target instance, and restores it if it turns busy again. A busy exception on a free series is replicated as a single event, mapped like one.
- Processing order within a fetch: series before exceptions. Google returned the series first in every bundle observed, but the design must not depend on that.

### D1 cost

- Every lookup is by primary key or an indexed prefix: series mapping by (source account, source series, target account); exception rows by (series mapping, original start).
- No per-tick query may scan a growing table. Use the existing `test/helpers/meteredD1.ts` pattern to test rows read.

## Cutover (decided)

Existing data on 2026-11-10: 347 single-event replicas, 418 future recurring-instance replicas across 12 series, and 369 past recurring-instance replicas across 22 series, spread over 5 target accounts.

Order: **build the new replicas first, then remove the old ones.**

1. Deploy the new code with a migration that only creates the new tables. The reset happens in code, per account, behind a stored "cutover done" marker, so an old-code tick between migration and deploy can't run against reset state (the deploy applies migrations before code). For each account the new code first drains any items already in `sync_queue` with the legacy instance handling. Once that queue is empty, it clears the account's `sync_tokens` and `pending_sync_tokens` and sets the marker, so the next fetch is a full fetch in the new mode. Queued cancellations are never discarded. (My call, from the builder review.)
2. That fetch returns every live series once, plus every single event from now on, including ones more than 42 days out that were never replicated. Series replicas are created, about 50 Google calls. Single events that already have a mapping are PATCHed in place, idempotently, as today.
3. Old future recurring-instance replicas are deleted from Google and their mapping rows removed. These are legacy mappings whose source id has an instance suffix dated today or later. Deletion runs under the same per-tick call budget as normal sync, after the normal drain, so it takes about two hours.
4. Then the 369 past recurring-instance replicas are deleted the same way, after the future ones, adding about two more hours. Each replica series now covers those past dates itself, so keeping them would double every past occurrence permanently (owner's decision, 2026-11-10: delete them and mirror past exceptions, rather than accept doubled history or start each replica series at the cutover date). There's no free-time risk, because the dates are past.

During step 3, upcoming recurring meetings show two busy blocks on target calendars. The owner accepted this for about two hours (2026-11-10). The reverse order would show those meetings as free, which is an anti-goal.

Progress is visible as the count of remaining legacy future-instance mappings, and as errors in `sync_logs`.

## Rollback

Reverting the code isn't enough: the old code would expand series again and recreate instance replicas next to the series replicas. A rollback needs a one-off step that deletes every replica series, using the series mapping table, before or with the revert. That step should exist, and be tested, before cutover.

## Testing

- `test/helpers/googleMock.ts` needs `singleEvents=false` responses: series, exceptions, cancelled exceptions, and the observed resend behaviour.
- One test per row of the observed-behaviour table, asserting the Google calls made on the target and the mapping rows left.
- Cost tests: a resend of an unchanged bundle makes no Google call, and per-tick D1 rows read stay bounded.
- Loop guard: a replica series and its exceptions appearing in a target's own delta are ignored.
- Cutover: legacy future-instance mappings are cleaned up under budget, past ones are kept, and single-event mappings are untouched.

## Left to the builder

- **Instance id derivation.** Whether to derive target instance ids from the observed suffix format, or look them up with `events.instances` around the original start. Deriving saves a call per exception, but the format is undocumented. Whichever is used, a 404 on the derived id should fall back to a lookup rather than drop the item.
- **All-day series.** These need checking: their instance suffix is likely date-only (`_YYYYMMDD`, as parsed in `migrations/0004`), and their start has no time zone.
- **A series without a time zone.** If a source series lacks `timeZone`, fall back to the source calendar's zone (`getCalendarTimeZone`).
- **Schema details.** Exact table and column names, fingerprint encoding, and whether past legacy instance mapping rows are deleted or kept.
- **Deterministic event ids.** Whether to give replicas deterministic client-supplied ids now, since the mapping tables are new anyway. That would fix the TODO about a retried insert creating a duplicate.
- **Spike cleanup.** Removing the spike calendar and the local spike token once building no longer needs them.
