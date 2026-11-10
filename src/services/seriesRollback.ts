// One-off removal path for series replication. Reverting the code alone would
// leave the old per-instance code creating replicas next to the replica
// series, so while the KV flag below is set, ticks and manual syncs delete the
// replica series instead of syncing (DEPLOYMENT.md, "Series replication
// rollback").
import type { Env } from "../types";
import { listAccountsForUser } from "../db/schema";
import { countSeriesMappingsForUser, deleteSeriesMapping, listSeriesMappingsForUser } from "../db/seriesSchema";
import { deleteEvent } from "./googleCalendar";
import { CallBudget, errMessage, isUnprocessableEvent, MAX_CALENDAR_API_CALLS_PER_RUN, TokenCache } from "./syncShared";
import { RefreshTokenInvalidError } from "./tokenManager";

export const SERIES_ROLLBACK_KV_KEY = "series-replication:rollback";

export async function isSeriesRollbackActive(env: Env): Promise<boolean> {
  return (await env.TOKEN_STORE.get(SERIES_ROLLBACK_KV_KEY)) !== null;
}

// Clears the sync positions and cutover state so the reverted old code does a
// full refetch. One batch: a crash cannot leave only part of it cleared.
async function clearSyncState(env: Env, userId: string): Promise<void> {
  const accountIds = (await listAccountsForUser(env.DB, userId)).map((a) => a.id);
  if (accountIds.length === 0) return;
  const marks = accountIds.map(() => "?").join(", ");
  await env.DB.batch(
    ["sync_tokens", "pending_sync_tokens", "series_cutover"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table} WHERE account_id IN (${marks})`).bind(...accountIds),
    ),
  );
}

/**
 * Deletes up to one run's budget of the user's replica series from their
 * target calendars. A 400 or a revoked target can't be retried usefully, so
 * the mapping goes anyway; any other failure stops the batch and keeps the
 * row for the next tick. When none remain, the sync state is cleared.
 */
export async function runSeriesRollbackBatch(
  env: Env,
  userId: string,
): Promise<{ removed: number; remaining: number }> {
  const budget = new CallBudget(MAX_CALENDAR_API_CALLS_PER_RUN);
  const tokens = new TokenCache(env);
  const rows = await listSeriesMappingsForUser(env.DB, userId, MAX_CALENDAR_API_CALLS_PER_RUN);
  let removed = 0;
  for (const row of rows) {
    if (budget.exhausted) break;
    try {
      const token = await tokens.get(row.target_account_id);
      // A series already gone (404/410) counts as deleted.
      await deleteEvent(token, row.target_series_id);
      budget.spend();
    } catch (err) {
      console.error(`Series rollback: mapping ${row.id}: ${errMessage(err)}`);
      if (err instanceof RefreshTokenInvalidError) {
        // No call was made.
      } else if (isUnprocessableEvent(err)) {
        budget.spend();
      } else {
        break;
      }
    }
    await deleteSeriesMapping(env.DB, row.id);
    removed++;
  }
  const remaining = await countSeriesMappingsForUser(env.DB, userId);
  if (remaining === 0) await clearSyncState(env, userId);
  return { removed, remaining };
}
