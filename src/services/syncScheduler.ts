import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { listUserIds } from "../db/schema";
import { runFullSync, runDailyRecurringAudit } from "./syncEngine";

// Replaces the old `*/10` Cron Trigger (task_plan.md Phase 10): the account
// has a fixed budget of 5 Cron Triggers, and a Durable Object alarm gives the
// same cadence without spending one.
const TICK_INTERVAL_MS = 10 * 60 * 1000;
const ALARM_SLACK_MS = 30 * 1000;

// KV key gating the once-a-day recurring-series audit (see syncEngine.ts's
// runDailyRecurringAudit) — deliberately not its own schedule. Piggybacks on
// the 10-minute tick instead: whichever tick is the first to land after this
// key's date falls behind today's (UTC) date runs the audit once, then
// updates the key so the rest of the day's ticks skip it.
const DAILY_AUDIT_KV_KEY = "daily-recurring-audit:last-run-date";

// Strictly after `now`, so an alarm that fires exactly on a boundary arms the
// following one rather than itself. Aligned to wall-clock 10-minute marks to
// keep the same timing the cron had.
export function nextTenMinuteBoundary(now: number): number {
  return Math.floor(now / TICK_INTERVAL_MS) * TICK_INTERVAL_MS + TICK_INTERVAL_MS;
}

// Isolated per user: runFullSync already isolates per-account failures and
// records them in sync_logs, but a structural failure (e.g. listing that
// user's accounts itself throwing) shouldn't stop other users' syncs.
async function runScheduledSync(env: Env): Promise<void> {
  const userIds = await listUserIds(env.DB);
  for (const userId of userIds) {
    try {
      await runFullSync(env, userId);
    } catch (err) {
      console.error(`Sync failed for user ${userId}:`, err instanceof Error ? err.message : err);
    }
  }
}

// The KV write happens before the audit runs, not after: if the audit itself
// fails partway, it shouldn't retry every 10 minutes for the rest of the day
// (each tracked series already tolerates a stale covered_through and just
// retries on the next real daily run — see runDailyRecurringAudit).
async function maybeRunDailyAudit(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const lastRun = await env.TOKEN_STORE.get(DAILY_AUDIT_KV_KEY);
  if (lastRun === today) return;
  await env.TOKEN_STORE.put(DAILY_AUDIT_KV_KEY, today);
  try {
    await runDailyRecurringAudit(env);
  } catch (err) {
    console.error("Daily recurring audit failed:", err instanceof Error ? err.message : err);
  }
}

// One instance (named "global", see ensureSyncScheduler) whose alarm re-arms
// itself every 10 minutes. Alarms on a single object never run concurrently,
// so ticks can't overlap each other; a manual "Run sync now" can still run
// alongside a tick, which the sync_logs lock already handles (plan.md §5.3).
export class SyncScheduler extends DurableObject<Env> {
  // Idempotent: only arms an alarm if none is set, so calling it on every
  // isolate start never pushes an imminent tick further out.
  async ensure(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(nextTenMinuteBoundary(Date.now()));
    }
  }

  // The next alarm is armed first, before any sync work. Unlike a cron, an
  // alarm only recurs if the handler schedules it, and a run killed at the
  // 15-minute wall-time limit (it has happened — see task_plan.md's 2026-08
  // notes) never reaches a `finally`. Awaiting the storage write also means
  // it is durable before the sync's first outbound fetch goes out. If the
  // run outlasts the boundary, the overdue alarm fires as soon as this one
  // returns.
  //
  // The 30s of slack keeps an alarm delivered a few ms early (clock skew)
  // from re-arming for the boundary it was meant to be, which would run a
  // second full sync back to back.
  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.ctx.storage.setAlarm(nextTenMinuteBoundary(Date.now() + ALARM_SLACK_MS));
    // A platform retry means the previous attempt died partway — most likely
    // killed at the wall-time limit. Re-running the whole sync a few seconds
    // later would hit the same limit, and after 6 failed retries it is not
    // documented whether the alarm survives. Returning normally ends the
    // retry chain; the next boundary resumes the work (the queue is durable).
    if (alarmInfo?.isRetry) {
      console.warn(`Skipping retried tick (retry ${alarmInfo.retryCount}); next boundary will resume.`);
      return;
    }
    try {
      await this.tick();
    } catch (err) {
      // Never rethrow: the platform would retry the whole sync within seconds
      // instead of leaving it for the next boundary.
      console.error("Scheduled tick failed:", err instanceof Error ? err.message : err);
    }
  }

  // Separate from alarm() so tests can substitute it.
  async tick(): Promise<void> {
    await runScheduledSync(this.env);
    await maybeRunDailyAudit(this.env);
  }
}

// async so that even a synchronous failure (e.g. a missing binding from a
// hand-copied config) becomes a rejection the caller's .catch() logs.
export async function ensureSyncScheduler(env: Env): Promise<void> {
  await env.SYNC_SCHEDULER.getByName("global").ensure();
}
