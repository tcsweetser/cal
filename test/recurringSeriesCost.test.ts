import { env } from "cloudflare:workers";
import { it, expect, beforeEach } from "vitest";
import { runFullSync } from "../src/services/syncEngine";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { createTestUser, createTestAccount } from "./helpers/fixtures";
import { meteredDb } from "./helpers/meteredD1";

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

let mock: GoogleCalendarMock;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  mock.install();
});

it("records recurring series in one D1 call however many instances the delta holds", async () => {
  const userId = await createTestUser();
  const account = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const instance = (series: string, i: number) => ({
    id: `${series}_${i}`,
    status: "confirmed" as const,
    transparency: "opaque" as const,
    recurringEventId: series,
    start: { dateTime: hoursFromNow(i + 1) },
    end: { dateTime: hoursFromNow(i + 2) },
  });
  mock.queueList("tok-primary", {
    events: [
      ...Array.from({ length: 100 }, (_, i) => instance("series-a", i)),
      ...Array.from({ length: 100 }, (_, i) => instance("series-b", i)),
    ],
    nextSyncToken: "token-1",
  });
  const metered = meteredDb(env.DB);

  await runFullSync({ ...env, DB: metered.db }, userId);

  expect(metered.calls.filter((c) => c.sql.includes("tracked_recurring_series"))).toHaveLength(1);
  const tracked = await env.DB.prepare("SELECT recurring_event_id FROM tracked_recurring_series WHERE account_id = ? ORDER BY 1")
    .bind(account.id)
    .all<{ recurring_event_id: string }>();
  expect(tracked.results.map((r) => r.recurring_event_id)).toEqual(["series-a", "series-b"]);
});
