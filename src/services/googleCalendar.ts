// Thin Google Calendar API v3 client. Every account in this system is only
// ever read/written via its own "primary" calendar (see plan.md §5) — so
// calendarId is always "primary", never parameterized.

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface GoogleEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  transparency?: "opaque" | "transparent";
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

export interface EventsDeltaResult {
  events: GoogleCalendarEvent[];
  nextSyncToken: string;
}

export class SyncTokenExpiredError extends Error {
  constructor() {
    super("Google Calendar syncToken expired or invalid (410 Gone)");
    this.name = "SyncTokenExpiredError";
  }
}

interface EventsListResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export async function fetchEventsDelta(
  accessToken: string,
  source: { syncToken: string } | { timeMin: string },
): Promise<EventsDeltaResult> {
  const events: GoogleCalendarEvent[] = [];
  let nextSyncToken: string | undefined;
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ singleEvents: "true" });
    if ("syncToken" in source) {
      params.set("syncToken", source.syncToken);
    } else {
      params.set("timeMin", source.timeMin);
    }
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${EVENTS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 410) throw new SyncTokenExpiredError();
    if (!res.ok) {
      throw new Error(`Google Calendar list failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json<EventsListResponse>();
    events.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
  } while (pageToken);

  if (!nextSyncToken) {
    throw new Error("Google Calendar list completed without a nextSyncToken on the final page");
  }

  return { events, nextSyncToken };
}

export async function insertEvent(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<GoogleCalendarEvent> {
  const res = await fetch(EVENTS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Calendar insert failed: ${res.status} ${await res.text()}`);
  return res.json<GoogleCalendarEvent>();
}

export async function patchEvent(
  accessToken: string,
  eventId: string,
  body: Record<string, unknown>,
): Promise<GoogleCalendarEvent> {
  const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Calendar patch failed: ${res.status} ${await res.text()}`);
  return res.json<GoogleCalendarEvent>();
}

// Idempotent: a target event that's already gone (deleted by hand, or a
// previous run's DELETE succeeded but the D1 mapping-row delete that should
// have followed it didn't) is treated as success, not an error, since the
// caller's goal — "this replica no longer exists" — is already satisfied.
export async function deleteEvent(accessToken: string, eventId: string): Promise<void> {
  const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar delete failed: ${res.status} ${await res.text()}`);
  }
}
