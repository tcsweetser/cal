import type { Env } from "../types";
import type { AccountRow, EventMappingRow } from "../db/schema";
import {
  findEventMapping,
  createEventMapping,
  deleteEventMapping,
  markAccountStatus,
} from "../db/schema";
import { getValidAccessToken, RefreshTokenInvalidError } from "./tokenManager";
import {
  insertEvent,
  patchEvent,
  deleteEvent,
  EventGoneError,
  GoogleApiError,
  type GoogleCalendarEvent,
} from "./googleCalendar";

// Workers Free plan caps external subrequests at 50 per invocation (Paid:
// 10,000+). One full sync's Google Calendar writes (up to one insert/patch
// per event per *other* account) can easily exceed that once a real backlog
// exists, which is what actually happened in production (see task_plan.md).
// Kept well under 50 to leave headroom for the list/get calls each account's
// fetch or reconciliation pass also makes against the same shared budget.
export const MAX_CALENDAR_API_CALLS_PER_RUN = 35;

// Tracks Google Calendar API calls spent so far this invocation, shared
// across every account synced in one runFullSync call — the Workers
// subrequest cap is per-invocation, not per-account, so the budget must be
// too. Each real Calendar API network call (list/get/insert/patch/delete)
// spends one unit; callers check `exhausted` before starting further work
// and stop cleanly (leaving remainder queued for the next invocation)
// instead of running past the platform's hard limit.
export class CallBudget {
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
export class TokenCache {
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

export function isReplica(event: GoogleCalendarEvent): boolean {
  return event.extendedProperties?.private?.syncEngine === "cf-cal-replication";
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// True only when the event itself can't be processed, so retrying can never
// help and it's safe to drop from the queue: Google answering 400. Anything
// else (an outage, an auth or token failure, a rate limit, a missing calendar,
// the Workers subrequest cap) says nothing about the event:
// dropping it would lose the work, because the syncToken still advances once
// the queue is empty and Google won't send that change again.
export function isUnprocessableEvent(err: unknown): boolean {
  return err instanceof GoogleApiError && err.status === 400;
}

// plan.md §5.3 step 5's topology table, role-only (tag never affects this).
export function targetsFor(
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

export interface BatchResult {
  processed: number;
  errors: string[];
  // Something failed for a reason that may clear, so the caller should keep
  // its queue item for a later run.
  retryLater?: boolean;
}

// Isolated per mapping: one bad delete (a genuine network/API error, not the
// already-tolerated 404/410) shouldn't stop the rest of a cancellation or
// reconciliation batch from being cleaned up. Budget-aware: stops (rather
// than throws) once the shared per-invocation call budget runs out, leaving
// remaining mappings for a later run — deleteEvent is idempotent (404/410 ==
// success), so re-attempting an already-deleted one next time is harmless.
export async function deleteMappedReplicas(
  env: Env,
  tokens: TokenCache,
  mappings: EventMappingRow[],
  budget: CallBudget,
): Promise<BatchResult> {
  let processed = 0;
  let retryLater = false;
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
      // A revoked target stays unreachable until it's reconnected, so waiting
      // for it would block the source account's queue indefinitely.
      if (!isUnprocessableEvent(err) && !(err instanceof RefreshTokenInvalidError)) retryLater = true;
    }
  }
  return { processed, errors, retryLater };
}

export function buildReplicaPayload(userId: string, source: AccountRow, event: GoogleCalendarEvent, summary: string): Record<string, unknown> {
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
export async function processCreateOrUpdate(
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
