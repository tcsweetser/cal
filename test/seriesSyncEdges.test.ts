// Series sync edge cases through runFullSync: queue order, whole-series
// deletes, and 410 recovery. The spike-table rows are in seriesSync.test.ts.
import { env } from "cloudflare:workers";
import { it, expect, beforeEach, type Mock } from "vitest";
import { runFullSync } from "../src/services/syncEngine";
import { createEventMapping, findEventMappingsBySource, findEventMappingsForSeriesInstances } from "../src/db/schema";
import { createSeriesMapping, listSeriesMappingsForSource, upsertExceptionFingerprint } from "../src/db/seriesSchema";
import { exceptionFingerprint, seriesFingerprint } from "../src/services/recurrence";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { meteredDb } from "./helpers/meteredD1";
import {
  cancelledInstance,
  hoursFromNow,
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
let fetchSpy: Mock;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  fetchSpy = mock.install() as unknown as Mock;
});

// "METHOD path" of every Google request so far, in order.
function googleCalls(): string[] {
  return fetchSpy.mock.calls
    .map(([input, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${new URL(String(input)).pathname}`)
    .filter((c) => c.includes("/calendar/v3/"));
}

const LIST = "GET /calendar/v3/calendars/primary/events";

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

it("an unchanged resend of a 100-exception bundle drains 60 items a run with no Google writes and bounded D1 calls", async () => {
  const s = await seriesSetup();
  const series = weeklySeries("ser-resend100");
  const exceptions = Array.from({ length: 100 }, (_, n) => movedInstance("ser-resend100", occurrence(n)));
  // Already replicated: each target has the series and every exception's fingerprint.
  for (const target of [s.primary, s.side]) {
    const id = crypto.randomUUID();
    await createSeriesMapping(env.DB, {
      id,
      userId: s.userId,
      sourceAccountId: s.biz.id,
      sourceSeriesId: "ser-resend100",
      targetAccountId: target.id,
      targetSeriesId: `replica-on-${target.accessToken}`,
      fingerprint: seriesFingerprint(series),
    });
    for (const e of exceptions) {
      await upsertExceptionFingerprint(env.DB, id, e.originalStartTime!.dateTime!, exceptionFingerprint(e));
    }
  }
  // A rename resends the whole bundle.
  mock.queueList("tok-biz", { events: [series, ...exceptions], nextSyncToken: "biz-token-resend" });
  const metered = meteredDb(env.DB);

  await runFullSync({ ...env, DB: metered.db }, s.userId);

  expect(await queuedCount(s.biz.id)).toBe(101 - 60);
  expect(googleCalls().every((c) => c === LIST)).toBe(true);
  expect(metered.calls.length).toBeLessThanOrEqual(800);

  await runFullSync(env, s.userId);

  expect(await queuedCount(s.biz.id)).toBe(0);
  expect(googleCalls().every((c) => c === LIST)).toBe(true);
  expect((await lastSyncLog(s.userId))?.status).toBe("success");
}, 30000);

it("a 410 recovery stops reconciling at the first failed check", async () => {
  const s = await seriesSetup();
  for (const seriesId of ["ser-r20a", "ser-r20b"]) {
    await createSeriesMapping(env.DB, {
      id: crypto.randomUUID(),
      userId: s.userId,
      sourceAccountId: s.biz.id,
      sourceSeriesId: seriesId,
      targetAccountId: s.primary.id,
      targetSeriesId: `replica-${seriesId}`,
      fingerprint: "fp",
    });
  }
  await seedSingleMapping(s, "ev-r20", "replica-ev-r20");
  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-r20a" });
  await runFullSync(env, s.userId);

  mock.queueList("tok-biz", "410");
  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-r20b" });
  mock.failGets(500);
  const callsBefore = googleCalls().length;
  await runFullSync(env, s.userId);

  const after = googleCalls().slice(callsBefore).filter((c) => c !== LIST);
  // One getEvent (googleFetch retries a 500 in place), then nothing more.
  expect(new Set(after)).toEqual(new Set(["GET /calendar/v3/calendars/primary/events/ser-r20a"]));
  expect(mock.inserts).toHaveLength(0);
  expect(mock.patches).toHaveLength(0);
  expect(mock.deletes).toHaveLength(0);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-r20b")).toHaveLength(1);
}, 15000);

// --- The past bound (hasEnded) ---

it("an ended single is not queued", async () => {
  const s = await seriesSetup();
  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-ended1" });
  await runFullSync(env, s.userId);
  mock.queueList("tok-biz", {
    events: [
      { id: "ev-ended", status: "confirmed", start: { dateTime: hoursFromNow(-3) }, end: { dateTime: hoursFromNow(-2) } },
    ],
    nextSyncToken: "biz-token-ended2",
  });
  const metered = meteredDb(env.DB);

  await runFullSync({ ...env, DB: metered.db }, s.userId);

  expect(metered.calls.some((c) => c.sql.includes("INSERT INTO sync_queue"))).toBe(false);
  expect(mock.inserts).toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ev-ended")).toHaveLength(0);
});

it("an ended cancelled single is queued and deletes its replicas", async () => {
  const s = await seriesSetup();
  await seedSingleMapping(s, "ev-ended-cancel", "replica-ended-cancel");
  mock.queueList("tok-biz", {
    events: [
      {
        id: "ev-ended-cancel",
        status: "cancelled",
        start: { dateTime: hoursFromNow(-3) },
        end: { dateTime: hoursFromNow(-2) },
      },
    ],
    nextSyncToken: "biz-token-endedcancel",
  });

  await runFullSync(env, s.userId);

  expect(mock.deletes.map((d) => d.eventId)).toEqual(["replica-ended-cancel"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ev-ended-cancel")).toHaveLength(0);
});

it("an ended series and an ended exception are queued", async () => {
  const s = await seriesSetup();
  const firstUtc = "2025-06-02T23:00:00.000Z";
  const series = weeklySeries("ser-ended", {
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20250630T135959Z"],
    start: { dateTime: "2025-06-03T09:00:00+10:00", timeZone: "Australia/Brisbane" },
    end: { dateTime: "2025-06-03T10:00:00+10:00", timeZone: "Australia/Brisbane" },
  });
  const moved = movedInstance("ser-ended", occurrence(1, firstUtc));
  mock.queueList("tok-biz", { events: [series, moved], nextSyncToken: "biz-token-endedseries" });

  await runFullSync(env, s.userId);

  expect(mock.inserts.map((i) => i.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  const replicas = (await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-ended")).map((m) => m.target_series_id);
  expect(mock.patches.map((p) => p.eventId).sort()).toEqual(
    replicas.map((id) => `${id}${suffixFor(occurrence(1, firstUtc))}`).sort(),
  );
});

it("an ended single with series mappings loses its replica series and gets no single replica", async () => {
  const s = await seriesSetup();
  mock.queueList("tok-biz", { events: [weeklySeries("ser-pastsingle")], nextSyncToken: "biz-token-ps1" });
  await runFullSync(env, s.userId);
  const replicas = (await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-pastsingle")).map((m) => m.target_series_id);
  mock.inserts.length = 0;

  // "Does not repeat", and the one remaining occurrence is already over.
  mock.queueList("tok-biz", {
    events: [
      {
        id: "ser-pastsingle",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(-3) },
        end: { dateTime: hoursFromNow(-2) },
      },
    ],
    nextSyncToken: "biz-token-ps2",
  });
  await runFullSync(env, s.userId);

  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual(replicas.sort());
  expect(mock.inserts).toHaveLength(0);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-pastsingle")).toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ser-pastsingle")).toHaveLength(0);
});

// --- Queue order across kinds ---

it("a series made \"does not repeat\" drains as a single before its old exceptions, so they never wait on it", async () => {
  const s = await seriesSetup();
  // Free, so it has no replica series on any target.
  mock.queueList("tok-biz", {
    events: [weeklySeries("ser-conv", { transparency: "transparent" })],
    nextSyncToken: "biz-token-conv1",
  });
  await runFullSync(env, s.userId);
  expect(mock.inserts).toHaveLength(0);
  // A busy instance replicated as a single while the series was free.
  const cancelled = cancelledInstance("ser-conv", occurrence(1));
  await seedSingleMapping(s, cancelled.id, "instance-single");

  // Same id, now a busy single, plus one cancelled instance of the old series.
  mock.queueList("tok-biz", {
    events: [
      cancelled,
      {
        id: "ser-conv",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(24) },
        end: { dateTime: hoursFromNow(25) },
      },
    ],
    nextSyncToken: "biz-token-conv2",
  });
  await runFullSync(env, s.userId);

  expect(mock.inserts.map((i) => i.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  for (const insert of mock.inserts) expect(insert.body.recurrence).toBeUndefined();
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ser-conv")).toHaveLength(2);
  // The cancelled instance falls through to the single path and removes its replica.
  expect(mock.deletes.map((d) => d.eventId)).toEqual(["instance-single"]);
  expect(await queuedCount(s.biz.id)).toBe(0);
  expect(await lastSyncLog(s.userId)).toEqual({ status: "success", message: null });
});
