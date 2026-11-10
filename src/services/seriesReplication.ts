import type { Env } from "../types";
import type { AccountRow } from "../db/schema";
import { findEventMappingsBySource } from "../db/schema";
import {
  createSeriesMapping,
  deleteExceptionRows,
  deleteSeriesMapping,
  findSeriesMapping,
  getExceptionFingerprint,
  isEventQueued,
  listSeriesMappingsForSource,
  updateSeriesFingerprint,
  upsertExceptionFingerprint,
  type SeriesMappingRow,
} from "../db/seriesSchema";
import { RefreshTokenInvalidError } from "./tokenManager";
import {
  deleteEvent,
  EventGoneError,
  findInstanceByOriginalStart,
  getCalendarTimeZone,
  insertEvent,
  patchEvent,
  type GoogleCalendarEvent,
  type GoogleEventDateTime,
} from "./googleCalendar";
import { exceptionFingerprint, instanceSuffix, originalStartKey, seriesFingerprint } from "./recurrence";
import {
  buildReplicaPayload,
  deleteMappedReplicas,
  errMessage,
  isUnprocessableEvent,
  processCreateOrUpdate,
  targetsFor,
  type BatchResult,
  type CallBudget,
  type TokenCache,
} from "./syncShared";

// Everything one source account's drain needs to replicate a series or an
// exception onto the user's other accounts.
export interface ReplicationContext {
  env: Env;
  tokens: TokenCache;
  budget: CallBudget;
  userId: string;
  source: AccountRow;
  allAccounts: AccountRow[];
}

function withZone(time: GoogleEventDateTime | undefined, timeZone: string): GoogleEventDateTime | undefined {
  if (!time?.dateTime || time.timeZone) return time;
  return { ...time, timeZone };
}

// Google requires start.timeZone/end.timeZone on a recurring event, since the
// rule expands in that zone. The source calendar's zone is what the source
// series already expands in, so it is the one to copy. Returns null when the
// budget can't cover the lookup.
async function replicaTimes(
  ctx: ReplicationContext,
  event: GoogleCalendarEvent,
): Promise<{ start?: GoogleEventDateTime; end?: GoogleEventDateTime } | null> {
  const needsZone = [event.start, event.end].some((t) => t?.dateTime && !t.timeZone);
  if (!needsZone) return { start: event.start, end: event.end };
  if (ctx.budget.exhausted) return null;
  const token = await ctx.tokens.get(ctx.source.id);
  const timeZone = await getCalendarTimeZone(token);
  ctx.budget.spend();
  return { start: withZone(event.start, timeZone), end: withZone(event.end, timeZone) };
}

/**
 * Replicates one source series as one replica series per target. Budget-aware
 * and safe to resume: a target whose mapping already carries this
 * fingerprint costs no call. Insert and patch errors propagate to the drain,
 * as in processCreateOrUpdate; only deletes are caught.
 */
export async function processSeries(ctx: ReplicationContext, event: GoogleCalendarEvent): Promise<BatchResult> {
  const { env, budget, userId, source } = ctx;
  let processed = 0;
  const errors: string[] = [];

  // The id used to be a single event: its single replicas must go before
  // series replicas appear, or the target shows both.
  const singles = await findEventMappingsBySource(env.DB, source.id, event.id);
  if (singles.length > 0) {
    const removal = await deleteMappedReplicas(env, ctx.tokens, singles, budget);
    processed += removal.processed;
    errors.push(...removal.errors);
    if (removal.retryLater) return { processed, errors, retryLater: true };
  }

  if (event.status === "cancelled" || event.transparency === "transparent") {
    const removal = await removeSeriesReplicas(ctx, event.id);
    return {
      processed: processed + removal.processed,
      errors: [...errors, ...removal.errors],
      retryLater: removal.retryLater,
    };
  }

  // Taken from the event as received, so a resend matches whatever zone fill
  // the payload gets.
  const fingerprint = seriesFingerprint(event);
  let times: { start?: GoogleEventDateTime; end?: GoogleEventDateTime } | null | undefined;

  for (const { account: target, summary } of targetsFor(source, ctx.allAccounts)) {
    if (budget.exhausted) break;
    const existing = await findSeriesMapping(env.DB, source.id, event.id, target.id);
    if (existing?.fingerprint === fingerprint) continue;

    // Looked up only once a target actually needs a write.
    if (times === undefined) times = await replicaTimes(ctx, event);
    if (times === null || budget.exhausted) break;
    const payload = { ...buildReplicaPayload(userId, source, event, summary), ...times, recurrence: event.recurrence };
    const targetToken = await ctx.tokens.get(target.id);

    if (existing) {
      try {
        await patchEvent(targetToken, existing.target_series_id, payload);
        budget.spend();
        // Patching a series' times makes Google discard its exceptions on the
        // replica. Clearing on every patch lets the resent bundle re-apply
        // whichever exceptions still exist. Cleared before the fingerprint is
        // recorded: if the clear fails, the retry must not see a matching
        // fingerprint and skip it (a repeated patch is harmless).
        await deleteExceptionRows(env.DB, existing.id);
        await updateSeriesFingerprint(env.DB, existing.id, fingerprint);
        processed++;
        continue;
      } catch (err) {
        if (!(err instanceof EventGoneError)) throw err;
        budget.spend();
        // Deleted out from under us: drop the stale mapping (and its
        // exception rows) and insert a fresh series.
        await deleteSeriesMapping(env.DB, existing.id);
        if (budget.exhausted) break;
      }
    }

    // A retry after an insert whose mapping write failed can duplicate the
    // replica series (no client-supplied ids; known gap, as for singles).
    const created = await insertEvent(targetToken, payload);
    budget.spend();
    await createSeriesMapping(env.DB, {
      id: crypto.randomUUID(),
      userId,
      sourceAccountId: source.id,
      sourceSeriesId: event.id,
      targetAccountId: target.id,
      targetSeriesId: created.id,
      fingerprint,
    });
    processed++;
  }
  return { processed, errors, retryLater: false };
}

/**
 * Deletes each target's replica series (which removes all its instances) and
 * its mapping row; exception rows go with the mapping. Mirrors
 * deleteMappedReplicas: isolated per mapping, stops when the budget runs out,
 * and asks for a retry on any failure that may clear.
 */
export async function removeSeriesReplicas(ctx: ReplicationContext, sourceSeriesId: string): Promise<BatchResult> {
  const { env, budget } = ctx;
  let processed = 0;
  let retryLater = false;
  const errors: string[] = [];
  const mappings = await listSeriesMappingsForSource(env.DB, ctx.source.id, sourceSeriesId);
  for (const mapping of mappings) {
    if (budget.exhausted) break;
    try {
      const targetToken = await ctx.tokens.get(mapping.target_account_id);
      await deleteEvent(targetToken, mapping.target_series_id);
      budget.spend();
      await deleteSeriesMapping(env.DB, mapping.id);
      processed++;
    } catch (err) {
      errors.push(`series mapping ${mapping.id}: ${errMessage(err)}`);
      // A revoked target stays unreachable until it's reconnected, so waiting
      // for it would block the source account's queue indefinitely.
      if (!isUnprocessableEvent(err) && !(err instanceof RefreshTokenInvalidError)) retryLater = true;
    }
  }
  return { processed, errors, retryLater };
}

/**
 * Mirrors one source exception (a moved, cancelled, or free/busy-changed
 * instance) onto each target's replica series. Budget-aware and safe to
 * resume: a target whose exception row already carries this fingerprint
 * costs no call. Patch errors propagate to the drain, as in processSeries;
 * only a gone instance is handled here, by one lookup.
 */
export async function processException(ctx: ReplicationContext, event: GoogleCalendarEvent): Promise<BatchResult> {
  const { env, budget, source } = ctx;
  const seriesId = event.recurringEventId;
  if (!seriesId) throw new Error(`processException: ${event.id} has no recurringEventId`);

  const mapped: SeriesMappingRow[] = [];
  let anyUnmapped = false;
  for (const { account: target } of targetsFor(source, ctx.allAccounts)) {
    const mapping = await findSeriesMapping(env.DB, source.id, seriesId, target.id);
    if (mapping) mapped.push(mapping);
    else anyUnmapped = true;
  }
  // Its series drains first (queue order), so it gets a replica soon.
  if (anyUnmapped && (await isEventQueued(env.DB, source.id, seriesId))) {
    return { processed: 0, errors: [], retryLater: true };
  }
  const freesSlot = event.status === "cancelled" || event.transparency === "transparent";

  // No replica series anywhere: the series is free (or was rejected or
  // cancelled), so a busy exception stands alone as a single event.
  if (mapped.length === 0) {
    if (!freesSlot) {
      const processed = await processCreateOrUpdate(
        env,
        ctx.tokens,
        ctx.userId,
        source,
        event,
        ctx.allAccounts,
        budget,
      );
      return { processed, errors: [], retryLater: false };
    }
    const singles = await findEventMappingsBySource(env.DB, source.id, event.id);
    return deleteMappedReplicas(env, ctx.tokens, singles, budget);
  }

  // Single replicas of this instance on a target that has a replica series
  // would double its slot: busy exceptions replicated while the series was
  // free, or a legacy per-instance replica. Targets without a replica series
  // keep theirs, since nothing else blocks that time there.
  let processed = 0;
  const errors: string[] = [];
  const mappedTargets = new Set(mapped.map((m) => m.target_account_id));
  const singles = (await findEventMappingsBySource(env.DB, source.id, event.id)).filter((m) =>
    mappedTargets.has(m.target_account_id),
  );
  if (singles.length > 0) {
    const removal = await deleteMappedReplicas(env, ctx.tokens, singles, budget);
    processed += removal.processed;
    errors.push(...removal.errors);
    if (removal.retryLater) return { processed, errors, retryLater: true };
  }

  const key = originalStartKey(event);
  const fingerprint = exceptionFingerprint(event);
  // Confirming with the source's times also restores a replica instance
  // cancelled earlier (free, then busy again).
  const body: Record<string, unknown> = freesSlot
    ? { status: "cancelled" }
    : { start: event.start, end: event.end, status: "confirmed" };
  const suffix = instanceSuffix(event.id, seriesId);

  for (const mapping of mapped) {
    if (budget.exhausted) break;
    if ((await getExceptionFingerprint(env.DB, mapping.id, key)) === fingerprint) continue;
    const targetToken = await ctx.tokens.get(mapping.target_account_id);

    // Google's instance ids are <seriesId>_<original start>, which the
    // replica shares with its source (undocumented, so a miss is looked up).
    if (suffix !== null) {
      try {
        await patchEvent(targetToken, mapping.target_series_id + suffix, body);
        budget.spend();
        await upsertExceptionFingerprint(env.DB, mapping.id, key, fingerprint);
        processed++;
        continue;
      } catch (err) {
        if (!(err instanceof EventGoneError)) throw err;
        budget.spend();
        if (budget.exhausted) break;
      }
    }

    const instance = await findInstanceByOriginalStart(targetToken, mapping.target_series_id, event.originalStartTime!);
    budget.spend();
    if (instance) {
      if (budget.exhausted) break;
      try {
        await patchEvent(targetToken, instance.id, body);
        budget.spend();
        processed++;
      } catch (err) {
        if (!(err instanceof EventGoneError)) throw err;
        budget.spend();
      }
    }
    // Recorded even when no instance exists, so a resend doesn't look again.
    await upsertExceptionFingerprint(env.DB, mapping.id, key, fingerprint);
  }
  return { processed, errors, retryLater: false };
}
