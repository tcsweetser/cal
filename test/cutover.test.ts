// Per-account cutover from instance replication to series replication: the
// legacy queue drains the old way, the sync position resets, and only then
// are the old per-instance replicas removed, future ones first.
import { env } from "cloudflare:workers";
import { it, expect, beforeEach, vi, type Mock } from "vitest";
import { runFullSync } from "../src/services/syncEngine";
import { runLegacyCleanup } from "../src/services/cutover";
import { CallBudget, TokenCache } from "../src/services/syncShared";
import { storeTokens } from "../src/services/tokenManager";
import {
  createEventMapping,
  enqueueEvents,
  findEventMappingsBySource,
  listActiveAccountsForUser,
  markAccountStatus,
  setPendingSyncToken,
  setSyncToken,
} from "../src/db/schema";
import {
  createSeriesMapping,
  getCutoverState,
  markCutoverComplete,
  markCutoverReset,
} from "../src/db/seriesSchema";
import type { GoogleCalendarEvent } from "../src/services/googleCalendar";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { createTestAccount, createTestUser } from "./helpers/fixtures";
import { meteredDb } from "./helpers/meteredD1";
import { hoursFromNow, queuedCount, seriesSetup, weeklySeries, type SeriesSetup } from "./helpers/seriesEvents";

const DAY_MS = 24 * 60 * 60 * 1000;

let mock: GoogleCalendarMock;
let fetchSpy: Mock;
let replicaSeq = 0;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  fetchSpy = mock.install() as unknown as Mock;
});

function today(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

// YYYYMMDD, `days` from today (UTC).
function dateIn(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10).replace(/-/g, "");
}

// A per-instance replica the old code made: source id `<seriesId>_<suffix>`.
async function seedLegacyReplica(
  userId: string,
  sourceId: string,
  targetId: string,
  seriesId: string,
  date: string,
): Promise<{ mappingId: string; targetEventId: string }> {
  const mappingId = crypto.randomUUID();
  const targetEventId = `legacy-replica-${++replicaSeq}`;
  await createEventMapping(env.DB, {
    id: mappingId,
    userId,
    sourceAccountId: sourceId,
    sourceEventId: `${seriesId}_${date}T230000Z`,
    targetAccountId: targetId,
    targetEventId,
  });
  return { mappingId, targetEventId };
}

async function seedSeriesMapping(userId: string, sourceId: string, seriesId: string, targetId: string): Promise<void> {
  await createSeriesMapping(env.DB, {
    id: crypto.randomUUID(),
    userId,
    sourceAccountId: sourceId,
    sourceSeriesId: seriesId,
    targetAccountId: targetId,
    targetSeriesId: `replica-${seriesId}-${++replicaSeq}`,
    fingerprint: "fp",
  });
}

async function mappingExists(mappingId: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM event_mappings WHERE id = ?").bind(mappingId).first()) !== null;
}

async function cleanupCount(sourceId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM legacy_instance_cleanup WHERE source_account_id = ?")
    .bind(sourceId)
    .first<{ n: number }>();
  return row!.n;
}

// Query strings of the events.list calls made with this account's token.
function listQueriesFor(accessToken: string): URLSearchParams[] {
  return fetchSpy.mock.calls
    .filter(([input, init]) => {
      const url = new URL(String(input));
      const auth = ((init as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization;
      return (
        url.pathname === "/calendar/v3/calendars/primary/events" &&
        ((init as RequestInit | undefined)?.method ?? "GET") === "GET" &&
        auth === `Bearer ${accessToken}`
      );
    })
    .map(([input]) => new URL(String(input)).searchParams);
}

// "METHOD path" of every Google write so far, in order.
function googleWrites(): string[] {
  return fetchSpy.mock.calls
    .map(([input, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${new URL(String(input)).pathname}`)
    .filter((c) => c.includes("/calendar/v3/") && !c.startsWith("GET"));
}

function deleteAttempts(): number {
  return googleWrites().filter((c) => c.startsWith("DELETE")).length;
}

// An instance as the old singleEvents=true fetch queued it.
function oldInstance(seriesId: string, days: number): GoogleCalendarEvent {
  const start = new Date(Date.now() + days * DAY_MS);
  return {
    id: `${seriesId}_${dateIn(days)}T230000Z`,
    recurringEventId: seriesId,
    status: "confirmed",
    transparency: "opaque",
    start: { dateTime: start.toISOString() },
    end: { dateTime: new Date(start.getTime() + 60 * 60 * 1000).toISOString() },
  };
}

// The source account's legacy cleanup is ready to run: reset and completed.
async function completeCutover(s: SeriesSetup): Promise<void> {
  await markCutoverReset(env.DB, s.userId, s.biz.id);
  await markCutoverComplete(env.DB, s.biz.id);
}

async function cleanup(s: SeriesSetup, budget: CallBudget, db: D1Database = env.DB) {
  const accounts = await listActiveAccountsForUser(env.DB, s.userId);
  return runLegacyCleanup({ ...env, DB: db }, new TokenCache(env), budget, accounts, today());
}

it("an account with old instance items queued drains them the old way before resetting", async () => {
  const s = await seriesSetup();
  const cancelled = await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-old", dateIn(2));
  await enqueueEvents(env.DB, s.userId, s.biz.id, [
    { id: `ser-old_${dateIn(2)}T230000Z`, json: JSON.stringify({ id: `ser-old_${dateIn(2)}T230000Z`, status: "cancelled" }) },
    ...Array.from({ length: 20 }, (_, i) => {
      const event = oldInstance("ser-old", i + 3);
      return { id: event.id, json: JSON.stringify(event) };
    }),
  ]);

  await runFullSync(env, s.userId);

  expect(listQueriesFor("tok-biz")).toHaveLength(0);
  expect(await queuedCount(s.biz.id)).toBeGreaterThan(0);
  expect((await getCutoverState(env.DB, s.biz.id))?.reset_at ?? null).toBeNull();
  // The queued cancellation removed its replica; the instances became singles.
  expect(mock.deletes.map((d) => d.eventId)).toEqual([cancelled.targetEventId]);
  expect(await mappingExists(cancelled.mappingId)).toBe(false);
  expect(mock.inserts.length).toBeGreaterThan(0);
  for (const insert of mock.inserts) expect(insert.body.recurrence).toBeUndefined();

  await runFullSync(env, s.userId);

  expect(listQueriesFor("tok-biz")).toHaveLength(0);
  expect(await queuedCount(s.biz.id)).toBe(0);
  expect((await getCutoverState(env.DB, s.biz.id))?.reset_at).toBeTruthy();
  for (let i = 0; i < 20; i++) {
    expect(await findEventMappingsBySource(env.DB, s.biz.id, oldInstance("ser-old", i + 3).id)).toHaveLength(2);
  }
  // Every replica the legacy drain made is queued for cleanup.
  expect(await cleanupCount(s.biz.id)).toBe(40);
});

it("the reset makes the next fetch a full unexpanded fetch", async () => {
  const s = await seriesSetup();
  await setSyncToken(env.DB, s.userId, s.biz.id, "old-expanded-token");
  await setPendingSyncToken(env.DB, s.userId, s.biz.id, "old-pending-token");
  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-series-token" });

  await runFullSync(env, s.userId);

  const lists = listQueriesFor("tok-biz");
  expect(lists).toHaveLength(1);
  expect(lists[0]!.get("syncToken")).toBeNull();
  expect(lists[0]!.get("timeMin")).toBeTruthy();
  expect(lists[0]!.get("singleEvents")).toBe("false");
  const state = await getCutoverState(env.DB, s.biz.id);
  expect(state?.reset_at).toBeTruthy();
  expect(state?.completed_at).toBeTruthy();
});

it("legacy future instance replicas are deleted only after their series has a replica on that target", async () => {
  const s = await seriesSetup();
  const legacy = [
    await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-live", dateIn(1)),
    await seedLegacyReplica(s.userId, s.biz.id, s.side.id, "ser-live", dateIn(1)),
    await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-live", dateIn(8)),
    await seedLegacyReplica(s.userId, s.biz.id, s.side.id, "ser-live", dateIn(8)),
  ];
  mock.poisonInsertsForEvent("ser-live", 403);
  mock.queueList("tok-biz", { events: [weeklySeries("ser-live")], nextSyncToken: "biz-token-1" });

  await runFullSync(env, s.userId);

  expect(mock.deletes).toHaveLength(0);
  for (const { mappingId } of legacy) expect(await mappingExists(mappingId)).toBe(true);
  expect((await getCutoverState(env.DB, s.biz.id))?.completed_at ?? null).toBeNull();

  mock.healInsertsForEvent("ser-live");
  await runFullSync(env, s.userId);

  expect(mock.inserts.map((i) => i.accessToken).sort()).toEqual(["tok-primary", "tok-side"]);
  expect(mock.deletes.map((d) => d.eventId).sort()).toEqual(legacy.map((l) => l.targetEventId).sort());
  for (const { mappingId } of legacy) expect(await mappingExists(mappingId)).toBe(false);
  expect(await cleanupCount(s.biz.id)).toBe(0);
  // Replace before remove: every legacy delete came after both series inserts.
  const writes = googleWrites();
  const lastInsert = writes.lastIndexOf("POST /calendar/v3/calendars/primary/events");
  const firstDelete = writes.findIndex((w) => w.startsWith("DELETE"));
  expect(firstDelete).toBeGreaterThan(lastInsert);
});

it("legacy instance replicas of a series that ended before cutover are kept", async () => {
  const s = await seriesSetup();
  const ended = await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-ended", dateIn(-30));

  await runFullSync(env, s.userId);

  // The cleanup ran (the reset queued the row, and it's gone) but deleted nothing.
  expect((await getCutoverState(env.DB, s.biz.id))?.completed_at).toBeTruthy();
  expect(await cleanupCount(s.biz.id)).toBe(0);
  expect(mock.deletes).toHaveLength(0);
  expect(await mappingExists(ended.mappingId)).toBe(true);
});

it("legacy cleanup takes future instances first and stays within the call budget", async () => {
  const s = await seriesSetup();
  const future: string[] = [];
  const past: string[] = [];
  await seedSeriesMapping(s.userId, s.biz.id, "ser-many", s.primary.id);
  for (let i = 0; i < 30; i++) {
    future.push((await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-many", dateIn(i))).targetEventId);
  }
  for (let i = 1; i <= 20; i++) {
    past.push((await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-many", dateIn(-i))).targetEventId);
  }
  await completeCutover(s);
  const budget = new CallBudget(35, 60);

  const result = await cleanup(s, budget);

  expect(result.processed).toBe(35);
  expect(result.errors).toEqual([]);
  expect(budget.exhausted).toBe(true);
  // Soonest future first, then the most recent past ones.
  expect(mock.deletes.map((d) => d.eventId)).toEqual([...future, ...past.slice(0, 5)]);
  expect(await cleanupCount(s.biz.id)).toBe(15);
});

it("single-event mappings are never touched by the cleanup", async () => {
  const s = await seriesSetup();
  const singleId = crypto.randomUUID();
  await createEventMapping(env.DB, {
    id: singleId,
    userId: s.userId,
    sourceAccountId: s.biz.id,
    sourceEventId: "single-ev",
    targetAccountId: s.primary.id,
    targetEventId: "single-replica",
  });
  const legacy = await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-s", dateIn(3));
  mock.queueList("tok-biz", { events: [weeklySeries("ser-s")], nextSyncToken: "biz-token-1" });

  await runFullSync(env, s.userId);

  expect(mock.deletes.map((d) => d.eventId)).toEqual([legacy.targetEventId]);
  expect(await mappingExists(singleId)).toBe(true);
  expect(await mappingExists(legacy.mappingId)).toBe(false);
});

it("an account connected after cutover resets immediately with nothing to clean up", async () => {
  const s = await seriesSetup();

  await runFullSync(env, s.userId);

  for (const account of [s.primary, s.biz, s.side]) {
    const state = await getCutoverState(env.DB, account.id);
    expect(state?.reset_at).toBeTruthy();
    expect(state?.completed_at).toBeTruthy();
    expect(await cleanupCount(account.id)).toBe(0);
  }
  expect(mock.deletes).toHaveLength(0);
});

it("a reset followed by a budget cut before the fetch does not mark the cutover complete", async () => {
  const userId = await createTestUser();
  const primary = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  // Accounts sync in email order, so primary's drain runs first.
  const biz = await createTestAccount(userId, "secondary", {
    email: "z-biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });
  // One call each (primary's only target is biz): enough to use the budget up.
  await enqueueEvents(
    env.DB,
    userId,
    primary.id,
    Array.from({ length: 40 }, (_, i) => ({
      id: `busy-${i}`,
      json: JSON.stringify({
        id: `busy-${i}`,
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(i + 1) },
        end: { dateTime: hoursFromNow(i + 2) },
      }),
    })),
  );

  await runFullSync(env, userId);

  expect(listQueriesFor("tok-biz")).toHaveLength(0);
  const afterCut = await getCutoverState(env.DB, biz.id);
  expect(afterCut?.reset_at).toBeTruthy();
  expect(afterCut?.completed_at ?? null).toBeNull();

  await runFullSync(env, userId);

  expect(listQueriesFor("tok-biz")).toHaveLength(1);
  expect((await getCutoverState(env.DB, biz.id))?.completed_at).toBeTruthy();
});

it("legacy cleanup reads a bounded number of rows however many are queued", async () => {
  const s = await seriesSetup();
  await seedSeriesMapping(s.userId, s.biz.id, "ser-big", s.primary.id);
  const stmt = env.DB.prepare(
    `INSERT INTO event_mappings (id, user_id, source_account_id, source_event_id, target_account_id, target_event_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch(
    Array.from({ length: 300 }, (_, i) =>
      stmt.bind(crypto.randomUUID(), s.userId, s.biz.id, `ser-big_${dateIn(i)}T230000Z`, s.primary.id, `big-${i}`),
    ),
  );
  await completeCutover(s);
  expect(await cleanupCount(s.biz.id)).toBe(300);
  const metered = meteredDb(env.DB);
  const limit = 10;

  const result = await cleanup(s, new CallBudget(limit, 60), metered.db);

  expect(result.processed).toBe(limit);
  const listCalls = metered.calls.filter((c) => c.sql.includes("FROM legacy_instance_cleanup"));
  expect(listCalls.length).toBeGreaterThan(0);
  for (const call of listCalls) expect(call.rowsRead).toBeLessThanOrEqual(limit + 1);
  for (const call of metered.calls) expect(call.rowsRead).toBeLessThan(limit + 5);
  const totalRowsRead = metered.calls.reduce((sum, c) => sum + c.rowsRead, 0);
  expect(totalRowsRead).toBeLessThan(10 * limit);
});

it("legacy rows kept as history still take from the run's item cap", async () => {
  const s = await seriesSetup();
  for (let i = 0; i < 20; i++) await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-gone", dateIn(-i - 1));
  await completeCutover(s);
  const budget = new CallBudget(35, 5);

  await cleanup(s, budget);

  expect(budget.itemsExhausted).toBe(true);
  expect(await cleanupCount(s.biz.id)).toBe(15);
  expect(mock.deletes).toHaveLength(0);
});

it("a revoked cleanup target drops its cleanup rows, keeps their mappings, and the rest still run", async () => {
  const s = await seriesSetup();
  const gone = await createTestAccount(s.userId, "secondary", {
    email: "gone@example.com",
    tag: "personal",
    accessToken: "tok-gone",
  });
  await seedSeriesMapping(s.userId, s.biz.id, "ser-r", gone.id);
  await seedSeriesMapping(s.userId, s.biz.id, "ser-r", s.primary.id);
  const onGone = [
    await seedLegacyReplica(s.userId, s.biz.id, gone.id, "ser-r", dateIn(1)),
    await seedLegacyReplica(s.userId, s.biz.id, gone.id, "ser-r", dateIn(2)),
  ];
  const onPrimary = await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-r", dateIn(3));
  await completeCutover(s);
  await markAccountStatus(env.DB, gone.id, "revoked");
  await storeTokens(env, gone.id, { access_token: "expired", refresh_token: "refresh", expires_at: 0 });
  const next = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith("https://oauth2.googleapis.com/token")
      ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      : next(input, init),
  );

  const result = await cleanup(s, new CallBudget(35, 60));

  expect(result.errors).toHaveLength(2);
  for (const { mappingId } of onGone) expect(await mappingExists(mappingId)).toBe(true);
  expect(mock.deletes.map((d) => d.eventId)).toEqual([onPrimary.targetEventId]);
  expect(await mappingExists(onPrimary.mappingId)).toBe(false);
  expect(await cleanupCount(s.biz.id)).toBe(0);
});

it("a legacy replica already gone from the target counts as deleted", async () => {
  const s = await seriesSetup();
  await seedSeriesMapping(s.userId, s.biz.id, "ser-404", s.primary.id);
  const legacy = await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-404", dateIn(1));
  await completeCutover(s);
  mock.failDeletes(404);

  const result = await cleanup(s, new CallBudget(35, 60));

  expect(result).toEqual({ processed: 1, errors: [] });
  expect(await mappingExists(legacy.mappingId)).toBe(false);
});

it("a legacy delete Google rejects with 400 drops the cleanup row and keeps the mapping", async () => {
  const s = await seriesSetup();
  await seedSeriesMapping(s.userId, s.biz.id, "ser-400", s.primary.id);
  const legacy = [
    await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-400", dateIn(1)),
    await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-400", dateIn(2)),
  ];
  await completeCutover(s);
  mock.failDeletes(400);

  const result = await cleanup(s, new CallBudget(35, 60));

  expect(result.errors).toHaveLength(2);
  expect(deleteAttempts()).toBe(2);
  for (const { mappingId } of legacy) expect(await mappingExists(mappingId)).toBe(true);
  expect(await cleanupCount(s.biz.id)).toBe(0);
});

it("any other legacy delete failure stops the cleanup for this run", async () => {
  const s = await seriesSetup();
  await seedSeriesMapping(s.userId, s.biz.id, "ser-403", s.primary.id);
  const legacy = [
    await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-403", dateIn(1)),
    await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-403", dateIn(2)),
    await seedLegacyReplica(s.userId, s.biz.id, s.primary.id, "ser-403", dateIn(3)),
  ];
  await completeCutover(s);
  mock.failDeletes(403);

  const result = await cleanup(s, new CallBudget(35, 60));

  expect(result.errors).toHaveLength(1);
  expect(deleteAttempts()).toBe(1);
  for (const { mappingId } of legacy) expect(await mappingExists(mappingId)).toBe(true);
  expect(await cleanupCount(s.biz.id)).toBe(3);
});
