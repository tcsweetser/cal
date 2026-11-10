// Series sync edge cases through runFullSync: queue order, whole-series
// deletes, and 410 recovery. The spike-table rows are in seriesSync.test.ts.
import { env } from "cloudflare:workers";
import { it, expect, beforeEach } from "vitest";
import { runFullSync } from "../src/services/syncEngine";
import { createEventMapping, findEventMappingsBySource, findEventMappingsForSeriesInstances } from "../src/db/schema";
import { listSeriesMappingsForSource } from "../src/db/seriesSchema";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { meteredDb } from "./helpers/meteredD1";
import {
  lastSyncLog,
  movedInstance,
  occurrence,
  queuedCount,
  seriesSetup,
  suffixFor,
  weeklySeries,
  type SeriesSetup,
} from "./helpers/seriesEvents";

let mock: GoogleCalendarMock;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  mock.install();
});

async function seedSingleMapping(s: SeriesSetup, sourceEventId: string, targetEventId: string): Promise<void> {
  await createEventMapping(env.DB, {
    id: crypto.randomUUID(),
    userId: s.userId,
    sourceAccountId: s.biz.id,
    sourceEventId,
    targetAccountId: s.primary.id,
    targetEventId,
  });
}

it("one fetch listing exceptions before their series still replicates both in one run", async () => {
  const s = await seriesSetup();
  const series = weeklySeries("ser-order");
  const moved = movedInstance("ser-order", occurrence(1));
  const alsoMoved = movedInstance("ser-order", occurrence(2));

  mock.queueList("tok-biz", { events: [moved, alsoMoved, series], nextSyncToken: "biz-token-order" });
  await runFullSync(env, s.userId);

  expect(mock.inserts).toHaveLength(2);
  const replicas = (await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-order")).map((m) => m.target_series_id);
  expect(mock.patches.map((p) => p.eventId).sort()).toEqual(
    replicas.flatMap((id) => [`${id}${suffixFor(occurrence(1))}`, `${id}${suffixFor(occurrence(2))}`]).sort(),
  );
  expect(await findEventMappingsBySource(env.DB, s.biz.id, moved.id)).toHaveLength(0);
  expect(await queuedCount(s.biz.id)).toBe(0);
  expect((await lastSyncLog(s.userId))?.status).toBe("success");
});

it("a whole-series delete that arrives as only the cancelled series removes the singles made from its exceptions", async () => {
  const s = await seriesSetup();
  // A free series has no replica series; its busy instance is replicated as a single.
  const series = weeklySeries("ser-wholedel", { transparency: "transparent" });
  const busy = movedInstance("ser-wholedel", occurrence(1));
  mock.queueList("tok-biz", { events: [series, busy], nextSyncToken: "biz-token-wd1" });
  await runFullSync(env, s.userId);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, busy.id)).toHaveLength(2);
  // A legacy per-instance replica from before series replication.
  const legacyId = `ser-wholedel${suffixFor(occurrence(0))}`;
  await seedSingleMapping(s, legacyId, "legacy-replica");
  // Another series whose id shares the prefix is left alone.
  await seedSingleMapping(s, `ser-wholedelx${suffixFor(occurrence(0))}`, "other-series-replica");
  const singleIds = (await findEventMappingsBySource(env.DB, s.biz.id, busy.id)).map((m) => m.target_event_id);

  mock.queueList("tok-biz", { events: [{ id: "ser-wholedel", status: "cancelled" }], nextSyncToken: "biz-token-wd2" });
  await runFullSync(env, s.userId);

  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual([...singleIds, "legacy-replica"].sort());
  expect(await findEventMappingsBySource(env.DB, s.biz.id, busy.id)).toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, legacyId)).toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, `ser-wholedelx${suffixFor(occurrence(0))}`)).toHaveLength(1);
  expect((await lastSyncLog(s.userId))?.status).toBe("success");
});

it("instance mappings of a series are found by an indexed range, without reading other mappings", async () => {
  const s = await seriesSetup();
  for (let i = 0; i < 100; i++) await seedSingleMapping(s, `other-${i}`, `other-replica-${i}`);
  await seedSingleMapping(s, "ser-range", "the-series-id-itself");
  await seedSingleMapping(s, "ser-rangex_20261124", "prefix-collision");
  await seedSingleMapping(s, "ser-range_", "bare-underscore");
  for (let n = 0; n < 3; n++) await seedSingleMapping(s, `ser-range${suffixFor(occurrence(n))}`, `instance-${n}`);
  const metered = meteredDb(env.DB);

  const found = await findEventMappingsForSeriesInstances(metered.db, s.biz.id, "ser-range");

  expect(found.map((m) => m.target_event_id).sort()).toEqual(["bare-underscore", "instance-0", "instance-1", "instance-2"]);
  expect(metered.calls).toHaveLength(1);
  expect(metered.calls[0]!.rowsRead).toBeLessThanOrEqual(5);
});

it("410 recovery removes the replica series of a series deleted while the token was stale", async () => {
  const s = await seriesSetup();
  mock.queueList("tok-biz", {
    events: [weeklySeries("ser-gone410"), weeklySeries("ser-alive410")],
    nextSyncToken: "biz-token-410a",
  });
  await runFullSync(env, s.userId);
  const goneReplicas = (await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-gone410")).map((m) => m.target_series_id);
  expect(goneReplicas).toHaveLength(2);

  // The refetch omits the deleted series instead of reporting it cancelled.
  mock.queueList("tok-biz", "410");
  mock.queueList("tok-biz", { events: [weeklySeries("ser-alive410")], nextSyncToken: "biz-token-410b" });
  mock.setEventExists("ser-gone410", false);
  mock.setEventExists("ser-alive410", true);
  await runFullSync(env, s.userId);

  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual(goneReplicas.sort());
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-gone410")).toHaveLength(0);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-alive410")).toHaveLength(2);
  expect((await lastSyncLog(s.userId))?.status).toBe("success");
});
