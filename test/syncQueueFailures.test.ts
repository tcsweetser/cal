import { env } from "cloudflare:workers";
import { it, expect, beforeEach } from "vitest";
import { runFullSync } from "../src/services/syncEngine";
import { createEventMapping, findEventMappingsBySource } from "../src/db/schema";
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

let mock: GoogleCalendarMock;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  mock.install();
});

it.each([500, 429, 401, 403])(
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
