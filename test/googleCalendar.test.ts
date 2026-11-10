import { beforeEach, describe, expect, it } from "vitest";
import { fetchEventsDelta, findInstanceByOriginalStart } from "../src/services/googleCalendar";
import { GoogleCalendarMock } from "./helpers/googleMock";

const TOKEN = "test-access-token";
const SERIES = "series-1";

let google: GoogleCalendarMock;
beforeEach(() => {
  google = new GoogleCalendarMock();
  google.install();
});

describe("fetchEventsDelta", () => {
  it("a full fetch asks for unexpanded series, deleted items, and no upper time bound", async () => {
    await fetchEventsDelta(TOKEN, { timeMin: "2026-11-10T00:00:00.000Z" });
    const q = google.listRequests[0]!;
    expect(q.get("singleEvents")).toBe("false");
    expect(q.get("showDeleted")).toBe("true");
    expect(q.get("maxResults")).toBe("250");
    expect(q.get("timeMin")).toBe("2026-11-10T00:00:00.000Z");
    expect(q.has("timeMax")).toBe(false);
    expect(q.has("syncToken")).toBe(false);
  });

  it("an incremental fetch sends the sync token and the same expansion settings", async () => {
    await fetchEventsDelta(TOKEN, { syncToken: "tok-1" });
    const q = google.listRequests[0]!;
    expect(q.get("syncToken")).toBe("tok-1");
    expect(q.get("singleEvents")).toBe("false");
    expect(q.get("showDeleted")).toBe("true");
    expect(q.get("maxResults")).toBe("250");
    expect(q.has("timeMin")).toBe(false);
    expect(q.has("timeMax")).toBe(false);
  });
});

describe("findInstanceByOriginalStart", () => {
  const original = { dateTime: "2026-11-24T09:00:00+10:00", timeZone: "Australia/Brisbane" };

  it("matches on original start, not current start", async () => {
    const moved = {
      id: `${SERIES}_20261123T230000Z`,
      recurringEventId: SERIES,
      // Moved earlier than its original start, and reported in a different offset.
      start: { dateTime: "2026-11-23T08:00:00Z" },
      end: { dateTime: "2026-11-23T09:00:00Z" },
      originalStartTime: { dateTime: "2026-11-23T23:00:00Z" },
    };
    const other = { ...moved, id: "other", originalStartTime: { dateTime: "2026-12-01T23:00:00Z" } };
    google.queueInstances(TOKEN, SERIES, [other, moved]);

    const found = await findInstanceByOriginalStart(TOKEN, SERIES, original);
    expect(found?.id).toBe(moved.id);

    const none = await findInstanceByOriginalStart(TOKEN, SERIES, {
      dateTime: "2026-11-25T09:00:00+10:00",
    });
    expect(none).toBeNull();
  });

  it("queries 48 hours either side of the original start", async () => {
    await findInstanceByOriginalStart(TOKEN, SERIES, original);
    const q = google.instancesRequests[0]!;
    expect(q.get("timeMin")).toBe("2026-11-21T23:00:00.000Z");
    expect(q.get("timeMax")).toBe("2026-11-25T23:00:00.000Z");
  });

  it("matches an all-day instance on its original date", async () => {
    const allDay = {
      id: `${SERIES}_20261124`,
      recurringEventId: SERIES,
      start: { date: "2026-11-25" },
      end: { date: "2026-11-26" },
      originalStartTime: { date: "2026-11-24" },
    };
    google.queueInstances(TOKEN, SERIES, [allDay]);

    const found = await findInstanceByOriginalStart(TOKEN, SERIES, { date: "2026-11-24" });
    expect(found?.id).toBe(allDay.id);
    const q = google.instancesRequests[0]!;
    expect(q.get("timeMin")).toBe("2026-11-22T00:00:00.000Z");
    expect(q.get("timeMax")).toBe("2026-11-26T00:00:00.000Z");

    expect(await findInstanceByOriginalStart(TOKEN, SERIES, { date: "2026-11-30" })).toBeNull();
  });

  it("returns a cancelled instance and asks Google for deleted items", async () => {
    const cancelled = {
      id: `${SERIES}_20261124T000000Z`,
      recurringEventId: SERIES,
      status: "cancelled" as const,
      originalStartTime: { dateTime: "2026-11-23T23:00:00Z" },
    };
    google.queueInstances(TOKEN, SERIES, [cancelled]);

    const found = await findInstanceByOriginalStart(TOKEN, SERIES, original);
    expect(found?.id).toBe(cancelled.id);
    expect(found?.status).toBe("cancelled");
    expect(google.instancesRequests[0]!.get("showDeleted")).toBe("true");
  });
});
