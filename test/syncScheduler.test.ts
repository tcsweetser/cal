// SyncScheduler replaces the old `*/10` Cron Trigger (task_plan.md Phase 10).
// The property that matters most: the next alarm is armed before the sync
// runs, so a run that throws — or is killed at the 15-minute wall-time limit,
// which never reaches a `finally` — still leaves the next tick scheduled.
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { nextTenMinuteBoundary } from "../src/services/syncScheduler";

const TEN_MINUTES_MS = 10 * 60 * 1000;

// Each test uses its own instance name so no alarm state leaks between them;
// the class itself doesn't care what it's called (production uses "global").
const scheduler = (name: string) => env.SYNC_SCHEDULER.getByName(name);

// A re-armed alarm must be in the future and on a 10-minute mark — never
// "now", which would fire a second full sync straight away.
function expectArmedOnFutureBoundary(alarm: number | null) {
  expect(alarm).not.toBeNull();
  expect(alarm!).toBeGreaterThan(Date.now());
  expect(alarm! % TEN_MINUTES_MS).toBe(0);
}

describe("nextTenMinuteBoundary", () => {
  it("rounds up to the next 10-minute mark", () => {
    expect(nextTenMinuteBoundary(Date.UTC(2026, 9, 22, 16, 43, 12))).toBe(Date.UTC(2026, 9, 22, 16, 50));
  });

  it("moves a full interval forward when already exactly on a boundary", () => {
    // An alarm firing exactly on time must not re-arm itself for "now".
    expect(nextTenMinuteBoundary(Date.UTC(2026, 9, 22, 16, 50))).toBe(Date.UTC(2026, 9, 22, 17, 0));
  });

  it("crosses midnight into the next UTC day", () => {
    expect(nextTenMinuteBoundary(Date.UTC(2026, 9, 22, 23, 55, 1))).toBe(Date.UTC(2026, 9, 23, 0, 0));
  });
});

describe("SyncScheduler", () => {
  it("ensure() arms an alarm on the next 10-minute boundary when none is set", async () => {
    const stub = scheduler("ensure-empty");
    await stub.ensure();
    await runInDurableObject(stub, async (_instance, state) => {
      expectArmedOnFutureBoundary(await state.storage.getAlarm());
    });
  });

  it("ensure() leaves an alarm that is already set alone", async () => {
    const stub = scheduler("ensure-existing");
    const existing = Date.now() + 3 * TEN_MINUTES_MS + 1234;
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(existing));
    await stub.ensure();
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(existing);
    });
  });

  it("alarm() arms the next tick before the sync starts", async () => {
    const stub = scheduler("alarm-order");
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      let alarmSeenDuringTick: number | null = null;
      instance.tick = async () => {
        alarmSeenDuringTick = await state.storage.getAlarm();
      };
      await instance.alarm();
      expectArmedOnFutureBoundary(alarmSeenDuringTick);
    });
  });

  it("alarm() swallows a failing sync and keeps the schedule", async () => {
    const stub = scheduler("alarm-throws");
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      instance.tick = async () => {
        throw new Error("simulated sync failure");
      };
      await expect(instance.alarm()).resolves.toBeUndefined();
      expectArmedOnFutureBoundary(await state.storage.getAlarm());
    });
  });

  it("alarm() skips the sync on a platform retry but still re-arms", async () => {
    // A retry means the previous attempt died (e.g. killed at the 15-minute
    // wall-time limit); re-running the whole sync seconds later would just be
    // killed again. The next boundary picks the work up instead.
    const stub = scheduler("alarm-retry");
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      let ticked = false;
      instance.tick = async () => {
        ticked = true;
      };
      await instance.alarm({ isRetry: true, retryCount: 1, scheduledTime: Date.now() });
      expect(ticked).toBe(false);
      expectArmedOnFutureBoundary(await state.storage.getAlarm());
    });
  });

  it("a real alarm run executes the sync and daily audit, then re-arms", async () => {
    const stub = scheduler("alarm-real");
    await stub.ensure();
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // No users exist, so the sync is a no-op; the audit's KV gate proves the
    // second half of the tick ran too.
    const today = new Date().toISOString().slice(0, 10);
    expect(await env.TOKEN_STORE.get("daily-recurring-audit:last-run-date")).toBe(today);

    await runInDurableObject(stub, async (_instance, state) => {
      expectArmedOnFutureBoundary(await state.storage.getAlarm());
    });
  });
});

describe("Worker fetch", () => {
  it("arms the global scheduler's alarm on the first request", async () => {
    // This is what starts the cadence after the cutover deploy.
    const ctx = createExecutionContext();
    await worker.fetch(new Request("https://cal.test/login"), env, ctx);
    await waitOnExecutionContext(ctx);
    await runInDurableObject(scheduler("global"), async (_instance, state) => {
      expectArmedOnFutureBoundary(await state.storage.getAlarm());
    });
  });
});
