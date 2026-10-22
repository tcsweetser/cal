import type { Env } from "../types";
import type { AccountRow, EventMappingRow } from "../db/schema";
import {
  listActiveAccountsForUser,
  getSyncToken,
  clearSyncToken,
  findEventMappingsBySource,
  findEventMappingsBySourceAccount,
  findEventMapping,
  createEventMapping,
  deleteEventMapping,
  markAccountStatus,
  tryStartSyncLog,
  completeSyncLog,
  findActiveSyncLog,
  enqueueEvents,
  countQueuedEvents,
  dequeuePendingEvents,
  deleteQueuedEvent,
  setPendingSyncToken,
  promotePendingSyncToken,
  trackRecurringSeriesIfNew,
  listRecurringSeriesNeedingAudit,
  advanceCoveredThrough,
} from "../db/schema";
import { getValidAccessToken, RefreshTokenInvalidError } from "./tokenManager";
import {
  fetchEventsDelta,
  fetchRecurringInstances,
  insertEvent,
  patchEvent,
  deleteEvent,
  getEvent,
  SyncTokenExpiredError,
  EventGoneError,
  type GoogleCalendarEvent,
  type EventsDeltaResult,
} from "./googleCalendar";

// A run older than this without completing is assumed crashed (Worker killed
// mid-execution, uncaught exception before the finally-equivalent completes),
// not genuinely still in progress — recover rather than deadlock forever.
const STALE_LOCK_MS = 15 * 60 * 1000;

// How far into the future an initial/full sync fetches. See the comment at
// its use in syncAccount for why this exists at all.
const FUTURE_WINDOW_MS = 42 * 24 * 60 * 60 * 1000;

// Workers Free plan caps external subrequests at 50 per invocation (Paid:
// 10,000+). One full sync's Google Calendar writes (up to one insert/patch
// per event per *other* account) can easily exceed that once a real backlog
// exists, which is what actually happened in production (see task_plan.md).
// Kept well under 50 to leave headroom for the list/get calls each account's
// fetch or reconciliation pass also makes against the same shared budget.
const MAX_CALENDAR_API_CALLS_PER_RUN = 35;

// How many queued events to pull from D1 per drain iteration. Generous —
// D1 has a separate, much higher (1,000 on Free) subrequest budget, so this
// is bounded by the Calendar-API budget checked inside the loop, not by this.
const QUEUE_DRAIN_BATCH_SIZE = 50;

// Tracks Google Calendar API calls spent so far this invocation, shared
// across every account synced in one runFullSync call — the Workers
// subrequest cap is per-invocation, not per-account, so the budget must be
// too. Each real Calendar API network call (list/get/insert/patch/delete)
// spends one unit; callers check `exhausted` before starting further work
// and stop cleanly (leaving remainder queued for the next invocation)
// instead of running past the platform's hard limit.
class CallBudget {
  private used = 0;
  constructor(private readonly max: number) {}
  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
  get exhausted(): boolean {
    return this.used >= this.max;
  }
  spend(n = 1): void {
    this.used += n;
  }
}

// Caches getValidAccessToken results for the lifetime of one runFullSync call.
// Under the full-mesh topology the same target account (especially Primary)
// is hit once per source account, so without this every run would re-check
// KV for the same account many times over. Also the single place that reacts
// to a revoked refresh token — every caller (source or target) funnels
// through here, so the account only needs marking once per run regardless of
// how many places tried to use its token.
class TokenCache {
  private cache = new Map<string, Promise<string>>();
  constructor(private env: Env) {}
  get(accountId: string): Promise<string> {
    let p = this.cache.get(accountId);
    if (!p) {
      p = getValidAccessToken(this.env, accountId).catch(async (err) => {
        if (err instanceof RefreshTokenInvalidError) {
          await markAccountStatus(this.env.DB, accountId, "revoked");
        }
        throw err;
      });
      this.cache.set(accountId, p);
    }
    return p;
  }
}

function isReplica(event: GoogleCalendarEvent): boolean {
  return event.extendedProperties?.private?.syncEngine === "cf-cal-replication";
}

function eventStartMs(event: GoogleCalendarEvent): number | null {
  const start = event.start?.dateTime ?? event.start?.date;
  if (!start) return null;
  const ms = new Date(start).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function eventEndMs(event: GoogleCalendarEvent): number | null {
  const end = event.end?.dateTime ?? event.end?.date;
  if (!end) return null;
  const ms = new Date(end).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Google's Calendar API rejects timeMin/timeMax combined with syncToken (they
// are mutually exclusive request parameters) — so the timeMin/timeMax bounds
// passed to fetchEventsDelta on the initial/full-resync fetch do nothing for
// the steady-state incremental (syncToken) fetch, which is what every account
// uses after its first successful sync. Creating a new recurring event and
// letting it arrive via an incremental delta is exactly what exposed this —
// first for the future side (an indefinitely-recurring series with no end
// date expanded to Google's ~2040 horizon, 700+ events from one account), and
// then, after that fix, for the past side too: a new weekly series anchored
// to a start date months in the past arrived with all 44 of its past
// occurrences included, since nothing was bounding the lower edge on the
// incremental path either (see task_plan.md for both incidents). This filter
// is the real enforcement point for both bounds — applied uniformly to
// whatever fetchEventsDelta returns, regardless of which path produced it, so
// the window is actually respected rather than only requested. Cancellations
// are exempt from both bounds: a stale replica needs deleting no matter how
// far out (or how far in the past) it would have been, and dropping the
// cancellation here would leave it orphaned forever.
// The lower bound checks END time, not start: an event that started 10
// minutes ago and runs another 50 isn't a "past event" in any useful sense,
// it's ongoing and still needs to block calendars — using start here would
// incorrectly reject anything already in progress. All-day events sharpen
// this further: Google's date-only start parses as that day's midnight UTC,
// so a same-day all-day event's start already reads as "before now" for any
// time after 00:00 — checking its (exclusive) end instead correctly keeps it
// in scope for its entire day. The upper bound stays start-based deliberately
// — an event that starts near the far edge of the window with a 2-hour
// duration should still count as "within FUTURE_WINDOW_MS," not be judged by
// when it finishes.
function withinSyncWindow(event: GoogleCalendarEvent, windowStartMs: number, windowEndMs: number): boolean {
  if (event.status === "cancelled") return true;
  const startMs = eventStartMs(event);
  const endMs = eventEndMs(event) ?? startMs;
  const notYetEnded = endMs === null || endMs >= windowStartMs;
  const startsInTime = startMs === null || startMs <= windowEndMs;
  return notYetEnded && startsInTime;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// plan.md §5.3 step 5's topology table, role-only (tag never affects this).
function targetsFor(
  source: AccountRow,
  allAccounts: AccountRow[],
): Array<{ account: AccountRow; summary: string }> {
  if (source.role === "secondary") {
    const targets: Array<{ account: AccountRow; summary: string }> = [];
    const primary = allAccounts.find((a) => a.role === "primary");
    if (primary) targets.push({ account: primary, summary: "Busy" });
    for (const secondary of allAccounts.filter((a) => a.role === "secondary")) {
      if (secondary.id !== source.id) targets.push({ account: secondary, summary: "Busy" });
    }
    return targets;
  }
  return allAccounts
    .filter((a) => a.role === "secondary")
    .map((account) => ({ account, summary: "Personal Time" }));
}

interface BatchResult {
  processed: number;
  errors: string[];
}

// Isolated per mapping: one bad delete (a genuine network/API error, not the
// already-tolerated 404/410) shouldn't stop the rest of a cancellation or
// reconciliation batch from being cleaned up. Budget-aware: stops (rather
// than throws) once the shared per-invocation call budget runs out, leaving
// remaining mappings for a later run — deleteEvent is idempotent (404/410 ==
// success), so re-attempting an already-deleted one next time is harmless.
async function deleteMappedReplicas(
  env: Env,
  tokens: TokenCache,
  mappings: EventMappingRow[],
  budget: CallBudget,
): Promise<BatchResult> {
  let processed = 0;
  const errors: string[] = [];
  for (const mapping of mappings) {
    if (budget.exhausted) break;
    try {
      const targetToken = await tokens.get(mapping.target_account_id);
      await deleteEvent(targetToken, mapping.target_event_id);
      budget.spend();
      await deleteEventMapping(env.DB, mapping.id);
      processed++;
    } catch (err) {
      errors.push(`mapping ${mapping.id}: ${errMessage(err)}`);
    }
  }
  return { processed, errors };
}

function buildReplicaPayload(userId: string, source: AccountRow, event: GoogleCalendarEvent, summary: string) {
  return {
    summary,
    start: event.start,
    end: event.end,
    transparency: "opaque",
    // Without this, every replica fires the target calendar's default
    // notifications — with N accounts that's N-1 duplicate popups per
    // meeting, which is the fastest way to make someone disable this tool.
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: {
      private: {
        syncEngine: "cf-cal-replication",
        originAccountId: source.id,
        originEventId: event.id,
        syncGroupId: userId,
      },
    },
  };
}

// Budget-aware: stops targeting further accounts once the shared
// per-invocation call budget runs out. Safe to resume later — every branch
// checks findEventMapping first, so a target already patched/created on a
// prior partial attempt is simply patched again (idempotent), never
// duplicated.
async function processCreateOrUpdate(
  env: Env,
  tokens: TokenCache,
  userId: string,
  source: AccountRow,
  event: GoogleCalendarEvent,
  allAccounts: AccountRow[],
  budget: CallBudget,
): Promise<number> {
  let processed = 0;
  for (const { account: target, summary } of targetsFor(source, allAccounts)) {
    if (budget.exhausted) break;
    const payload = buildReplicaPayload(userId, source, event, summary);
    const existing = await findEventMapping(env.DB, source.id, event.id, target.id);
    const targetToken = await tokens.get(target.id);

    if (existing) {
      try {
        await patchEvent(targetToken, existing.target_event_id, payload);
        budget.spend();
      } catch (err) {
        if (!(err instanceof EventGoneError)) throw err;
        budget.spend();
        // The replica was deleted out from under us (by hand, or expired) —
        // the mapping is stale. Drop it and re-create fresh instead of
        // throwing, which would wedge this account on the same 404 forever
        // (the source event never advances past this point otherwise).
        await deleteEventMapping(env.DB, existing.id);
        const created = await insertEvent(targetToken, payload);
        budget.spend();
        await createEventMapping(env.DB, {
          id: crypto.randomUUID(),
          userId,
          sourceAccountId: source.id,
          sourceEventId: event.id,
          targetAccountId: target.id,
          targetEventId: created.id,
        });
      }
    } else {
      const created = await insertEvent(targetToken, payload);
      budget.spend();
      await createEventMapping(env.DB, {
        id: crypto.randomUUID(),
        userId,
        sourceAccountId: source.id,
        sourceEventId: event.id,
        targetAccountId: target.id,
        targetEventId: created.id,
      });
    }
    processed++;
  }
  return processed;
}

// A forced full re-sync (after a 410) is timeMin-bounded and doesn't reliably
// report deletions the way an incremental (syncToken) sync does — Google
// generally just omits events that no longer exist rather than returning a
// cancelled stub. Without this, a source event cancelled while the token was
// stale leaves its replicas on every target calendar permanently. Existence-
// checks each previously-mapped source event directly instead.
//
// Not itself queued/resumable like the main event loop below: if the budget
// runs out mid-reconciliation, whatever's left unchecked this round simply
// isn't retried until the next 410 recovery (a rare event). Accepted
// tradeoff — reconciliation only runs after a syncToken expiry, so the
// backlog here is bounded by how many mappings that one account has, not by
// the same unbounded-first-sync scenario the queue below exists for.
async function reconcileAfterFullResync(
  env: Env,
  tokens: TokenCache,
  sourceAccountId: string,
  sourceAccessToken: string,
  budget: CallBudget,
): Promise<BatchResult> {
  const mappings = await findEventMappingsBySourceAccount(env.DB, sourceAccountId);
  const bySourceEvent = new Map<string, EventMappingRow[]>();
  for (const mapping of mappings) {
    const group = bySourceEvent.get(mapping.source_event_id) ?? [];
    group.push(mapping);
    bySourceEvent.set(mapping.source_event_id, group);
  }

  let processed = 0;
  const errors: string[] = [];
  for (const [sourceEventId, group] of bySourceEvent) {
    if (budget.exhausted) break;
    try {
      const stillExists = await getEvent(sourceAccessToken, sourceEventId);
      budget.spend();
      if (!stillExists) {
        const result = await deleteMappedReplicas(env, tokens, group, budget);
        processed += result.processed;
        errors.push(...result.errors);
      }
    } catch (err) {
      errors.push(`reconcile ${sourceEventId}: ${errMessage(err)}`);
    }
  }
  return { processed, errors };
}

// Staged/incremental: fetching from Google and replicating to targets are
// deliberately split. A fetch only ever happens when this account's queue is
// empty (never re-listing while a previous batch is still draining), and
// every fetched event is durably queued before any replication is attempted
// — so a budget cutoff mid-drain loses no work, and a large first-ever
// backlog spreads itself across as many 10-minute ticks as it needs rather than
// blowing the Workers subrequest cap in one invocation. Google's syncToken
// only advances (via promotePendingSyncToken) once the queue a fetch
// produced is fully drained — see task_plan.md for the incident this fixes.
async function syncAccount(
  env: Env,
  tokens: TokenCache,
  userId: string,
  account: AccountRow,
  allAccounts: AccountRow[],
  budget: CallBudget,
): Promise<BatchResult> {
  let processed = 0;
  const errors: string[] = [];

  const alreadyQueued = await countQueuedEvents(env.DB, account.id);
  if (alreadyQueued === 0 && !budget.exhausted) {
    const accessToken = await tokens.get(account.id);
    const storedToken = await getSyncToken(env.DB, userId, account.id);
    // "Now", not a lookback window — a bare timeMin already includes future
    // occurrences of a recurring series that started in the past (Google
    // evaluates each occurrence's own time against timeMin), so this excludes
    // only truly-past, non-recurring events, matching "don't sync past events
    // unless they're repeating past the current date and time." Bounding the
    // future side matters just as much: with singleEvents=true, an
    // indefinitely-recurring series with no end date expands into one item
    // per occurrence with no inherent cap — in production this queued 4,355
    // events from a single account before this bound existed (see
    // task_plan.md). Both bounds only take effect on this initial/full-resync
    // fetch, though — Google rejects timeMin/timeMax combined with syncToken,
    // so the incremental (steady-state) path below has no server-side bound
    // at all in either direction (proven twice: once for the future side,
    // then again for the past side when a newly-created series anchored
    // months back arrived with all its past occurrences intact).
    // withinSyncWindow (used just below, after the fetch) is the real
    // enforcement point for both — timeMin/timeMax here are a courtesy that
    // save a round trip when they do apply, never something to rely on alone.
    const windowStartMs = Date.now();
    const windowEndMs = windowStartMs + FUTURE_WINDOW_MS;
    const timeMin = new Date(windowStartMs).toISOString();
    const timeMax = new Date(windowEndMs).toISOString();

    let result: EventsDeltaResult;
    let recovered = false;
    try {
      result = storedToken
        ? await fetchEventsDelta(accessToken, { syncToken: storedToken })
        : await fetchEventsDelta(accessToken, { timeMin, timeMax });
      budget.spend();
    } catch (err) {
      if (!(err instanceof SyncTokenExpiredError)) throw err;
      await clearSyncToken(env.DB, userId, account.id);
      result = await fetchEventsDelta(accessToken, { timeMin, timeMax });
      budget.spend();
      recovered = true;
    }

    if (recovered) {
      const reconciliation = await reconcileAfterFullResync(env, tokens, account.id, accessToken, budget);
      processed += reconciliation.processed;
      errors.push(...reconciliation.errors);
    }

    // Replica events themselves are filtered out here (not worth queuing —
    // isReplica is a pure local check, no API call either way), as are
    // confirmed/tentative events starting outside the rolling window in
    // either direction (see withinSyncWindow — the real enforcement point
    // given Google won't bound the incremental/syncToken path itself).
    // Everything else — including cancellations and now-free events — goes
    // through the same queue so the drain loop below has one code path for
    // all of it.
    const toQueue = result.events
      .filter((event) => !isReplica(event))
      .filter((event) => withinSyncWindow(event, windowStartMs, windowEndMs))
      .map((event) => ({ id: event.id, json: JSON.stringify(event) }));
    await enqueueEvents(env.DB, userId, account.id, toQueue);
    await setPendingSyncToken(env.DB, userId, account.id, result.nextSyncToken);

    // First-sighting-only tracking (see trackRecurringSeriesIfNew) for the
    // daily audit's benefit — deliberately over every non-replica event
    // (including ones withinSyncWindow just filtered out), not just toQueue,
    // since an occurrence can be the very evidence that a series exists even
    // when that specific occurrence itself falls outside today's window.
    for (const event of result.events) {
      if (!isReplica(event) && event.recurringEventId) {
        await trackRecurringSeriesIfNew(env.DB, userId, account.id, event.recurringEventId, timeMax);
      }
    }
  }

  // Drain whatever's queued — what was just staged above, or left over from
  // a prior budget-limited run — until either the queue empties or the
  // shared call budget runs out. Each item is only removed from the queue
  // once fully processed (or once its own per-event try/catch below decides
  // to give up on it) — never removed mid-processing, so a budget cutoff
  // partway through leaves it there to resume from cleanly next time
  // (processCreateOrUpdate is idempotent per target, so a partially-done
  // event costs at most a few redundant PATCHes on retry, never a duplicate).
  while (!budget.exhausted) {
    const batch = await dequeuePendingEvents(env.DB, account.id, QUEUE_DRAIN_BATCH_SIZE);
    if (batch.length === 0) break;
    for (const item of batch) {
      if (budget.exhausted) break;
      try {
        const event = JSON.parse(item.event_json) as GoogleCalendarEvent;
        if (event.status === "cancelled") {
          const mappings = await findEventMappingsBySource(env.DB, account.id, event.id);
          const removal = await deleteMappedReplicas(env, tokens, mappings, budget);
          processed += removal.processed;
          errors.push(...removal.errors);
        } else if (event.transparency === "transparent") {
          const mappings = await findEventMappingsBySource(env.DB, account.id, event.id);
          if (mappings.length > 0) {
            const removal = await deleteMappedReplicas(env, tokens, mappings, budget);
            processed += removal.processed;
            errors.push(...removal.errors);
          }
        } else {
          processed += await processCreateOrUpdate(env, tokens, userId, account, event, allAccounts, budget);
        }
        if (!budget.exhausted) await deleteQueuedEvent(env.DB, item.id);
      } catch (err) {
        // A genuinely bad event (malformed payload Google rejects, etc.) —
        // isolate it like the old per-event loop did, and still remove it
        // from the queue so it can't wedge every future drain on the same
        // failure forever.
        errors.push(`event ${item.event_id}: ${errMessage(err)}`);
        await deleteQueuedEvent(env.DB, item.id);
      }
    }
  }

  // Only safe once nothing from the fetch(es) that produced it remains
  // unprocessed — see the comment on pending_sync_tokens in the migration.
  if ((await countQueuedEvents(env.DB, account.id)) === 0) {
    await promotePendingSyncToken(env.DB, userId, account.id);
  }

  return { processed, errors };
}

export async function runFullSync(env: Env, userId: string): Promise<void> {
  const active = await findActiveSyncLog(env.DB, userId);
  if (active) {
    const ageMs = Date.now() - new Date(active.created_at).getTime();
    if (ageMs < STALE_LOCK_MS) return; // a genuinely concurrent run owns this — don't race it
    await completeSyncLog(env.DB, active.id, "error", "Stale in_progress lock recovered by a later run", 0);
  }

  const logId = crypto.randomUUID();
  // Atomic compare-and-insert: if a concurrent run (scheduled tick vs. a
  // manual trigger) acquired the lock between our check above and now, this returns
  // false and we bail rather than both runs proceeding.
  const acquired = await tryStartSyncLog(env.DB, logId, userId);
  if (!acquired) return;

  const tokens = new TokenCache(env);
  const budget = new CallBudget(MAX_CALENDAR_API_CALLS_PER_RUN);
  let totalProcessed = 0;

  try {
    const accounts = await listActiveAccountsForUser(env.DB, userId);
    const errors: string[] = [];

    // One account's failure (revoked token, transient Google API error)
    // shouldn't block syncing the rest — isolate per account too. Every
    // account shares the same budget (the Workers subrequest cap is per
    // invocation, not per account), so a large backlog on one account can
    // still leave little or nothing for the rest this round — they'll get
    // their share on a later tick once this one's queue is smaller.
    for (const account of accounts) {
      try {
        const result = await syncAccount(env, tokens, userId, account, accounts, budget);
        totalProcessed += result.processed;
        errors.push(...result.errors.map((e) => `${account.email}: ${e}`));
      } catch (err) {
        errors.push(`${account.email}: ${errMessage(err)}`);
      }
    }

    // A budget cutoff isn't a failure — it's the queue doing exactly what
    // it's for. Surface it plainly rather than silently completing "success"
    // with no indication that a follow-up run is still needed.
    const stillQueued = await Promise.all(accounts.map((a) => countQueuedEvents(env.DB, a.id)));
    const remaining = stillQueued.reduce((sum, n) => sum + n, 0);
    const notes: string[] = [];
    if (remaining > 0) notes.push(`${remaining} event(s) queued, continuing next run`);
    if (errors.length > 0) notes.push(...errors);

    await completeSyncLog(
      env.DB,
      logId,
      errors.length > 0 ? "error" : "success",
      notes.length > 0 ? notes.join("; ") : null,
      totalProcessed,
    );
  } catch (err) {
    // Only reachable for failures outside the per-account loop (e.g. listing accounts itself failed).
    await completeSyncLog(env.DB, logId, "error", errMessage(err), totalProcessed);
    throw err;
  }
}

// Separate, smaller budget from the main sync's MAX_CALENDAR_API_CALLS_PER_RUN
// — this runs as an extra step inside the same scheduled tick (see
// services/syncScheduler.ts), sharing that invocation's real Workers subrequest ceiling, so it
// must not compete for the main sync's own allowance. In steady state this
// audit only spends 1 call per tracked series (each gap is normally a single
// day wide), so this cap is generous headroom, not a tight constraint.
const MAX_DAILY_AUDIT_CALLS = 15;

// Closes the gap left by the incremental (syncToken) sync path: an unedited
// recurring series never generates a new delta, so nothing ever notices when
// one of its occurrences rolls into the sync window (FUTURE_WINDOW_MS) as
// "now" advances (see task_plan.md, and the migration comment on
// tracked_recurring_series). This
// runs once a day (gated by a KV timestamp in services/syncScheduler.ts, piggybacked
// on the 10-minute tick rather than given a schedule of its own). For each series whose covered_through
// has fallen behind today's window edge, looks ahead just the newly-exposed
// gap via events.instances() (unbounded by the syncToken restriction — see
// fetchRecurringInstances) and enqueues anything not already queued, reusing
// the exact same sync_queue/budget/resumability machinery the normal 10-
// minute sync already relies on, rather than duplicating replication logic
// here. Deliberately outside runFullSync's per-user sync_logs lock — this
// touches a different table (tracked_recurring_series) and a disjoint set of
// API calls, so it can safely run independently without contending for that
// lock or being mistaken for a stuck sync run.
export async function runDailyRecurringAudit(env: Env): Promise<void> {
  const nowMs = Date.now();
  const windowEndIso = new Date(nowMs + FUTURE_WINDOW_MS).toISOString();
  const series = await listRecurringSeriesNeedingAudit(env.DB, windowEndIso);
  if (series.length === 0) return;

  const tokens = new TokenCache(env);
  const budget = new CallBudget(MAX_DAILY_AUDIT_CALLS);

  for (const row of series) {
    if (budget.exhausted) break;
    try {
      const accessToken = await tokens.get(row.account_id);
      const instances = await fetchRecurringInstances(accessToken, row.recurring_event_id, row.covered_through, windowEndIso);
      budget.spend();

      const toQueue = instances
        .filter((event) => !isReplica(event))
        .map((event) => ({ id: event.id, json: JSON.stringify(event) }));
      await enqueueEvents(env.DB, row.user_id, row.account_id, toQueue);
      await advanceCoveredThrough(env.DB, row.account_id, row.recurring_event_id, windowEndIso);
    } catch (err) {
      // One series' failure (revoked token, transient API error) shouldn't
      // stop the rest of the audit — left with a stale covered_through, so
      // it's simply retried on the next daily run rather than lost.
      console.error(`Daily recurring audit failed for series ${row.recurring_event_id}:`, errMessage(err));
    }
  }
}
