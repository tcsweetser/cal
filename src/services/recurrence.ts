import type { GoogleCalendarEvent } from "./googleCalendar";

export type FetchedKind = "single" | "series" | "exception" | "cancelled-top-level";

/** Route a fetched Google item (fetched with singleEvents=false, showDeleted=true). */
export function classifyEvent(event: GoogleCalendarEvent): FetchedKind {
  if (event.recurringEventId) return "exception";
  // A cancelled series stub may lack `recurrence`, so check status first.
  if (event.status === "cancelled") return "cancelled-top-level";
  if (event.recurrence) return "series";
  return "single";
}

/**
 * Google instance ids are `<seriesId>_<original start>`. Returns the part from
 * the `_` onwards, or null when the id does not belong to that series.
 */
export function instanceSuffix(exceptionId: string, seriesId: string): string | null {
  const prefix = `${seriesId}_`;
  return exceptionId.startsWith(prefix) ? exceptionId.slice(seriesId.length) : null;
}

export function originalStartKey(event: GoogleCalendarEvent): string {
  const o = event.originalStartTime;
  return (o?.dateTime ?? o?.date) as string;
}

/** JSON.stringify with object keys sorted recursively; undefined becomes null. */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Title is excluded: replicas are always "Busy". */
export function seriesFingerprint(event: GoogleCalendarEvent): string {
  return stableJson({
    recurrence: event.recurrence,
    start: event.start,
    end: event.end,
    status: event.status,
    transparency: event.transparency,
  });
}

export function exceptionFingerprint(event: GoogleCalendarEvent): string {
  return stableJson({
    start: event.start,
    end: event.end,
    status: event.status,
    transparency: event.transparency,
  });
}

/**
 * Sort key for a fetch before enqueueing: series, cancelled stubs, singles,
 * exceptions. An exception waits while its series id is queued, and a series
 * made "does not repeat" keeps its id and arrives as a single, so singles must
 * drain first or that exception waits on every tick.
 */
export function queueOrder(event: GoogleCalendarEvent): number {
  switch (classifyEvent(event)) {
    case "series":
      return 0;
    case "cancelled-top-level":
      return 1;
    case "single":
      return 2;
    case "exception":
      return 3;
  }
}
