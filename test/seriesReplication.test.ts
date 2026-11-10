import { env } from "cloudflare:workers";
import { it, expect, beforeEach, type Mock } from "vitest";
import { createEventMapping, enqueueEvents, findEventMappingsBySource, listAccountsForUser } from "../src/db/schema";
import {
  findSeriesMapping,
  getExceptionFingerprint,
  listSeriesMappingsForSource,
  upsertExceptionFingerprint,
} from "../src/db/seriesSchema";
import { exceptionFingerprint, seriesFingerprint } from "../src/services/recurrence";
import { CallBudget, MAX_CALENDAR_API_CALLS_PER_RUN, TokenCache } from "../src/services/syncShared";
import { processException, processSeries, type ReplicationContext } from "../src/services/seriesReplication";
import type { GoogleCalendarEvent } from "../src/services/googleCalendar";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { createTestUser, createTestAccount, type TestAccount } from "./helpers/fixtures";

const WEEKLY = ["RRULE:FREQ=WEEKLY;BYDAY=TU"];

function weeklySeries(id: string, overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id,
    status: "confirmed",
    summary: "Team sync",
    transparency: "opaque",
    recurrence: WEEKLY,
    start: { dateTime: "2026-11-24T09:00:00+10:00", timeZone: "Australia/Brisbane" },
    end: { dateTime: "2026-11-24T10:00:00+10:00", timeZone: "Australia/Brisbane" },
    ...overrides,
  };
}

interface Setup {
  userId: string;
  primary: TestAccount;
  biz: TestAccount;
  side: TestAccount;
}

async function setup(): Promise<Setup> {
  const userId = await createTestUser();
  const primary = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });
  const side = await createTestAccount(userId, "secondary", {
    email: "side@example.com",
    tag: "side_hustle",
    accessToken: "tok-side",
  });
  return { userId, primary, biz, side };
}

async function context(
  s: Setup,
  sourceId: string,
  budget = new CallBudget(MAX_CALENDAR_API_CALLS_PER_RUN),
): Promise<ReplicationContext> {
  const allAccounts = await listAccountsForUser(env.DB, s.userId);
  const source = allAccounts.find((a) => a.id === sourceId)!;
  return { env, tokens: new TokenCache(env), budget, userId: s.userId, source, allAccounts };
}

let mock: GoogleCalendarMock;
let fetchSpy: Mock;

// "METHOD path" of every Google request so far, in order.
function googleCalls(): string[] {
  return fetchSpy.mock.calls
    .map(([input, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${new URL(String(input)).pathname}`)
    .filter((c) => c.includes("/calendar/v3/"));
}

beforeEach(() => {
  mock = new GoogleCalendarMock();
  fetchSpy = mock.install() as unknown as Mock;
});

it("a new series from a secondary becomes one replica series on each other account", async () => {
  const s = await setup();
  const event = weeklySeries("ser-new");

  const result = await processSeries(await context(s, s.biz.id), event);

  expect(result.processed).toBe(2);
  expect(mock.inserts).toHaveLength(2);
  expect(mock.inserts.map((i) => i.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  for (const insert of mock.inserts) {
    expect(insert.body.recurrence).toEqual(WEEKLY);
    expect((insert.body.start as { timeZone?: string }).timeZone).toBe("Australia/Brisbane");
    expect((insert.body.end as { timeZone?: string }).timeZone).toBe("Australia/Brisbane");
    expect(insert.body.summary).toBe("Busy");
  }
  const mappings = await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-new");
  expect(mappings.map((m) => m.target_account_id).sort()).toEqual([s.primary.id, s.side.id].sort());
  expect(mappings.every((m) => m.fingerprint === seriesFingerprint(event))).toBe(true);
  expect(mappings.map((m) => m.target_series_id).sort()).toEqual(["mock-event-1", "mock-event-2"]);
});

it("a resent unchanged series, or a rename, makes no Google call", async () => {
  const s = await setup();
  const event = weeklySeries("ser-resend");
  await processSeries(await context(s, s.biz.id), event);
  const callsBefore = googleCalls().length;

  const resend = await processSeries(await context(s, s.biz.id), event);
  const rename = await processSeries(await context(s, s.biz.id), { ...event, summary: "Renamed" });

  expect(googleCalls().length).toBe(callsBefore);
  expect(resend.processed).toBe(0);
  expect(rename.processed).toBe(0);
  expect(mock.inserts).toHaveLength(2);
  expect(mock.patches).toHaveLength(0);
});

it("a changed rule patches each replica series and clears its exception rows", async () => {
  const s = await setup();
  const event = weeklySeries("ser-split");
  await processSeries(await context(s, s.biz.id), event);
  const before = await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-split");
  for (const m of before) await upsertExceptionFingerprint(env.DB, m.id, "2026-12-01T09:00:00+10:00", "fp");

  const split = { ...event, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261207T135959Z"] };
  const result = await processSeries(await context(s, s.biz.id), split);

  expect(result.processed).toBe(2);
  expect(mock.inserts).toHaveLength(2);
  expect(mock.patches).toHaveLength(2);
  expect(mock.patches.map((p) => p.eventId).sort()).toEqual(before.map((m) => m.target_series_id).sort());
  for (const patch of mock.patches) expect(patch.body.recurrence).toEqual(split.recurrence);
  for (const m of before) {
    expect(await getExceptionFingerprint(env.DB, m.id, "2026-12-01T09:00:00+10:00")).toBeNull();
    const after = await findSeriesMapping(env.DB, s.biz.id, "ser-split", m.target_account_id);
    expect(after!.fingerprint).toBe(seriesFingerprint(split));
  }
});

it("a cancelled or free series deletes its replica series and mappings", async () => {
  const s = await setup();
  const cancelled = weeklySeries("ser-cancel");
  const free = weeklySeries("ser-free");
  await processSeries(await context(s, s.biz.id), cancelled);
  await processSeries(await context(s, s.biz.id), free);
  const cancelledMappings = await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-cancel");
  const freeMappings = await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-free");
  for (const m of cancelledMappings) await upsertExceptionFingerprint(env.DB, m.id, "2026-12-01T09:00:00+10:00", "fp");

  const r1 = await processSeries(await context(s, s.biz.id), { ...cancelled, status: "cancelled" });
  const r2 = await processSeries(await context(s, s.biz.id), { ...free, transparency: "transparent" });

  expect(r1).toMatchObject({ processed: 2, errors: [], retryLater: false });
  expect(r2).toMatchObject({ processed: 2, errors: [], retryLater: false });
  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual(
    [...cancelledMappings, ...freeMappings].map((m) => m.target_series_id).sort(),
  );
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-cancel")).toHaveLength(0);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-free")).toHaveLength(0);
  for (const m of cancelledMappings) {
    expect(await getExceptionFingerprint(env.DB, m.id, "2026-12-01T09:00:00+10:00")).toBeNull();
  }
});

it("a series with no time zone takes the source calendar's", async () => {
  const s = await setup();
  mock.setCalendarTimeZone("tok-biz", "Pacific/Auckland");
  const event = weeklySeries("ser-nozone", {
    start: { dateTime: "2026-11-24T09:00:00+13:00" },
    end: { dateTime: "2026-11-24T10:00:00+13:00" },
  });
  const snapshot = structuredClone(event);
  const ctx = await context(s, s.biz.id);

  await processSeries(ctx, event);

  expect(mock.inserts).toHaveLength(2);
  for (const insert of mock.inserts) {
    expect(insert.body.start).toEqual({ dateTime: "2026-11-24T09:00:00+13:00", timeZone: "Pacific/Auckland" });
    expect(insert.body.end).toEqual({ dateTime: "2026-11-24T10:00:00+13:00", timeZone: "Pacific/Auckland" });
  }
  // One calendar lookup plus two inserts.
  expect(ctx.budget.remaining).toBe(MAX_CALENDAR_API_CALLS_PER_RUN - 3);
  expect(event).toEqual(snapshot);
  // Fingerprinted as received, so a resend matches and costs nothing.
  const mappings = await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-nozone");
  expect(mappings.every((m) => m.fingerprint === seriesFingerprint(snapshot))).toBe(true);
  const callsBefore = googleCalls().length;
  await processSeries(await context(s, s.biz.id), event);
  expect(googleCalls().length).toBe(callsBefore);
});

it("an all-day series needs no time zone lookup", async () => {
  const s = await setup();
  const event = weeklySeries("ser-allday", { start: { date: "2026-11-24" }, end: { date: "2026-11-25" } });
  const ctx = await context(s, s.biz.id);

  await processSeries(ctx, event);

  expect(ctx.budget.remaining).toBe(MAX_CALENDAR_API_CALLS_PER_RUN - 2);
  for (const insert of mock.inserts) expect(insert.body.start).toEqual({ date: "2026-11-24" });
});

async function singleReplicasOf(s: Setup, sourceEventId: string, targets: TestAccount[]): Promise<void> {
  for (const target of targets) {
    await createEventMapping(env.DB, {
      id: crypto.randomUUID(),
      userId: s.userId,
      sourceAccountId: s.biz.id,
      sourceEventId,
      targetAccountId: target.id,
      targetEventId: `single-replica-${target.accessToken}`,
    });
  }
}

it("a single event that becomes a series loses its single replicas once the series replaces them", async () => {
  const s = await setup();
  await singleReplicasOf(s, "ev-converted", [s.primary, s.side]);

  const result = await processSeries(await context(s, s.biz.id), weeklySeries("ev-converted"));

  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual(["single-replica-tok-primary", "single-replica-tok-side"]);
  expect(mock.inserts).toHaveLength(2);
  const calls = googleCalls().filter((c) => !c.startsWith("GET"));
  expect(calls.map((c) => c.split(" ")[0])).toEqual(["POST", "POST", "DELETE", "DELETE"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ev-converted")).toHaveLength(0);
  expect(result.processed).toBe(4);
});

it("a budget cut after the series inserts keeps the singles, and the next run removes them without inserting again", async () => {
  const s = await setup();
  await singleReplicasOf(s, "ev-cut", [s.primary, s.side]);

  await processSeries(await context(s, s.biz.id, new CallBudget(2)), weeklySeries("ev-cut"));

  expect(mock.inserts).toHaveLength(2);
  expect(mock.deletes).toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ev-cut")).toHaveLength(2);

  const result = await processSeries(await context(s, s.biz.id), weeklySeries("ev-cut"));

  expect(result).toMatchObject({ processed: 2, retryLater: false });
  expect(mock.inserts).toHaveLength(2);
  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual(["single-replica-tok-primary", "single-replica-tok-side"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ev-cut")).toHaveLength(0);
});

it("a failed single replica delete after the series insert is retried without a second insert", async () => {
  const s = await setup();
  await singleReplicasOf(s, "ev-stuck", [s.primary]);
  mock.failDeletes(403);

  const result = await processSeries(await context(s, s.biz.id), weeklySeries("ev-stuck"));

  expect(result.retryLater).toBe(true);
  expect(mock.inserts).toHaveLength(2);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ev-stuck")).toHaveLength(2);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ev-stuck")).toHaveLength(1);

  mock.failDeletes(null);
  await processSeries(await context(s, s.biz.id), weeklySeries("ev-stuck"));

  expect(mock.inserts).toHaveLength(2);
  expect(mock.deletes.map((d) => d.eventId)).toEqual(["single-replica-tok-primary"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ev-stuck")).toHaveLength(0);
});

it("a budget cut between targets resumes without a second replica series", async () => {
  const s = await setup();
  const event = weeklySeries("ser-budget");

  await processSeries(await context(s, s.biz.id, new CallBudget(1)), event);
  expect(mock.inserts).toHaveLength(1);
  await processSeries(await context(s, s.biz.id, new CallBudget(MAX_CALENDAR_API_CALLS_PER_RUN)), event);

  expect(mock.inserts).toHaveLength(2);
  expect(mock.inserts.map((i) => i.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  expect(mock.patches).toHaveLength(0);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-budget")).toHaveLength(2);
});

it("a replica series deleted by hand is re-created on the next change", async () => {
  const s = await setup();
  const event = weeklySeries("ser-gone");
  await processSeries(await context(s, s.biz.id), event);
  const old = await findSeriesMapping(env.DB, s.biz.id, "ser-gone", s.primary.id);
  mock.makeNextPatchGone(old!.target_series_id);

  await processSeries(await context(s, s.biz.id), { ...event, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"] });

  expect(mock.inserts).toHaveLength(3);
  const fresh = await findSeriesMapping(env.DB, s.biz.id, "ser-gone", s.primary.id);
  expect(fresh!.target_series_id).toBe("mock-event-3");
  expect(fresh!.id).not.toBe(old!.id);
});

it("a failed replica series delete keeps the mapping for a later run", async () => {
  const s = await setup();
  const event = weeklySeries("ser-faildel");
  await processSeries(await context(s, s.biz.id), event);
  mock.failDeletes(403);

  const result = await processSeries(await context(s, s.biz.id), { ...event, status: "cancelled" });

  expect(result.retryLater).toBe(true);
  expect(result.errors).toHaveLength(2);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-faildel")).toHaveLength(2);
});

// Fails the first deleteExceptionRows run, as a transient D1 error would.
function failFirstExceptionClear(db: D1Database): D1Database {
  let failed = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== "prepare") return Reflect.get(target, prop, target);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!sql.startsWith("DELETE FROM exception_mappings")) return stmt;
        return {
          bind: (...values: unknown[]) => {
            const bound = stmt.bind(...values);
            return {
              run: () => {
                if (failed) return bound.run();
                failed = true;
                return Promise.reject(new Error("D1 transient failure"));
              },
            };
          },
        };
      };
    },
  });
}

it("a failed exception-row clear after a patch is retried on the next run", async () => {
  const s = await setup();
  const event = weeklySeries("ser-clearfail");
  await processSeries(await context(s, s.biz.id), event);
  const mapping = (await findSeriesMapping(env.DB, s.biz.id, "ser-clearfail", s.primary.id))!;
  await upsertExceptionFingerprint(env.DB, mapping.id, "2026-12-01T09:00:00+10:00", "fp");
  const changed = { ...event, start: { ...event.start, dateTime: "2026-11-24T11:00:00+10:00" } };

  const flaky = await context(s, s.biz.id);
  flaky.env = { ...env, DB: failFirstExceptionClear(env.DB) };
  await expect(processSeries(flaky, changed)).rejects.toThrow("D1 transient failure");
  expect(await getExceptionFingerprint(env.DB, mapping.id, "2026-12-01T09:00:00+10:00")).toBe("fp");

  await processSeries(await context(s, s.biz.id), changed);

  expect(await getExceptionFingerprint(env.DB, mapping.id, "2026-12-01T09:00:00+10:00")).toBeNull();
  const after = await findSeriesMapping(env.DB, s.biz.id, "ser-clearfail", s.primary.id);
  expect(after!.fingerprint).toBe(seriesFingerprint(changed));
});

// --- Exception replication ---

// 2026-12-01 09:00 Brisbane, the series' second Tuesday, in Google's instance
// id suffix format (UTC, basic).
const DEC1_START = "2026-12-01T09:00:00+10:00";
const DEC1_SUFFIX = "_20261130T230000Z";

function exceptionOf(seriesId: string, overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id: `${seriesId}${DEC1_SUFFIX}`,
    recurringEventId: seriesId,
    status: "confirmed",
    summary: "Team sync",
    transparency: "opaque",
    originalStartTime: { dateTime: DEC1_START, timeZone: "Australia/Brisbane" },
    start: { dateTime: "2026-12-01T14:00:00+10:00", timeZone: "Australia/Brisbane" },
    end: { dateTime: "2026-12-01T15:00:00+10:00", timeZone: "Australia/Brisbane" },
    ...overrides,
  };
}

// A cancelled exception carries only these fields (Google's docs).
function cancelledExceptionOf(seriesId: string): GoogleCalendarEvent {
  return {
    id: `${seriesId}${DEC1_SUFFIX}`,
    recurringEventId: seriesId,
    status: "cancelled",
    originalStartTime: { dateTime: DEC1_START, timeZone: "Australia/Brisbane" },
  };
}

async function replicateSeries(s: Setup, seriesId: string): Promise<Map<string, string>> {
  await processSeries(await context(s, s.biz.id), weeklySeries(seriesId));
  const mappings = await listSeriesMappingsForSource(env.DB, s.biz.id, seriesId);
  return new Map(mappings.map((m) => [m.target_account_id, m.target_series_id]));
}

it("a moved instance patches the matching replica instance by derived id", async () => {
  const s = await setup();
  const replicas = await replicateSeries(s, "ser-move");
  const moved = exceptionOf("ser-move");

  const result = await processException(await context(s, s.biz.id), moved);

  expect(result).toMatchObject({ processed: 2, errors: [], retryLater: false });
  expect(mock.patches.map((p) => p.eventId).sort()).toEqual(
    [...replicas.values()].map((id) => `${id}${DEC1_SUFFIX}`).sort(),
  );
  for (const patch of mock.patches) {
    expect(patch.body).toEqual({ start: moved.start, end: moved.end, status: "confirmed" });
  }
  for (const m of await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-move")) {
    expect(await getExceptionFingerprint(env.DB, m.id, DEC1_START)).toBe(exceptionFingerprint(moved));
  }
});

it("a cancelled instance cancels the replica instance", async () => {
  const s = await setup();
  const replicas = await replicateSeries(s, "ser-cancelone");

  const result = await processException(await context(s, s.biz.id), cancelledExceptionOf("ser-cancelone"));

  expect(result.processed).toBe(2);
  expect(mock.patches.map((p) => p.eventId).sort()).toEqual(
    [...replicas.values()].map((id) => `${id}${DEC1_SUFFIX}`).sort(),
  );
  for (const patch of mock.patches) expect(patch.body).toEqual({ status: "cancelled" });
  expect(mock.deletes).toHaveLength(0);
});

it("a resent unchanged exception makes no Google call", async () => {
  const s = await setup();
  await replicateSeries(s, "ser-exresend");
  const moved = exceptionOf("ser-exresend");
  await processException(await context(s, s.biz.id), moved);
  const callsBefore = googleCalls().length;

  const resend = await processException(await context(s, s.biz.id), { ...moved, summary: "Renamed" });

  expect(googleCalls().length).toBe(callsBefore);
  expect(resend.processed).toBe(0);
  expect(mock.patches).toHaveLength(2);
});

it("an exception-only delta for a mapped series still patches the replica", async () => {
  const s = await setup();
  const replicas = await replicateSeries(s, "ser-exonly");
  await processException(await context(s, s.biz.id), exceptionOf("ser-exonly"));
  mock.patches.length = 0;

  // A later delta carrying only the exception, moved again.
  const movedAgain = exceptionOf("ser-exonly", {
    start: { dateTime: "2026-12-01T16:00:00+10:00", timeZone: "Australia/Brisbane" },
    end: { dateTime: "2026-12-01T17:00:00+10:00", timeZone: "Australia/Brisbane" },
  });
  const result = await processException(await context(s, s.biz.id), movedAgain);

  expect(result.processed).toBe(2);
  expect(mock.patches.map((p) => p.eventId).sort()).toEqual(
    [...replicas.values()].map((id) => `${id}${DEC1_SUFFIX}`).sort(),
  );
  for (const patch of mock.patches) expect(patch.body.start).toEqual(movedAgain.start);
});

it("an exception waits while its series is still queued", async () => {
  const s = await setup();
  await enqueueEvents(env.DB, s.userId, s.biz.id, [
    { id: "ser-queued", json: JSON.stringify(weeklySeries("ser-queued")) },
  ]);

  const result = await processException(await context(s, s.biz.id), exceptionOf("ser-queued"));

  expect(result.retryLater).toBe(true);
  expect(googleCalls()).toHaveLength(0);
});

it("an exception whose series has no replica is treated as a single event", async () => {
  const s = await setup();
  // A free series has no replica series; its busy exception still blocks time.
  const busy = exceptionOf("ser-freeseries");

  const result = await processException(await context(s, s.biz.id), busy);

  expect(result.processed).toBe(2);
  expect(mock.inserts).toHaveLength(2);
  expect(mock.inserts.map((i) => i.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  for (const insert of mock.inserts) {
    expect(insert.body.start).toEqual(busy.start);
    expect(insert.body.recurrence).toBeUndefined();
  }
  expect(await findEventMappingsBySource(env.DB, s.biz.id, busy.id)).toHaveLength(2);

  // Cancelling it removes those single replicas.
  const removal = await processException(await context(s, s.biz.id), cancelledExceptionOf("ser-freeseries"));

  expect(removal.processed).toBe(2);
  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual(["mock-event-1", "mock-event-2"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, busy.id)).toHaveLength(0);
});

it("a free instance on a busy series frees the replica slot, and restores it when busy again", async () => {
  const s = await setup();
  await replicateSeries(s, "ser-freeone");
  const busy = exceptionOf("ser-freeone");

  await processException(await context(s, s.biz.id), { ...busy, transparency: "transparent" });
  expect(mock.patches).toHaveLength(2);
  for (const patch of mock.patches) expect(patch.body).toEqual({ status: "cancelled" });
  mock.patches.length = 0;

  const result = await processException(await context(s, s.biz.id), busy);

  expect(result.processed).toBe(2);
  expect(mock.patches).toHaveLength(2);
  for (const patch of mock.patches) {
    expect(patch.body).toEqual({ start: busy.start, end: busy.end, status: "confirmed" });
  }
  expect(mock.inserts).toHaveLength(2); // only the two replica series
});

it("a derived id that 404s falls back to a lookup by original start", async () => {
  const s = await setup();
  const replicas = await replicateSeries(s, "ser-lookup");
  const primarySeries = replicas.get(s.primary.id)!;
  const sideSeries = replicas.get(s.side.id)!;
  mock.makeNextPatchGone(`${primarySeries}${DEC1_SUFFIX}`);
  mock.queueInstances("tok-primary", primarySeries, [
    {
      id: `${primarySeries}_20261201T000000Z`,
      recurringEventId: primarySeries,
      status: "confirmed",
      originalStartTime: { dateTime: "2026-11-30T23:00:00Z" },
    },
  ]);
  // The side replica has no instance at that start: nothing to patch.
  mock.makeNextPatchGone(`${sideSeries}${DEC1_SUFFIX}`);
  const moved = exceptionOf("ser-lookup");
  const ctx = await context(s, s.biz.id);

  const result = await processException(ctx, moved);

  expect(result).toMatchObject({ processed: 1, errors: [], retryLater: false });
  expect(mock.patches.map((p) => p.eventId)).toEqual([`${primarySeries}_20261201T000000Z`]);
  expect(mock.instancesRequests).toHaveLength(2);
  // Two gone patches, two lookups, one patch.
  expect(ctx.budget.remaining).toBe(MAX_CALENDAR_API_CALLS_PER_RUN - 5);
  // Both recorded, so a resend costs nothing.
  for (const m of await listSeriesMappingsForSource(env.DB, s.biz.id, "ser-lookup")) {
    expect(await getExceptionFingerprint(env.DB, m.id, DEC1_START)).toBe(exceptionFingerprint(moved));
  }
});

it("an exception id outside the series' format is looked up by original start", async () => {
  const s = await setup();
  const replicas = await replicateSeries(s, "ser-oddid");
  const primarySeries = replicas.get(s.primary.id)!;
  mock.queueInstances("tok-primary", primarySeries, [
    {
      id: "replica-instance",
      recurringEventId: primarySeries,
      status: "confirmed",
      originalStartTime: { dateTime: DEC1_START },
    },
  ]);

  await processException(await context(s, s.biz.id), exceptionOf("ser-oddid", { id: "unrelated-id" }));

  expect(mock.instancesRequests).toHaveLength(2);
  expect(mock.patches.map((p) => p.eventId)).toEqual(["replica-instance"]);
});

it("a busy exception with an existing single replica on a mapped target loses that single and patches the replica instance", async () => {
  const s = await setup();
  const replicas = await replicateSeries(s, "ser-hadsingle");
  const moved = exceptionOf("ser-hadsingle");
  await createEventMapping(env.DB, {
    id: crypto.randomUUID(),
    userId: s.userId,
    sourceAccountId: s.biz.id,
    sourceEventId: moved.id,
    targetAccountId: s.primary.id,
    targetEventId: "single-replica-primary",
  });

  const result = await processException(await context(s, s.biz.id), moved);

  expect(mock.deletes.map((d) => d.eventId)).toEqual(["single-replica-primary"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, moved.id)).toHaveLength(0);
  // Replaced before removed: the primary's instance is patched first.
  const writes = googleCalls().filter((c) => c.startsWith("PATCH") || c.startsWith("DELETE"));
  expect(writes.map((c) => c.split(" ")[0])).toEqual(["PATCH", "DELETE", "PATCH"]);
  expect(mock.patches.map((p) => p.eventId).sort()).toEqual(
    [...replicas.values()].map((id) => `${id}${DEC1_SUFFIX}`).sort(),
  );
  expect(result.processed).toBe(3);
});

it("singles on a target without a replica series are left alone", async () => {
  const s = await setup();
  await replicateSeries(s, "ser-partial");
  // The side target lost its replica series (e.g. it was rejected there).
  const side = (await findSeriesMapping(env.DB, s.biz.id, "ser-partial", s.side.id))!;
  await env.DB.prepare("DELETE FROM series_mappings WHERE id = ?").bind(side.id).run();
  const moved = exceptionOf("ser-partial");
  await createEventMapping(env.DB, {
    id: crypto.randomUUID(),
    userId: s.userId,
    sourceAccountId: s.biz.id,
    sourceEventId: moved.id,
    targetAccountId: s.side.id,
    targetEventId: "single-replica-side",
  });

  const result = await processException(await context(s, s.biz.id), moved);

  expect(result).toMatchObject({ processed: 1, retryLater: false });
  expect(mock.deletes).toHaveLength(0);
  expect(mock.inserts).toHaveLength(2);
  expect(mock.patches.map((p) => p.accessToken)).toEqual(["tok-primary"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, moved.id)).toHaveLength(1);
});

it("a budget cut between targets resumes without patching a target twice", async () => {
  const s = await setup();
  await replicateSeries(s, "ser-exbudget");
  const moved = exceptionOf("ser-exbudget");

  await processException(await context(s, s.biz.id, new CallBudget(1)), moved);
  expect(mock.patches).toHaveLength(1);
  await processException(await context(s, s.biz.id), moved);

  expect(mock.patches).toHaveLength(2);
  expect(mock.patches.map((p) => p.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
});

it("an exhausted budget makes no Google call", async () => {
  const s = await setup();
  await replicateSeries(s, "ser-nobudget");
  const budget = new CallBudget(1);
  budget.spend();
  const callsBefore = googleCalls().length;

  const result = await processException(await context(s, s.biz.id, budget), exceptionOf("ser-nobudget"));

  expect(googleCalls().length).toBe(callsBefore);
  expect(result.processed).toBe(0);
});

it("a budget cut between the instance patch and the single delete never leaves the moved time free", async () => {
  const s = await setup();
  await replicateSeries(s, "ser-cutdel");
  const moved = exceptionOf("ser-cutdel");
  await singleReplicasOf(s, moved.id, [s.primary]);
  const primaryMapping = (await findSeriesMapping(env.DB, s.biz.id, "ser-cutdel", s.primary.id))!;

  await processException(await context(s, s.biz.id, new CallBudget(1)), moved);

  expect(mock.patches.map((p) => p.accessToken)).toEqual(["tok-primary"]);
  expect(mock.deletes).toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, moved.id)).toHaveLength(1);
  expect(await getExceptionFingerprint(env.DB, primaryMapping.id, DEC1_START)).toBeNull();

  await processException(await context(s, s.biz.id), moved);

  expect(mock.deletes.map((d) => d.eventId)).toEqual(["single-replica-tok-primary"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, moved.id)).toHaveLength(0);
  expect(mock.patches.map((p) => p.accessToken)).toEqual(["tok-primary", "tok-primary", "tok-side"]);
  expect(await getExceptionFingerprint(env.DB, primaryMapping.id, DEC1_START)).toBe(exceptionFingerprint(moved));
});

it("a replica instance that can't be found keeps the target's single replica", async () => {
  const s = await setup();
  const replicas = await replicateSeries(s, "ser-nofind");
  const moved = exceptionOf("ser-nofind");
  await singleReplicasOf(s, moved.id, [s.primary]);
  // Gone by derived id, and the lookup finds nothing.
  mock.makeNextPatchGone(`${replicas.get(s.primary.id)!}${DEC1_SUFFIX}`);

  const result = await processException(await context(s, s.biz.id), moved);

  expect(result).toMatchObject({ processed: 1, retryLater: false });
  expect(mock.deletes).toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, moved.id)).toHaveLength(1);
  const primaryMapping = (await findSeriesMapping(env.DB, s.biz.id, "ser-nofind", s.primary.id))!;
  expect(await getExceptionFingerprint(env.DB, primaryMapping.id, DEC1_START)).toBe(exceptionFingerprint(moved));
});
