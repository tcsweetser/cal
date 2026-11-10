import { env } from "cloudflare:workers";
import { it, expect, beforeEach } from "vitest";
import { enqueueEvents, hasQueuedEvents } from "../src/db/schema";
import { runFullSync } from "../src/services/syncEngine";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { createTestUser, createTestAccount } from "./helpers/fixtures";
import { meteredDb } from "./helpers/meteredD1";

const BACKLOG = 300;
const MAX_ROWS_READ = 5;

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

async function seedBacklog(userId: string, accountId: string): Promise<void> {
  const events = Array.from({ length: BACKLOG }, (_, i) => ({
    id: `backlog-${i}`,
    json: JSON.stringify({
      id: `backlog-${i}`,
      status: "confirmed",
      transparency: "opaque",
      start: { dateTime: hoursFromNow(i + 1) },
      end: { dateTime: hoursFromNow(i + 2) },
    }),
  }));
  await enqueueEvents(env.DB, userId, accountId, events);
}

let mock: GoogleCalendarMock;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  mock.install();
});

it("hasQueuedEvents answers without reading the whole backlog", async () => {
  const userId = await createTestUser();
  const account = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  await seedBacklog(userId, account.id);
  const metered = meteredDb(env.DB);

  expect(await hasQueuedEvents(metered.db, account.id)).toBe(true);

  expect(metered.calls).toHaveLength(1);
  expect(metered.calls[0]!.rowsRead).toBeLessThan(MAX_ROWS_READ);
});

it("hasQueuedEvents is false for an empty queue", async () => {
  const userId = await createTestUser();
  const account = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });

  expect(await hasQueuedEvents(env.DB, account.id)).toBe(false);
});

it("a sync counts each account's backlog once, only for the status note", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });
  await seedBacklog(userId, biz.id);
  const metered = meteredDb(env.DB);

  await runFullSync({ ...env, DB: metered.db }, userId);

  expect(metered.calls.filter((c) => c.sql.includes("COUNT(*) AS n FROM sync_queue"))).toHaveLength(2);
});
