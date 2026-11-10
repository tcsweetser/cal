import { describe, expect, it } from "vitest";
import {
  classifyEvent,
  exceptionFingerprint,
  instanceSuffix,
  originalStartKey,
  queueOrder,
  seriesFingerprint,
} from "../src/services/recurrence";
import type { GoogleCalendarEvent } from "../src/services/googleCalendar";

const start = { dateTime: "2026-11-24T09:00:00+10:00", timeZone: "Australia/Brisbane" };
const end = { dateTime: "2026-11-24T10:00:00+10:00", timeZone: "Australia/Brisbane" };

describe("classifyEvent", () => {
  it("classifies singles, series, exceptions and cancelled stubs", () => {
    expect(classifyEvent({ id: "a", start, end })).toBe("single");
    expect(classifyEvent({ id: "a", start, end, recurrence: ["RRULE:FREQ=WEEKLY"] })).toBe("series");
    expect(
      classifyEvent({ id: "a_20261124T000000Z", recurringEventId: "a", originalStartTime: start, start, end }),
    ).toBe("exception");
    expect(classifyEvent({ id: "a", status: "cancelled" })).toBe("cancelled-top-level");
    expect(
      classifyEvent({
        id: "a_20261124T000000Z",
        recurringEventId: "a",
        originalStartTime: { dateTime: "2026-11-24T00:00:00Z" },
        status: "cancelled",
      }),
    ).toBe("exception");
  });

  // A series made "does not repeat" keeps its id and arrives as a single, so
  // singles go before exceptions, which may wait on their series id.
  it("orders series, cancelled stubs, singles, exceptions", () => {
    const evs: GoogleCalendarEvent[] = [
      { id: "s", start },
      { id: "e_1", recurringEventId: "e" },
      { id: "c", status: "cancelled" },
      { id: "r", recurrence: ["RRULE:FREQ=DAILY"] },
    ];
    expect(evs.sort((a, b) => queueOrder(a) - queueOrder(b)).map((e) => e.id)).toEqual(["r", "c", "s", "e_1"]);
  });
});

describe("instanceSuffix", () => {
  it("instanceSuffix extracts the original-start suffix and rejects foreign ids", () => {
    expect(instanceSuffix("abc_20261124T000000Z", "abc")).toBe("_20261124T000000Z");
    expect(instanceSuffix("abc_20260901", "abc")).toBe("_20260901");
    expect(instanceSuffix("xyz_20261124T000000Z", "abc")).toBeNull();
  });

  it("a Sydney-zone series keeps its suffix across daylight saving", () => {
    const suffix = instanceSuffix("ser_20270115T230000Z", "ser");
    expect(suffix).toBe("_20270115T230000Z");
    expect(`rep${suffix}`).toBe("rep_20270115T230000Z");
  });
});

describe("originalStartKey", () => {
  it("prefers dateTime, falls back to date", () => {
    expect(originalStartKey({ id: "x", originalStartTime: { dateTime: "2026-11-24T00:00:00Z" } })).toBe(
      "2026-11-24T00:00:00Z",
    );
    expect(originalStartKey({ id: "x", originalStartTime: { date: "2026-09-01" } })).toBe("2026-09-01");
  });
});

describe("fingerprints", () => {
  const base: GoogleCalendarEvent = {
    id: "a",
    summary: "Standup",
    start,
    end,
    status: "confirmed",
    transparency: "opaque",
    recurrence: ["RRULE:FREQ=WEEKLY"],
  };

  it("fingerprints ignore the title but catch time, rule, status and transparency changes", () => {
    const f = seriesFingerprint(base);
    expect(seriesFingerprint({ ...base, summary: "Other" })).toBe(f);
    // key order does not matter
    expect(
      seriesFingerprint({ recurrence: base.recurrence, transparency: "opaque", status: "confirmed", end, start, id: "a" }),
    ).toBe(f);
    expect(seriesFingerprint({ ...base, recurrence: ["RRULE:FREQ=DAILY"] })).not.toBe(f);
    expect(seriesFingerprint({ ...base, start: { ...start, dateTime: "2026-11-24T08:00:00+10:00" } })).not.toBe(f);
    expect(seriesFingerprint({ ...base, end: { ...end, dateTime: "2026-11-24T11:00:00+10:00" } })).not.toBe(f);
    expect(seriesFingerprint({ ...base, status: "tentative" })).not.toBe(f);
    expect(seriesFingerprint({ ...base, transparency: "transparent" })).not.toBe(f);

    const ef = exceptionFingerprint(base);
    expect(exceptionFingerprint({ ...base, summary: "Other", recurrence: ["RRULE:FREQ=DAILY"] })).toBe(ef);
    expect(exceptionFingerprint({ ...base, status: "cancelled" })).not.toBe(ef);
    expect(exceptionFingerprint({ ...base, transparency: "transparent" })).not.toBe(ef);
    // absent transparency is consistent and distinct from "transparent"
    const { transparency: _t, ...noT } = base;
    expect(exceptionFingerprint(noT)).toBe(exceptionFingerprint({ ...noT }));
    expect(exceptionFingerprint(noT)).not.toBe(exceptionFingerprint({ ...noT, transparency: "transparent" }));
  });
});
