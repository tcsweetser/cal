// The engine_owner gate: CAL's engine runs only when the flag is exactly "cal". Each entry point checks it first.
import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { it, expect, beforeEach, afterEach, type Mock } from "vitest";
import { runFullSync } from "../src/services/syncEngine";
import { runSeriesRollbackBatch } from "../src/services/seriesRollback";
import { countSeriesMappingsForUser, createSeriesMapping } from "../src/db/seriesSchema";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { seriesSetup, hoursFromNow, type SeriesSetup } from "./helpers/seriesEvents";
import { setOwner } from "./helpers/engineOwner";

let mock: GoogleCalendarMock;
let fetchSpy: Mock;
let s: SeriesSetup;

beforeEach(async () => {
  mock = new GoogleCalendarMock();
  fetchSpy = mock.install() as unknown as Mock;
  s = await seriesSetup();
  // One source event waiting on the business account, so an engine that runs has Google calls to make.
  mock.queueList("tok-biz", {
    events: [
      {
        id: "ev1",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(2) },
        end: { dateTime: hoursFromNow(3) },
      },
    ],
    nextSyncToken: "biz-token-1",
  });
});

afterEach(() => setOwner("cal"));

async function logCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_logs WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row!.n;
}

async function seedMapping(): Promise<string> {
  const targetSeriesId = `gate-replica-${crypto.randomUUID()}`;
  await createSeriesMapping(env.DB, {
    id: crypto.randomUUID(),
    userId: s.userId,
    sourceAccountId: s.biz.id,
    sourceSeriesId: `gate-src-${crypto.randomUUID()}`,
    targetAccountId: s.primary.id,
    targetSeriesId,
    fingerprint: "fp",
  });
  return targetSeriesId;
}

it("runFullSync makes no Google call and writes no sync_logs row when the owner is mailmcp", async () => {
  await setOwner("mailmcp");
  await runFullSync(env, s.userId);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(await logCount(s.userId)).toBe(0);
});

it("runFullSync does the same when the owner row is missing", async () => {
  await env.DB.prepare("DELETE FROM engine_state WHERE key = 'engine_owner'").run();
  await runFullSync(env, s.userId);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(await logCount(s.userId)).toBe(0);
});

it("the rollback batch deletes nothing when the owner is mailmcp", async () => {
  const targetSeriesId = await seedMapping();
  await setOwner("mailmcp");
  fetchSpy.mockClear();
  const before = await countSeriesMappingsForUser(env.DB, s.userId);
  expect(before).toBeGreaterThan(0);
  expect(await runSeriesRollbackBatch(env, s.userId)).toEqual({ removed: 0, remaining: before });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mock.deletes.filter((d) => d.eventId === targetSeriesId)).toHaveLength(0);
  expect(await countSeriesMappingsForUser(env.DB, s.userId)).toBe(before);
});

it("the rollback batch deletes nothing when the owner row is missing", async () => {
  await seedMapping();
  await env.DB.prepare("DELETE FROM engine_state WHERE key = 'engine_owner'").run();
  const before = await countSeriesMappingsForUser(env.DB, s.userId);
  expect(before).toBeGreaterThan(0);
  expect(await runSeriesRollbackBatch(env, s.userId)).toEqual({ removed: 0, remaining: before });
  expect(mock.deletes).toHaveLength(0);
  expect(await countSeriesMappingsForUser(env.DB, s.userId)).toBe(before);
});

it("the rollback batch still deletes when the owner is cal (positive control)", async () => {
  const targetSeriesId = await seedMapping();
  const before = await countSeriesMappingsForUser(env.DB, s.userId);
  expect(before).toBeGreaterThan(0);
  expect(await runSeriesRollbackBatch(env, s.userId)).toEqual({ removed: before, remaining: 0 });
  expect(mock.deletes.filter((d) => d.eventId === targetSeriesId)).toHaveLength(1);
});

async function fireTick(name: string): Promise<number | null> {
  const stub = env.SYNC_SCHEDULER.getByName(name);
  await stub.ensure();
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  return runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
}

it("a tick re-arms the alarm and syncs nobody when the owner is mailmcp", async () => {
  await setOwner("mailmcp");
  fetchSpy.mockClear();
  const alarm = await fireTick("gate-off");
  expect(alarm! % 600_000).toBe(0);
  expect(alarm!).toBeGreaterThan(Date.now());
  expect(await logCount(s.userId)).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("a tick syncs when the owner is cal (positive control)", async () => {
  await fireTick("gate-on");
  expect(await logCount(s.userId)).toBe(1);
});

it("flipping back to cal resumes on the next run", async () => {
  await setOwner("mailmcp");
  await runFullSync(env, s.userId);
  await setOwner("cal");
  await runFullSync(env, s.userId);
  expect(await logCount(s.userId)).toBe(1);
});

it("runFullSync syncs when the owner is cal (positive control)", async () => {
  await runFullSync(env, s.userId);
  expect(fetchSpy).toHaveBeenCalled();
  expect(await logCount(s.userId)).toBe(1);
});
