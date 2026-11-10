// Per-account cutover from per-instance replication to series replication.
// Items queued by the old code drain the old way first. Then the sync
// position is reset, so the next fetch is a full unexpanded one that creates
// the replica series. Only once that fetch has fully drained are the old
// instance replicas deleted, future ones first. Doubled busy blocks for a
// while are accepted; a meeting showing as free is not.
import type { Env } from "../types";
import type { AccountRow } from "../db/schema";
import { deleteEventMapping, getSyncToken, hasQueuedEvents } from "../db/schema";
import {
  deleteLegacyCleanupRow,
  findSeriesMapping,
  getCutoverState,
  listLegacyCleanup,
  markCutoverComplete,
  markCutoverReset,
  type LegacyCleanupRow,
} from "../db/seriesSchema";
import { deleteEvent } from "./googleCalendar";
import { RefreshTokenInvalidError } from "./tokenManager";
import { errMessage, isUnprocessableEvent, type BatchResult, type CallBudget, type TokenCache } from "./syncShared";

export type CutoverMode = "legacy-drain" | "ready";

/**
 * Before the reset, a non-empty queue holds items the old code fetched
 * (expanded instances included), so they drain the old way and nothing is
 * fetched. The first time the queue is empty, the reset clears the sync
 * position and queues the account's instance mappings for cleanup.
 */
export async function prepareCutover(env: Env, userId: string, account: AccountRow): Promise<CutoverMode> {
  const state = await getCutoverState(env.DB, account.id);
  if (state?.reset_at) return "ready";
  if (await hasQueuedEvents(env.DB, account.id)) return "legacy-drain";
  await markCutoverReset(env.DB, userId, account.id);
  return "ready";
}

/**
 * Marks the cutover complete once the full fetch after the reset has drained.
 * The reset deletes the account's sync token and only a fully drained fetch
 * promotes a new one, so an empty queue alone is not enough: a budget cut
 * between the reset and the fetch also leaves it empty, and completing then
 * would keep every legacy replica, since no series would be mapped yet.
 */
export async function noteCutoverProgress(env: Env, account: AccountRow): Promise<void> {
  const state = await getCutoverState(env.DB, account.id);
  if (!state?.reset_at || state.completed_at) return;
  if (await hasQueuedEvents(env.DB, account.id)) return;
  if ((await getSyncToken(env.DB, account.user_id, account.id)) === null) return;
  await markCutoverComplete(env.DB, account.id);
}

type RowOutcome = "done" | "stop";

// A legacy replica goes only once its series has a replica series on the same
// target (replace before remove). Without one, the series ended before the
// cutover, so the replica stays as history and only its cleanup row goes.
async function cleanUpRow(
  env: Env,
  tokens: TokenCache,
  budget: CallBudget,
  row: LegacyCleanupRow,
  total: BatchResult,
  label: string,
): Promise<RowOutcome> {
  const series = await findSeriesMapping(env.DB, row.source_account_id, row.source_series_id, row.target_account_id);
  if (!series) {
    await deleteLegacyCleanupRow(env.DB, row.mapping_id);
    return "done";
  }
  try {
    const targetToken = await tokens.get(row.target_account_id);
    // A replica already gone (404/410) counts as deleted.
    await deleteEvent(targetToken, row.target_event_id);
    budget.spend();
    // Removes the cleanup row too (ON DELETE CASCADE).
    await deleteEventMapping(env.DB, row.mapping_id);
    total.processed++;
    return "done";
  } catch (err) {
    total.errors.push(`${label}: legacy cleanup mapping ${row.mapping_id}: ${errMessage(err)}`);
    // Retrying can't help: a revoked target stays unreachable until it's
    // reconnected, and Google rejected this delete itself. Dropping only the
    // cleanup row keeps the mapping and stops the row heading the list on
    // every run.
    if (err instanceof RefreshTokenInvalidError || isUnprocessableEvent(err)) {
      await deleteLegacyCleanupRow(env.DB, row.mapping_id);
      return "done";
    }
    // Anything else may clear, and would likely hit the next row too.
    return "stop";
  }
}

/**
 * Deletes legacy per-instance replicas for accounts whose cutover is
 * complete, within what's left of the run's call budget and item cap. Every
 * account's future instances go before any account's past ones: the future
 * ones are the doubled busy blocks the owner accepted for a few hours, and
 * one account's past backlog must not hold up another's. Each row takes one
 * item, and one call when it deletes; rows kept as history make no call, so
 * the item cap is what bounds their D1 work.
 */
export async function runLegacyCleanup(
  env: Env,
  tokens: TokenCache,
  budget: CallBudget,
  accounts: AccountRow[],
  today: string,
): Promise<BatchResult> {
  const total: BatchResult = { processed: 0, errors: [] };
  if (budget.exhausted || budget.itemsExhausted) return total;
  const completed: AccountRow[] = [];
  for (const account of accounts) {
    if ((await getCutoverState(env.DB, account.id))?.completed_at) completed.push(account);
  }
  for (const phase of ["future", "past"] as const) {
    for (const account of completed) {
      if (budget.exhausted || budget.itemsExhausted) return total;
      const limit = Math.min(budget.remaining, budget.itemsRemaining);
      for (const row of await listLegacyCleanup(env.DB, account.id, today, phase, limit)) {
        // Checked before taking a row, as in the queue drain.
        if (budget.exhausted || budget.itemsExhausted) return total;
        budget.takeItem();
        if ((await cleanUpRow(env, tokens, budget, row, total, account.email)) === "stop") return total;
      }
    }
  }
  return total;
}
