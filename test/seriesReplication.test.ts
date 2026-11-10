import { env } from "cloudflare:workers";
import { it, expect, beforeEach, type Mock } from "vitest";
import { createEventMapping, findEventMappingsBySource, listAccountsForUser } from "../src/db/schema";
import {
  findSeriesMapping,
  getExceptionFingerprint,
  listSeriesMappingsForSource,
  upsertExceptionFingerprint,
} from "../src/db/seriesSchema";
import { seriesFingerprint } from "../src/services/recurrence";
import { CallBudget, MAX_CALENDAR_API_CALLS_PER_RUN, TokenCache } from "../src/services/syncShared";
import { processSeries, type ReplicationContext } from "../src/services/seriesReplication";
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

it("a single event that becomes a series loses its single replicas first", async () => {
  const s = await setup();
  for (const target of [s.primary, s.side]) {
    await createEventMapping(env.DB, {
      id: crypto.randomUUID(),
      userId: s.userId,
      sourceAccountId: s.biz.id,
      sourceEventId: "ev-converted",
      targetAccountId: target.id,
      targetEventId: `single-replica-${target.accessToken}`,
    });
  }

  const result = await processSeries(await context(s, s.biz.id), weeklySeries("ev-converted"));

  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual(["single-replica-tok-primary", "single-replica-tok-side"]);
  expect(mock.inserts).toHaveLength(2);
  const calls = googleCalls().filter((c) => !c.startsWith("GET"));
  expect(calls.map((c) => c.split(" ")[0])).toEqual(["DELETE", "DELETE", "POST", "POST"]);
  expect(await findEventMappingsBySource(env.DB, s.biz.id, "ev-converted")).toHaveLength(0);
  expect(result.processed).toBe(4);
});

it("a failed delete of a single replica stops before any series insert", async () => {
  const s = await setup();
  await createEventMapping(env.DB, {
    id: crypto.randomUUID(),
    userId: s.userId,
    sourceAccountId: s.biz.id,
    sourceEventId: "ev-stuck",
    targetAccountId: s.primary.id,
    targetEventId: "single-replica-stuck",
  });
  mock.failDeletes(403);

  const result = await processSeries(await context(s, s.biz.id), weeklySeries("ev-stuck"));

  expect(result.retryLater).toBe(true);
  expect(mock.inserts).toHaveLength(0);
  expect(await listSeriesMappingsForSource(env.DB, s.biz.id, "ev-stuck")).toHaveLength(0);
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
