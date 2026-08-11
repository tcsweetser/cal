import type { Env } from "../types";
import type { AccountRow, EventMappingRow } from "../db/schema";
import {
  listActiveAccountsForUser,
  getSyncToken,
  setSyncToken,
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
} from "../db/schema";
import { getValidAccessToken, RefreshTokenInvalidError } from "./tokenManager";
import {
  fetchEventsDelta,
  insertEvent,
  patchEvent,
  deleteEvent,
  getEvent,
  SyncTokenExpiredError,
  EventGoneError,
  type GoogleCalendarEvent,
  type EventsDeltaResult,
} from "./googleCalendar";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// A run older than this without completing is assumed crashed (Worker killed
// mid-execution, uncaught exception before the finally-equivalent completes),
// not genuinely still in progress — recover rather than deadlock forever.
const STALE_LOCK_MS = 15 * 60 * 1000;

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
// reconciliation batch from being cleaned up.
async function deleteMappedReplicas(
  env: Env,
  tokens: TokenCache,
  mappings: EventMappingRow[],
): Promise<BatchResult> {
  let processed = 0;
  const errors: string[] = [];
  for (const mapping of mappings) {
    try {
      const targetToken = await tokens.get(mapping.target_account_id);
      await deleteEvent(targetToken, mapping.target_event_id);
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

async function processCreateOrUpdate(
  env: Env,
  tokens: TokenCache,
  userId: string,
  source: AccountRow,
  event: GoogleCalendarEvent,
  allAccounts: AccountRow[],
): Promise<number> {
  let processed = 0;
  for (const { account: target, summary } of targetsFor(source, allAccounts)) {
    const payload = buildReplicaPayload(userId, source, event, summary);
    const existing = await findEventMapping(env.DB, source.id, event.id, target.id);
    const targetToken = await tokens.get(target.id);

    if (existing) {
      try {
        await patchEvent(targetToken, existing.target_event_id, payload);
      } catch (err) {
        if (!(err instanceof EventGoneError)) throw err;
        // The replica was deleted out from under us (by hand, or expired) —
        // the mapping is stale. Drop it and re-create fresh instead of
        // throwing, which would wedge this account on the same 404 forever
        // (the source event never advances past this point otherwise).
        await deleteEventMapping(env.DB, existing.id);
        const created = await insertEvent(targetToken, payload);
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
async function reconcileAfterFullResync(
  env: Env,
  tokens: TokenCache,
  sourceAccountId: string,
  sourceAccessToken: string,
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
    try {
      const stillExists = await getEvent(sourceAccessToken, sourceEventId);
      if (!stillExists) {
        const result = await deleteMappedReplicas(env, tokens, group);
        processed += result.processed;
        errors.push(...result.errors);
      }
    } catch (err) {
      errors.push(`reconcile ${sourceEventId}: ${errMessage(err)}`);
    }
  }
  return { processed, errors };
}

async function syncAccount(
  env: Env,
  tokens: TokenCache,
  userId: string,
  account: AccountRow,
  allAccounts: AccountRow[],
): Promise<BatchResult> {
  let processed = 0;
  const errors: string[] = [];
  const accessToken = await tokens.get(account.id);
  const storedToken = await getSyncToken(env.DB, userId, account.id);
  const timeMin = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  let result: EventsDeltaResult;
  let recovered = false;
  try {
    result = storedToken
      ? await fetchEventsDelta(accessToken, { syncToken: storedToken })
      : await fetchEventsDelta(accessToken, { timeMin });
  } catch (err) {
    if (!(err instanceof SyncTokenExpiredError)) throw err;
    await clearSyncToken(env.DB, userId, account.id);
    result = await fetchEventsDelta(accessToken, { timeMin });
    recovered = true;
  }

  if (recovered) {
    const reconciliation = await reconcileAfterFullResync(env, tokens, account.id, accessToken);
    processed += reconciliation.processed;
    errors.push(...reconciliation.errors);
  }

  // Isolated per event: one event that fails (a deleted target replica that
  // somehow still throws, a malformed payload Google rejects, a transient
  // per-request error) shouldn't stop the rest of the delta from processing,
  // and — critically — shouldn't stop setSyncToken below from ever running.
  for (const event of result.events) {
    try {
      if (event.status === "cancelled") {
        const mappings = await findEventMappingsBySource(env.DB, account.id, event.id);
        const removal = await deleteMappedReplicas(env, tokens, mappings);
        processed += removal.processed;
        errors.push(...removal.errors);
        continue;
      }
      if (isReplica(event)) continue;
      if (event.transparency === "transparent") {
        const mappings = await findEventMappingsBySource(env.DB, account.id, event.id);
        if (mappings.length > 0) {
          const removal = await deleteMappedReplicas(env, tokens, mappings);
          processed += removal.processed;
          errors.push(...removal.errors);
        }
        continue;
      }
      processed += await processCreateOrUpdate(env, tokens, userId, account, event, allAccounts);
    } catch (err) {
      errors.push(`event ${event.id}: ${errMessage(err)}`);
    }
  }

  await setSyncToken(env.DB, userId, account.id, result.nextSyncToken);
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
  // Atomic compare-and-insert: if a concurrent run (cron vs. a manual
  // trigger) acquired the lock between our check above and now, this returns
  // false and we bail rather than both runs proceeding.
  const acquired = await tryStartSyncLog(env.DB, logId, userId);
  if (!acquired) return;

  const tokens = new TokenCache(env);
  let totalProcessed = 0;

  try {
    const accounts = await listActiveAccountsForUser(env.DB, userId);
    const errors: string[] = [];

    // One account's failure (revoked token, transient Google API error)
    // shouldn't block syncing the rest — isolate per account too.
    for (const account of accounts) {
      try {
        const result = await syncAccount(env, tokens, userId, account, accounts);
        totalProcessed += result.processed;
        errors.push(...result.errors.map((e) => `${account.email}: ${e}`));
      } catch (err) {
        errors.push(`${account.email}: ${errMessage(err)}`);
      }
    }

    await completeSyncLog(
      env.DB,
      logId,
      errors.length > 0 ? "error" : "success",
      errors.length > 0 ? errors.join("; ") : null,
      totalProcessed,
    );
  } catch (err) {
    // Only reachable for failures outside the per-account loop (e.g. listing accounts itself failed).
    await completeSyncLog(env.DB, logId, "error", errMessage(err), totalProcessed);
    throw err;
  }
}
