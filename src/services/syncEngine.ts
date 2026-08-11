import type { Env } from "../types";
import type { AccountRow, EventMappingRow } from "../db/schema";
import {
  listActiveAccountsForUser,
  getSyncToken,
  setSyncToken,
  clearSyncToken,
  findEventMappingsBySource,
  findEventMapping,
  createEventMapping,
  deleteEventMapping,
  startSyncLog,
  completeSyncLog,
  findActiveSyncLog,
} from "../db/schema";
import { getValidAccessToken } from "./tokenManager";
import {
  fetchEventsDelta,
  insertEvent,
  patchEvent,
  deleteEvent,
  SyncTokenExpiredError,
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
// KV for the same account many times over.
class TokenCache {
  private cache = new Map<string, Promise<string>>();
  constructor(private env: Env) {}
  get(accountId: string): Promise<string> {
    let p = this.cache.get(accountId);
    if (!p) {
      p = getValidAccessToken(this.env, accountId);
      this.cache.set(accountId, p);
    }
    return p;
  }
}

function isReplica(event: GoogleCalendarEvent): boolean {
  return event.extendedProperties?.private?.syncEngine === "cf-cal-replication";
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

async function deleteMappedReplicas(
  env: Env,
  tokens: TokenCache,
  mappings: EventMappingRow[],
): Promise<number> {
  for (const mapping of mappings) {
    const targetToken = await tokens.get(mapping.target_account_id);
    await deleteEvent(targetToken, mapping.target_event_id);
    await deleteEventMapping(env.DB, mapping.id);
  }
  return mappings.length;
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
    const payload = {
      summary,
      start: event.start,
      end: event.end,
      transparency: "opaque",
      extendedProperties: {
        private: {
          syncEngine: "cf-cal-replication",
          originAccountId: source.id,
          originEventId: event.id,
          syncGroupId: userId,
        },
      },
    };

    const existing = await findEventMapping(env.DB, source.id, event.id, target.id);
    const targetToken = await tokens.get(target.id);
    if (existing) {
      await patchEvent(targetToken, existing.target_event_id, payload);
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

async function fetchDeltaWithRecovery(
  env: Env,
  userId: string,
  account: AccountRow,
  accessToken: string,
): Promise<EventsDeltaResult> {
  const storedToken = await getSyncToken(env.DB, userId, account.id);
  const timeMin = () => new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  try {
    return await fetchEventsDelta(accessToken, storedToken ? { syncToken: storedToken } : { timeMin: timeMin() });
  } catch (err) {
    if (!(err instanceof SyncTokenExpiredError)) throw err;
    await clearSyncToken(env.DB, userId, account.id);
    return fetchEventsDelta(accessToken, { timeMin: timeMin() });
  }
}

async function syncAccount(
  env: Env,
  tokens: TokenCache,
  userId: string,
  account: AccountRow,
  allAccounts: AccountRow[],
): Promise<number> {
  let processed = 0;
  const accessToken = await tokens.get(account.id);
  const result = await fetchDeltaWithRecovery(env, userId, account, accessToken);

  for (const event of result.events) {
    if (event.status === "cancelled") {
      const mappings = await findEventMappingsBySource(env.DB, account.id, event.id);
      processed += await deleteMappedReplicas(env, tokens, mappings);
      continue;
    }
    if (isReplica(event)) continue;
    if (event.transparency === "transparent") {
      const mappings = await findEventMappingsBySource(env.DB, account.id, event.id);
      if (mappings.length > 0) processed += await deleteMappedReplicas(env, tokens, mappings);
      continue;
    }
    processed += await processCreateOrUpdate(env, tokens, userId, account, event, allAccounts);
  }

  await setSyncToken(env.DB, userId, account.id, "primary", result.nextSyncToken);
  return processed;
}

export async function runFullSync(env: Env, userId: string): Promise<void> {
  const active = await findActiveSyncLog(env.DB, userId);
  if (active) {
    const ageMs = Date.now() - new Date(active.created_at).getTime();
    if (ageMs < STALE_LOCK_MS) return; // a genuinely concurrent run owns this — don't race it
    await completeSyncLog(env.DB, active.id, "error", "Stale in_progress lock recovered by a later run", 0);
  }

  const logId = crypto.randomUUID();
  await startSyncLog(env.DB, logId, userId);

  const tokens = new TokenCache(env);
  let totalProcessed = 0;

  try {
    const accounts = await listActiveAccountsForUser(env.DB, userId);
    const errors: string[] = [];

    // One account's failure (revoked token, transient Google API error)
    // shouldn't block syncing the rest — isolate per account.
    for (const account of accounts) {
      try {
        totalProcessed += await syncAccount(env, tokens, userId, account, accounts);
      } catch (err) {
        errors.push(`${account.email}: ${err instanceof Error ? err.message : String(err)}`);
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
    await completeSyncLog(env.DB, logId, "error", err instanceof Error ? err.message : String(err), totalProcessed);
    throw err;
  }
}
