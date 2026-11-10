import type { Env } from "../types";
import type { AccountRow, EventMappingRow } from "../db/schema";
import {
  listActiveAccountsForUser,
  getSyncToken,
  clearSyncToken,
  findEventMappingsBySource,
  findEventMappingsBySourceAccount,
  findEventMappingsForSeriesInstances,
  tryStartSyncLog,
  completeSyncLog,
  findActiveSyncLog,
  enqueueEvents,
  countQueuedEvents,
  hasQueuedEvents,
  dequeuePendingEvents,
  deleteQueuedEvent,
  setPendingSyncToken,
  promotePendingSyncToken,
} from "../db/schema";
import { isReplicaSeries, listSeriesIdsForSourceAccount, listSeriesMappingsForSource } from "../db/seriesSchema";
import {
  MAX_CALENDAR_API_CALLS_PER_RUN,
  CallBudget,
  TokenCache,
  errMessage,
  isReplica,
  isUnprocessableEvent,
  deleteMappedReplicas,
  processCreateOrUpdate,
  type BatchResult,
} from "./syncShared";
import {
  fetchEventsDelta,
  getEvent,
  SyncTokenExpiredError,
  type GoogleCalendarEvent,
  type EventsDeltaResult,
} from "./googleCalendar";
import { classifyEvent, queueOrder } from "./recurrence";
import {
  processException,
  processSeries,
  removeSeriesReplicas,
  type ReplicationContext,
} from "./seriesReplication";
import { noteCutoverProgress, prepareCutover, runLegacyCleanup } from "./cutover";

// A run older than this without completing is assumed crashed (Worker killed
// mid-execution, uncaught exception before the finally-equivalent completes),
// not genuinely still in progress — recover rather than deadlock forever.
const STALE_LOCK_MS = 15 * 60 * 1000;

// How many queued events to pull from D1 per drain iteration.
const QUEUE_DRAIN_BATCH_SIZE = 50;

// Queue items drained per runFullSync, across every account. The call budget
// alone doesn't bound D1: an item skipped by fingerprint (any change to a
// series resends its whole bundle) spends no call but makes about 2 queries
// per target. D1 allows 1,000 queries per invocation on Free, and every user
// syncs in the same invocation, so one user's resent bundle must not use them
// up. 60 items at that rate leaves room for the rest of the run.
const MAX_QUEUE_ITEMS_PER_RUN = 60;

// A single event that is over isn't worth queuing ("don't sync past events").
// Google applies timeMin only to a full fetch, never with a syncToken, so this
// is the one place the past bound holds on every fetch. It checks the END, so
// an event already under way still blocks calendars; a date-only end is
// exclusive, so an all-day event counts for its whole day. Cancellations are
// never "over": a stale replica needs deleting however old it is.
function hasEnded(event: GoogleCalendarEvent, nowMs: number): boolean {
  if (event.status === "cancelled") return false;
  const end = event.end?.dateTime ?? event.end?.date ?? event.start?.dateTime ?? event.start?.date;
  if (!end) return false;
  const endMs = new Date(end).getTime();
  return !Number.isNaN(endMs) && endMs < nowMs;
}

// What a fetch puts in the queue. Replicas are dropped (the loop guard), and
// so are bare cancelled stubs of a replica series' instances, which Google
// sends without the replica marker. Series and exceptions are always queued,
// past ones too, since a replica series also expands into the past. An ended
// single is dropped unless it used to be a series that still has replicas,
// which must go. Sorted so a series drains before its exceptions whatever
// order Google listed them in.
async function selectForQueue(
  db: D1Database,
  account: AccountRow,
  events: GoogleCalendarEvent[],
  nowMs: number,
): Promise<GoogleCalendarEvent[]> {
  const kept: GoogleCalendarEvent[] = [];
  // A resent replica bundle repeats one series id across all its stubs.
  const replicaSeries = new Map<string, boolean>();
  for (const event of events) {
    if (isReplica(event)) continue;
    const kind = classifyEvent(event);
    if (
      kind === "single" &&
      hasEnded(event, nowMs) &&
      (await listSeriesMappingsForSource(db, account.id, event.id)).length === 0
    ) {
      continue;
    }
    if (kind === "exception" && event.status === "cancelled") {
      const seriesId = event.recurringEventId!;
      let isStub = replicaSeries.get(seriesId);
      if (isStub === undefined) {
        isStub = await isReplicaSeries(db, account.id, seriesId);
        replicaSeries.set(seriesId, isStub);
      }
      if (isStub) continue;
    }
    kept.push(event);
  }
  // Array.prototype.sort is stable, so Google's order holds within each kind.
  return kept.sort((a, b) => queueOrder(a) - queueOrder(b));
}

// A forced full re-sync (after a 410) is timeMin-bounded and doesn't reliably
// report deletions the way an incremental (syncToken) sync does — Google
// generally just omits events that no longer exist rather than returning a
// cancelled stub. Without this, a source event cancelled while the token was
// stale leaves its replicas on every target calendar permanently. Existence-
// checks each previously-replicated series, then each single, directly.
// Series go first: there are few of them, and the singles alone can use up
// the budget.
//
// Not itself queued/resumable like the main event loop below: if the budget
// runs out mid-reconciliation, or any check or delete fails, the pass stops
// there and whatever's left unchecked isn't retried until the next 410
// recovery (a rare event). Stopping matters during an outage: moving on would
// make one uncounted call per mapping, far past the subrequest cap. Accepted
// tradeoff — reconciliation only runs after a syncToken expiry, so the
// backlog here is bounded by how many mappings that one account has, not by
// the same unbounded-first-sync scenario the queue below exists for.
async function reconcileAfterFullResync(ctx: ReplicationContext, sourceAccessToken: string): Promise<BatchResult> {
  const { env, tokens, budget, source } = ctx;
  const total: BatchResult = { processed: 0, errors: [] };

  for (const seriesId of await listSeriesIdsForSourceAccount(env.DB, source.id)) {
    if (budget.exhausted) return total;
    try {
      const stillExists = await getEvent(sourceAccessToken, seriesId);
      budget.spend();
      if (!stillExists) addInto(total, await removeSeriesReplicas(ctx, seriesId));
    } catch (err) {
      total.errors.push(`reconcile series ${seriesId}: ${errMessage(err)}`);
      return total;
    }
    if (total.retryLater) return total;
  }

  const mappings = await findEventMappingsBySourceAccount(env.DB, source.id);
  const bySourceEvent = new Map<string, EventMappingRow[]>();
  for (const mapping of mappings) {
    const group = bySourceEvent.get(mapping.source_event_id) ?? [];
    group.push(mapping);
    bySourceEvent.set(mapping.source_event_id, group);
  }
  for (const [sourceEventId, group] of bySourceEvent) {
    if (budget.exhausted) return total;
    try {
      const stillExists = await getEvent(sourceAccessToken, sourceEventId);
      budget.spend();
      if (!stillExists) addInto(total, await deleteMappedReplicas(env, tokens, group, budget));
    } catch (err) {
      total.errors.push(`reconcile ${sourceEventId}: ${errMessage(err)}`);
      return total;
    }
    if (total.retryLater) return total;
  }
  return total;
}

/**
 * Replicates one single event: a cancellation or a now-free event deletes its
 * replicas, anything else is created or updated on every target. Knows
 * nothing about series, so it also serves items queued before series
 * replication, whatever they are.
 */
async function processSingleEvent(
  env: Env,
  tokens: TokenCache,
  userId: string,
  account: AccountRow,
  event: GoogleCalendarEvent,
  allAccounts: AccountRow[],
  budget: CallBudget,
): Promise<BatchResult> {
  if (event.status === "cancelled" || event.transparency === "transparent") {
    const mappings = await findEventMappingsBySource(env.DB, account.id, event.id);
    return deleteMappedReplicas(env, tokens, mappings, budget);
  }
  const processed = await processCreateOrUpdate(env, tokens, userId, account, event, allAccounts, budget);
  return { processed, errors: [] };
}

function addInto(total: BatchResult, part: BatchResult): void {
  total.processed += part.processed;
  total.errors.push(...part.errors);
  if (part.retryLater) total.retryLater = true;
}

// A cancelled top-level item can be a series (its exceptions are not resent)
// or a single. Removes the replica series, the id's single replicas, and the
// singles keyed by its instance ids: busy instances of a free series, and
// legacy per-instance replicas.
async function processCancelledTopLevel(ctx: ReplicationContext, event: GoogleCalendarEvent): Promise<BatchResult> {
  const { env, tokens, budget, source } = ctx;
  const total: BatchResult = { processed: 0, errors: [] };
  addInto(total, await removeSeriesReplicas(ctx, event.id));
  if (total.retryLater) return total;
  addInto(total, await deleteMappedReplicas(env, tokens, await findEventMappingsBySource(env.DB, source.id, event.id), budget));
  if (total.retryLater) return total;
  const instances = await findEventMappingsForSeriesInstances(env.DB, source.id, event.id);
  addInto(total, await deleteMappedReplicas(env, tokens, instances, budget));
  return total;
}

// A series that became "does not repeat" keeps its id. Its replica series go
// only after the single replicas are in place, so the slot is never free on a
// target (replace before remove). If the budget ran out first, nothing is
// removed: removeSeriesReplicas spends nothing once it's exhausted, and the
// item stays queued. An ended single is queued only when it has replica
// series (see selectForQueue); those go, and the past event itself isn't
// replicated.
async function processSingleItem(ctx: ReplicationContext, event: GoogleCalendarEvent): Promise<BatchResult> {
  const { env, tokens, userId, source, allAccounts, budget } = ctx;
  if (hasEnded(event, Date.now())) return removeSeriesReplicas(ctx, event.id);
  const total = await processSingleEvent(env, tokens, userId, source, event, allAccounts, budget);
  if (total.retryLater) return total;
  addInto(total, await removeSeriesReplicas(ctx, event.id));
  return total;
}

function processQueuedEvent(ctx: ReplicationContext, event: GoogleCalendarEvent): Promise<BatchResult> {
  switch (classifyEvent(event)) {
    case "series":
      return processSeries(ctx, event);
    case "exception":
      return processException(ctx, event);
    case "cancelled-top-level":
      return processCancelledTopLevel(ctx, event);
    case "single":
      return processSingleItem(ctx, event);
  }
}

// Fetches the account's delta (full after a 410 or on the first sync), queues
// it, and holds the next sync token until that queue drains.
async function fetchIntoQueue(ctx: ReplicationContext): Promise<BatchResult> {
  const { env, tokens, budget, userId, source: account } = ctx;
  const accessToken = await tokens.get(account.id);
  const storedToken = await getSyncToken(env.DB, userId, account.id);
  // No far edge: a series is one item however long it runs, so there's
  // nothing to bound. "Now" excludes past single events on a full fetch, and
  // Google still returns a series that started earlier (spike, 2026-11-10).
  const nowMs = Date.now();
  const timeMin = new Date(nowMs).toISOString();

  let result: EventsDeltaResult;
  let recovered = false;
  try {
    result = storedToken
      ? await fetchEventsDelta(accessToken, { syncToken: storedToken })
      : await fetchEventsDelta(accessToken, { timeMin });
    budget.spend();
  } catch (err) {
    if (!(err instanceof SyncTokenExpiredError)) throw err;
    await clearSyncToken(env.DB, userId, account.id);
    result = await fetchEventsDelta(accessToken, { timeMin });
    budget.spend();
    recovered = true;
  }

  const reconciliation = recovered
    ? await reconcileAfterFullResync(ctx, accessToken)
    : { processed: 0, errors: [] };

  const toQueue = await selectForQueue(env.DB, account, result.events, nowMs);
  await enqueueEvents(
    env.DB,
    userId,
    account.id,
    toQueue.map((event) => ({ id: event.id, json: JSON.stringify(event) })),
  );
  await setPendingSyncToken(env.DB, userId, account.id, result.nextSyncToken);
  return reconciliation;
}

// Drains whatever's queued — what was just staged, or left over from a prior
// budget-limited run — until either the queue empties or the shared call
// budget runs out. Each item is only removed from the queue once fully
// processed (or once the catch below decides to give up on it) — never
// mid-processing, so a budget cutoff partway through leaves it there to
// resume from cleanly next time (a target that already has a mapping is only
// PATCHed again on retry). One gap: if an insert reaches Google but its
// mapping is never written, the retry inserts a second replica and the first
// stays unmapped.
async function drainQueue(
  env: Env,
  account: AccountRow,
  budget: CallBudget,
  handle: (event: GoogleCalendarEvent) => Promise<BatchResult>,
): Promise<BatchResult> {
  let processed = 0;
  const errors: string[] = [];
  drain: while (!budget.exhausted && !budget.itemsExhausted) {
    const limit = Math.min(QUEUE_DRAIN_BATCH_SIZE, budget.itemsRemaining);
    const batch = await dequeuePendingEvents(env.DB, account.id, limit);
    if (batch.length === 0) break;
    for (const item of batch) {
      // Checked before taking an item, never after: the item cap doesn't stop
      // the item just processed from leaving the queue.
      if (budget.exhausted || budget.itemsExhausted) break drain;
      budget.takeItem();
      // Parsed on its own so that only a corrupt queue row counts as corrupt.
      // A SyntaxError from inside the try below is a bad response from Google.
      let event: GoogleCalendarEvent;
      try {
        event = JSON.parse(item.event_json) as GoogleCalendarEvent;
      } catch (err) {
        errors.push(`event ${item.event_id}: ${errMessage(err)}`);
        await deleteQueuedEvent(env.DB, item.id);
        continue;
      }
      try {
        const result = await handle(event);
        processed += result.processed;
        errors.push(...result.errors);
        // Something may clear later (or, for an exception, its series is
        // still queued): keep the item and stop this account's drain.
        if (result.retryLater) break drain;
        if (!budget.exhausted) await deleteQueuedEvent(env.DB, item.id);
      } catch (err) {
        errors.push(`event ${item.event_id}: ${errMessage(err)}`);
        // Stop rather than move on: the same failure would hit the rest of
        // the queue, and the call budget only counts successful calls.
        if (!isUnprocessableEvent(err)) break drain;
        // A genuinely bad event (malformed payload Google rejects, etc.) —
        // remove it from the queue so it can't wedge every future drain on
        // the same failure forever.
        await deleteQueuedEvent(env.DB, item.id);
      }
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
  const ctx: ReplicationContext = { env, tokens, budget, userId, source: account, allAccounts };
  const total: BatchResult = { processed: 0, errors: [] };

  // Items queued before series replication drain the way they were fetched,
  // with nothing fetched meanwhile. The run that empties the queue resets the
  // sync position, so the next run's fetch is a full one in the new mode.
  if ((await prepareCutover(env, userId, account)) === "legacy-drain") {
    const drained = await drainQueue(env, account, budget, (event) =>
      processSingleEvent(env, tokens, userId, account, event, allAccounts, budget),
    );
    await prepareCutover(env, userId, account);
    return drained;
  }

  if (!(await hasQueuedEvents(env.DB, account.id)) && !budget.exhausted && !budget.itemsExhausted) {
    addInto(total, await fetchIntoQueue(ctx));
  }

  const drained = await drainQueue(env, account, budget, (event) => processQueuedEvent(ctx, event));
  total.processed += drained.processed;
  total.errors.push(...drained.errors);

  // Only safe once nothing from the fetch(es) that produced it remains
  // unprocessed — see the comment on pending_sync_tokens in the migration.
  if (!(await hasQueuedEvents(env.DB, account.id))) {
    await promotePendingSyncToken(env.DB, userId, account.id);
  }
  await noteCutoverProgress(env, account);

  return { processed: total.processed, errors: total.errors };
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
  const budget = new CallBudget(MAX_CALENDAR_API_CALLS_PER_RUN, MAX_QUEUE_ITEMS_PER_RUN);
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

    // After every account's drain, with whatever budget is left. Only
    // accounts whose cutover is complete have rows to clean up.
    try {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const cleanup = await runLegacyCleanup(env, tokens, budget, accounts, today);
      totalProcessed += cleanup.processed;
      errors.push(...cleanup.errors);
    } catch (err) {
      errors.push(`legacy cleanup: ${errMessage(err)}`);
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
