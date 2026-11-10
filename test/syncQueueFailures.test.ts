import { env } from "cloudflare:workers";
import { it, expect, beforeEach, vi } from "vitest";
import { runFullSync } from "../src/services/syncEngine";
import { createEventMapping, enqueueEvents, findEventMappingsBySource, markAccountStatus } from "../src/db/schema";
import { storeTokens } from "../src/services/tokenManager";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { createTestUser, createTestAccount } from "./helpers/fixtures";

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

function opaqueEvent(id: string, startHours: number) {
  return {
    id,
    status: "confirmed" as const,
    transparency: "opaque" as const,
    start: { dateTime: hoursFromNow(startHours) },
    end: { dateTime: hoursFromNow(startHours + 1) },
  };
}

async function queuedCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return row!.n;
}

async function storedSyncToken(accountId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT sync_token FROM sync_tokens WHERE account_id = ?")
    .bind(accountId)
    .first<{ sync_token: string }>();
  return row?.sync_token ?? null;
}

async function createAccounts() {
  const userId = await createTestUser();
  const primary = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });
  return { userId, primary, biz };
}

// Forces the next use of this account's token through the refresh endpoint.
async function expireTokens(accountId: string): Promise<void> {
  await storeTokens(env, accountId, { access_token: "expired", refresh_token: "refresh", expires_at: 0 });
}

function stubTokenEndpoint(response: () => Response): void {
  const next = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith("https://oauth2.googleapis.com/token") ? response() : next(input, init),
  );
}

let mock: GoogleCalendarMock;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  mock.install();
});

it("a non-JSON error page from the token endpoint keeps the delta queued", async () => {
  const { userId, primary, biz } = await createAccounts();
  await expireTokens(primary.id);
  stubTokenEndpoint(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
  mock.queueList("tok-biz", { events: [opaqueEvent("ev-a", 1)], nextSyncToken: "biz-token-1" });

  await runFullSync(env, userId);

  expect(await queuedCount(biz.id)).toBe(1);
  expect(await storedSyncToken(biz.id)).toBeNull();
});

it("a corrupt queued event is dropped and the rest of the queue still drains", async () => {
  const { userId, biz } = await createAccounts();
  await enqueueEvents(env.DB, userId, biz.id, [
    { id: "ev-corrupt", json: "{not json" },
    { id: "ev-good", json: JSON.stringify(opaqueEvent("ev-good", 1)) },
  ]);

  await runFullSync(env, userId);

  expect(await queuedCount(biz.id)).toBe(0);
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-good")).toHaveLength(1);
});

it("a cancellation whose replica is on a revoked account doesn't block the queue", async () => {
  const { userId, biz } = await createAccounts();
  const revoked = await createTestAccount(userId, "secondary", {
    email: "gone@example.com",
    tag: "personal",
    accessToken: "tok-gone",
  });
  await createEventMapping(env.DB, {
    id: crypto.randomUUID(),
    userId,
    sourceAccountId: biz.id,
    sourceEventId: "ev-x",
    targetAccountId: revoked.id,
    targetEventId: "replica-1",
  });
  await markAccountStatus(env.DB, revoked.id, "revoked");
  await expireTokens(revoked.id);
  stubTokenEndpoint(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
  mock.queueList("tok-biz", {
    events: [{ id: "ev-x", status: "cancelled" }, opaqueEvent("ev-good", 1)],
    nextSyncToken: "biz-token-1",
  });

  await runFullSync(env, userId);

  expect(await queuedCount(biz.id)).toBe(0);
  expect(await storedSyncToken(biz.id)).toBe("biz-token-1");
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-good")).toHaveLength(1);
});

async function mapReplica(userId: string, sourceId: string, targetId: string, sourceEventId: string): Promise<void> {
  await createEventMapping(env.DB, {
    id: crypto.randomUUID(),
    userId,
    sourceAccountId: sourceId,
    sourceEventId,
    targetAccountId: targetId,
    targetEventId: "replica-1",
  });
}

it("a Google 5xx on a patch keeps the update queued, and a later run applies it", async () => {
  const { userId, primary, biz } = await createAccounts();
  await mapReplica(userId, biz.id, primary.id, "ev-a");
  mock.failPatches(500);
  mock.queueList("tok-biz", { events: [opaqueEvent("ev-a", 1)], nextSyncToken: "biz-token-1" });

  await runFullSync(env, userId);

  expect(await queuedCount(biz.id)).toBe(1);
  expect(await storedSyncToken(biz.id)).toBeNull();

  mock.failPatches(null);
  await runFullSync(env, userId);

  expect(mock.patches.map((p) => p.eventId)).toEqual(["replica-1"]);
  expect(await queuedCount(biz.id)).toBe(0);
}, 10000);

it("a 400 on a patch drops only that update", async () => {
  const { userId, primary, biz } = await createAccounts();
  await mapReplica(userId, biz.id, primary.id, "ev-a");
  mock.failPatches(400);
  mock.queueList("tok-biz", { events: [opaqueEvent("ev-a", 1)], nextSyncToken: "biz-token-1" });

  await runFullSync(env, userId);

  expect(await queuedCount(biz.id)).toBe(0);
  expect(await storedSyncToken(biz.id)).toBe("biz-token-1");
});

it("a failed delete on a busy-to-free change keeps the event queued", async () => {
  const { userId, primary, biz } = await createAccounts();
  await mapReplica(userId, biz.id, primary.id, "ev-a");
  mock.failDeletes(500);
  mock.queueList("tok-biz", {
    events: [{ ...opaqueEvent("ev-a", 1), transparency: "transparent" }],
    nextSyncToken: "biz-token-1",
  });

  await runFullSync(env, userId);

  expect(await queuedCount(biz.id)).toBe(1);
  expect(await storedSyncToken(biz.id)).toBeNull();
}, 10000);

it("a 400 on a replica delete doesn't hold the queue", async () => {
  const { userId, primary, biz } = await createAccounts();
  await mapReplica(userId, biz.id, primary.id, "ev-x");
  mock.failDeletes(400);
  mock.queueList("tok-biz", { events: [{ id: "ev-x", status: "cancelled" }], nextSyncToken: "biz-token-1" });

  await runFullSync(env, userId);

  expect(await queuedCount(biz.id)).toBe(0);
  expect(await storedSyncToken(biz.id)).toBe("biz-token-1");
});

// Everything except a 400 says nothing about the event's own content: 404 on
// an insert would mean the target calendar is missing, for example.
it.each([500, 429, 401, 403, 404, 408, 409, 412])(
  "a Google %i on an insert keeps the delta queued, and a later run replicates it",
  async (status) => {
    const { userId, biz } = await createAccounts();
    mock.poisonInsertsForEvent("ev-a", status);
    mock.queueList("tok-biz", { events: [opaqueEvent("ev-a", 1), opaqueEvent("ev-b", 3)], nextSyncToken: "biz-token-1" });

    await runFullSync(env, userId);

    expect(await queuedCount(biz.id)).toBe(2);
    expect(await storedSyncToken(biz.id)).toBeNull();
    expect(mock.inserts).toHaveLength(0);

    mock.healInsertsForEvent("ev-a");
    await runFullSync(env, userId);

    expect(await queuedCount(biz.id)).toBe(0);
    expect(await storedSyncToken(biz.id)).toBe("biz-token-1");
    expect(await findEventMappingsBySource(env.DB, biz.id, "ev-a")).toHaveLength(1);
    expect(await findEventMappingsBySource(env.DB, biz.id, "ev-b")).toHaveLength(1);
  },
  10000,
);

it("a failure that isn't about the event, like a target's missing tokens, keeps the delta queued", async () => {
  const { userId, primary, biz } = await createAccounts();
  await env.TOKEN_STORE.delete(`tokens:${primary.id}`);
  mock.queueList("tok-biz", { events: [opaqueEvent("ev-a", 1)], nextSyncToken: "biz-token-1" });

  await runFullSync(env, userId);

  expect(await queuedCount(biz.id)).toBe(1);
  expect(await storedSyncToken(biz.id)).toBeNull();
});

it("a failed replica delete keeps the cancellation queued, so the replica isn't orphaned", async () => {
  const { userId, primary, biz } = await createAccounts();
  await createEventMapping(env.DB, {
    id: crypto.randomUUID(),
    userId,
    sourceAccountId: biz.id,
    sourceEventId: "ev-x",
    targetAccountId: primary.id,
    targetEventId: "replica-1",
  });
  mock.failDeletes(500);
  mock.queueList("tok-biz", { events: [{ id: "ev-x", status: "cancelled" }], nextSyncToken: "biz-token-1" });

  await runFullSync(env, userId);

  expect(await queuedCount(biz.id)).toBe(1);
  expect(await storedSyncToken(biz.id)).toBeNull();
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-x")).toHaveLength(1);

  mock.failDeletes(null);
  await runFullSync(env, userId);

  expect(mock.deletes.map((d) => d.eventId)).toEqual(["replica-1"]);
  expect(await queuedCount(biz.id)).toBe(0);
  expect(await storedSyncToken(biz.id)).toBe("biz-token-1");
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-x")).toHaveLength(0);
}, 10000);
