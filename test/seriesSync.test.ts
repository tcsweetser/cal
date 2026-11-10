// End-to-end series replication through runFullSync, one test per row of the
// design spec's observed-behaviour table (spike, 2026-11-10), plus the window
// removal and the plan's Review Focus 1 and 5.
import { env } from "cloudflare:workers";
import { it, expect, beforeEach, type Mock } from "vitest";
import { runFullSync } from "../src/services/syncEngine";
import { findEventMappingsBySource } from "../src/db/schema";
import { getExceptionFingerprint, listSeriesMappingsForSource } from "../src/db/seriesSchema";
import { exceptionFingerprint, seriesFingerprint } from "../src/services/recurrence";
import type { GoogleCalendarEvent } from "../src/services/googleCalendar";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { meteredDb } from "./helpers/meteredD1";
import {
  WEEKLY,
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
let tokenSeq = 0;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  fetchSpy = mock.install() as unknown as Mock;
});

// One tick in which biz's LIST returns `events`.
async function syncBiz(s: SeriesSetup, events: GoogleCalendarEvent[]): Promise<void> {
  mock.queueList("tok-biz", { events, nextSyncToken: `biz-token-${++tokenSeq}` });
  await runFullSync(env, s.userId);
}

function clearRecordedWrites(): void {
  mock.inserts.length = 0;
  mock.patches.length = 0;
  mock.deletes.length = 0;
}

// "METHOD path" of every Google write so far, in order.
function googleWrites(): string[] {
  return fetchSpy.mock.calls
    .map(([input, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${new URL(String(input)).pathname}`)
    .filter((c) => c.includes("/calendar/v3/") && !c.startsWith("GET"));
}

// target account id -> replica series id
async function replicaSeriesIds(s: SeriesSetup, seriesId: string): Promise<Map<string, string>> {
  const mappings = await listSeriesMappingsForSource(env.DB, s.biz.id, seriesId);
  return new Map(mappings.map((m) => [m.target_account_id, m.target_series_id]));
}

const DEC1 = occurrence(1);
const DEC8 = occurrence(2);

it("create series: a weekly never-ending series becomes one replica series per target", async () => {
  const s = await seriesSetup();
  const series = weeklySeries("ser-create");

  await syncBiz(s, [series]);

  expect(mock.inserts.map((i) => i.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  for (const insert of mock.inserts) {
    expect(insert.body.recurrence).toEqual(WEEKLY);
    expect(insert.body.start).toEqual(series.start);
    expect(insert.body.end).toEqual(series.end);
    expect(insert.body.summary).toBe("Busy");
  }
  const mappings = await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-create");
  expect(mappings.map((m) => m.target_account_id).sort()).toEqual([s.primary.id, s.side.id].sort());
  expect(mappings.every((m) => m.fingerprint === seriesFingerprint(series))).toBe(true);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ser-create")).toHaveLength(0);
  expect((await lastSyncLog(s.userId))?.status).toBe("success");
});

it("move one instance: the unchanged series costs nothing and the moved instance is patched", async () => {
  const s = await seriesSetup();
  const series = weeklySeries("ser-move");
  await syncBiz(s, [series]);
  const replicas = await replicaSeriesIds(s, "ser-move");
  clearRecordedWrites();

  const moved = movedInstance("ser-move", DEC1);
  await syncBiz(s, [series, moved]);

  expect(mock.inserts).toHaveLength(0);
  expect(mock.deletes).toHaveLength(0);
  expect(mock.patches.map((p) => p.eventId).sort()).toEqual(
    [...replicas.values()].map((id) => `${id}${suffixFor(DEC1)}`).sort(),
  );
  for (const patch of mock.patches) {
    expect(patch.body).toEqual({ start: moved.start, end: moved.end, status: "confirmed" });
  }
  for (const m of await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-move")) {
    expect(await getExceptionFingerprint(env.DB, m.id, DEC1)).toBe(exceptionFingerprint(moved));
  }
});

it("delete one instance: only the cancelled instance is cancelled on each replica", async () => {
  const s = await seriesSetup();
  const series = weeklySeries("ser-delone");
  const moved = movedInstance("ser-delone", DEC1);
  await syncBiz(s, [series, moved]);
  const replicas = await replicaSeriesIds(s, "ser-delone");
  clearRecordedWrites();

  // Google resends the series and the earlier moved instance with it.
  await syncBiz(s, [series, moved, cancelledInstance("ser-delone", DEC8)]);

  expect(mock.inserts).toHaveLength(0);
  expect(mock.deletes).toHaveLength(0);
  expect(mock.patches.map((p) => p.eventId).sort()).toEqual(
    [...replicas.values()].map((id) => `${id}${suffixFor(DEC8)}`).sort(),
  );
  for (const patch of mock.patches) expect(patch.body).toEqual({ status: "cancelled" });
});

it("rename the series: the resent bundle makes no write on any target", async () => {
  const s = await seriesSetup();
  const series = weeklySeries("ser-rename");
  const moved = movedInstance("ser-rename", DEC1);
  await syncBiz(s, [series, moved]);
  const writesBefore = googleWrites().length;

  await syncBiz(s, [
    { ...series, summary: "Renamed" },
    { ...moved, summary: "Renamed" },
  ]);

  expect(googleWrites()).toHaveLength(writesBefore);
  expect((await lastSyncLog(s.userId))?.status).toBe("success");
});

it("split this-and-following: the original replica series is patched once and the new half becomes a new series", async () => {
  const s = await seriesSetup();
  const series = weeklySeries("ser-split");
  const moved = movedInstance("ser-split", DEC1);
  await syncBiz(s, [series, moved]);
  const original = await replicaSeriesIds(s, "ser-split");
  clearRecordedWrites();

  const until = { ...series, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261214T135959Z"] };
  const newerHalf = weeklySeries("ser-splitnew", {
    start: { dateTime: "2026-12-15T11:00:00+10:00", timeZone: "Australia/Brisbane" },
    end: { dateTime: "2026-12-15T12:00:00+10:00", timeZone: "Australia/Brisbane" },
  });
  await syncBiz(s, [until, moved, newerHalf]);

  const seriesPatches = mock.patches.filter((p) => [...original.values()].includes(p.eventId));
  expect(seriesPatches.map((p) => p.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  for (const patch of seriesPatches) expect(patch.body.recurrence).toEqual(until.recurrence);
  // The patch cleared the exception rows, so the resent moved instance is re-applied.
  const instancePatches = mock.patches.filter((p) => !seriesPatches.includes(p));
  expect(instancePatches.map((p) => p.eventId).sort()).toEqual(
    [...original.values()].map((id) => `${id}${suffixFor(DEC1)}`).sort(),
  );
  expect(mock.inserts.map((i) => i.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  for (const insert of mock.inserts) expect(insert.body.start).toEqual(newerHalf.start);
  expect(mock.deletes).toHaveLength(0);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-splitnew")).toHaveLength(2);
});

it("delete all events from the newer half of a split: only its replicas go", async () => {
  const s = await seriesSetup();
  const until = weeklySeries("ser-older", { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261214T135959Z"] });
  const newerHalf = weeklySeries("ser-newer", {
    start: { dateTime: "2026-12-15T11:00:00+10:00", timeZone: "Australia/Brisbane" },
    end: { dateTime: "2026-12-15T12:00:00+10:00", timeZone: "Australia/Brisbane" },
  });
  await syncBiz(s, [until, newerHalf]);
  const newer = await replicaSeriesIds(s, "ser-newer");
  clearRecordedWrites();

  await syncBiz(s, [{ id: "ser-newer", status: "cancelled" }]);

  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual([...newer.values()].sort());
  expect(mock.inserts).toHaveLength(0);
  expect(mock.patches).toHaveLength(0);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-newer")).toHaveLength(0);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-older")).toHaveLength(2);
});

it("series time change with a moved instance: the replica series is patched, its exception rows cleared, and the old exception's stub touches no live instance", async () => {
  const s = await seriesSetup();
  const series = weeklySeries("ser-retime");
  const moved = movedInstance("ser-retime", DEC1);
  await syncBiz(s, [series, moved]);
  const replicas = await replicaSeriesIds(s, "ser-retime");
  clearRecordedWrites();

  const retimed = {
    ...series,
    start: { dateTime: "2026-11-24T11:00:00+10:00", timeZone: "Australia/Brisbane" },
    end: { dateTime: "2026-11-24T12:00:00+10:00", timeZone: "Australia/Brisbane" },
  };
  // Google discarded the moved instance and reports it as a bare stub.
  const stub = cancelledInstance("ser-retime", DEC1);
  await syncBiz(s, [stub, retimed]);

  const seriesPatches = mock.patches.filter((p) => [...replicas.values()].includes(p.eventId));
  expect(seriesPatches).toHaveLength(2);
  for (const patch of seriesPatches) expect(patch.body.start).toEqual(retimed.start);
  // After the series patch the replica's instances carry new ids (11:00 Brisbane
  // = 01:00Z), so the stub's cancel can only reach the discarded old id.
  const stubPatches = mock.patches.filter((p) => !seriesPatches.includes(p));
  expect(stubPatches.map((p) => p.eventId).sort()).toEqual(
    [...replicas.values()].map((id) => `${id}${suffixFor(DEC1)}`).sort(),
  );
  expect(mock.patches.some((p) => p.eventId.endsWith("_20261201T010000Z"))).toBe(false);
  expect(mock.inserts).toHaveLength(0);
  expect(mock.deletes).toHaveLength(0);
  for (const m of await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-retime")) {
    expect(m.fingerprint).toBe(seriesFingerprint(retimed));
    // The moved instance's row was cleared; only the stub's is left.
    expect(await getExceptionFingerprint(env.DB, m.id, DEC1)).toBe(exceptionFingerprint(stub));
  }
});

it("a single event 90 days out replicates immediately", async () => {
  const s = await seriesSetup();
  await syncBiz(s, []);
  // The full fetch has no far edge.
  expect(mock.listRequests.length).toBeGreaterThan(0);
  for (const params of mock.listRequests) {
    expect(params.get("timeMin")).not.toBeNull();
    expect(params.get("timeMax")).toBeNull();
    expect(params.get("singleEvents")).toBe("false");
  }

  await syncBiz(s, [
    {
      id: "ev-90-days-out",
      status: "confirmed",
      transparency: "opaque",
      start: { dateTime: hoursFromNow(90 * 24) },
      end: { dateTime: hoursFromNow(90 * 24 + 1) },
    },
  ]);

  expect(mock.inserts.map((i) => i.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ev-90-days-out")).toHaveLength(2);
});

it("a replica series and its bare cancelled stubs in a target's own delta are ignored", async () => {
  const s = await seriesSetup();
  await syncBiz(s, [weeklySeries("ser-loop")]);
  const replicaOnPrimary = (await replicaSeriesIds(s, "ser-loop")).get(s.primary.id)!;
  const marker = {
    private: {
      syncEngine: "cf-cal-replication",
      originAccountId: s.biz.id,
      originEventId: "ser-loop",
      syncGroupId: s.userId,
    },
  };
  const writesBefore = googleWrites().length;

  // Primary's own delta reports the replica series, a moved replica instance
  // (the marker is inherited), and a cancelled replica instance without it.
  mock.queueList("tok-primary", {
    events: [
      weeklySeries(replicaOnPrimary, { summary: "Busy", extendedProperties: marker }),
      movedInstance(replicaOnPrimary, DEC1, 5, { summary: "Busy", extendedProperties: marker }),
      cancelledInstance(replicaOnPrimary, DEC8),
      cancelledInstance(replicaOnPrimary, occurrence(3)),
      cancelledInstance(replicaOnPrimary, occurrence(4)),
    ],
    nextSyncToken: "primary-token-loop",
  });
  const metered = meteredDb(env.DB);
  await runFullSync({ ...env, DB: metered.db }, s.userId);

  expect(metered.calls.some((c) => c.sql.includes("INSERT INTO sync_queue"))).toBe(false);
  // One replica-series lookup for all three stubs of the same series.
  expect(metered.calls.filter((c) => c.sql.includes("WHERE target_account_id = ? AND target_series_id = ?"))).toHaveLength(1);
  expect(googleWrites()).toHaveLength(writesBefore);
  expect(await listSeriesMappingsForSource(env.DB, s.primary.id, replicaOnPrimary)).toHaveLength(0);
  expect(await queuedCount(s.primary.id)).toBe(0);
});

it("a series with 60 past exceptions drains over several runs, series first, with no exception patched twice", async () => {
  const s = await seriesSetup();
  const firstUtc = "2025-06-02T23:00:00.000Z"; // a Tuesday 09:00 Brisbane, long past
  const series = weeklySeries("ser-backlog", {
    start: { dateTime: "2025-06-03T09:00:00+10:00", timeZone: "Australia/Brisbane" },
    end: { dateTime: "2025-06-03T10:00:00+10:00", timeZone: "Australia/Brisbane" },
  });
  const exceptions = Array.from({ length: 60 }, (_, n) => movedInstance("ser-backlog", occurrence(n, firstUtc), 2));
  // Google listed the series after some of its exceptions.
  mock.queueList("tok-biz", {
    events: [...exceptions.slice(0, 10), series, ...exceptions.slice(10)],
    nextSyncToken: "biz-token-backlog",
  });

  let runs = 0;
  do {
    await runFullSync(env, s.userId);
    runs++;
  } while ((await queuedCount(s.biz.id)) > 0 && runs < 10);

  expect(runs).toBeGreaterThanOrEqual(3);
  expect(await queuedCount(s.biz.id)).toBe(0);
  const writes = googleWrites();
  expect(writes.slice(0, 2).every((w) => w.startsWith("POST"))).toBe(true);
  expect(mock.inserts).toHaveLength(2);
  expect(mock.patches).toHaveLength(120);
  expect(new Set(mock.patches.map((p) => `${p.accessToken} ${p.eventId}`)).size).toBe(120);
  const promoted = await env.DB.prepare("SELECT sync_token FROM sync_tokens WHERE user_id = ? AND account_id = ?")
    .bind(s.userId, s.biz.id)
    .first<{ sync_token: string }>();
  expect(promoted?.sync_token).toBe("biz-token-backlog");
}, 30000);

it("a recurring series that becomes 'does not repeat' loses its replica series once the single replicates", async () => {
  const s = await seriesSetup();
  await syncBiz(s, [weeklySeries("ser-norepeat")]);
  const replicas = await replicaSeriesIds(s, "ser-norepeat");
  const writesBefore = googleWrites().length;
  clearRecordedWrites();

  await syncBiz(s, [
    {
      id: "ser-norepeat",
      status: "confirmed",
      transparency: "opaque",
      start: { dateTime: hoursFromNow(2) },
      end: { dateTime: hoursFromNow(3) },
    },
  ]);

  expect(mock.inserts).toHaveLength(2);
  for (const insert of mock.inserts) expect(insert.body.recurrence).toBeUndefined();
  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual([...replicas.values()].sort());
  // Replaced before removed, so the slot is never free on a target.
  expect(googleWrites().slice(writesBefore).map((w) => w.split(" ")[0])).toEqual(["POST", "POST", "DELETE", "DELETE"]);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-norepeat")).toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ser-norepeat")).toHaveLength(2);
});
