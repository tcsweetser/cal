// Thin Google Calendar API v3 client. Every account in this system is only
// ever read/written via its own "primary" calendar (see plan.md §5) — so
// calendarId is always "primary", never parameterized.

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const CALENDAR_URL = "https://www.googleapis.com/calendar/v3/calendars/primary";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const MAX_RETRY_ATTEMPTS = 3;
// ~10,000 events at 250/page — well past any reasonable single calendar, but
// bounds worst-case pagination against the Worker's subrequest/CPU limits.
const MAX_PAGES = 40;

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
  // Present on every expanded instance of a recurring series (singleEvents=
  // true), pointing at the master event's id — the signal the daily audit
  // (syncEngine.ts) uses to discover which series exist at all, since we
  // never otherwise fetch the master event itself.
  recurringEventId?: string;
  // Populated by Google once a conferenceData.createRequest (see
  // insertEventWithMeetLink below) resolves — trustedAccess.ts reads
  // entryPoints for the actual join URL.
  conferenceData?: {
    conferenceSolution?: { key?: { type?: string } };
    entryPoints?: Array<{ entryPointType: string; uri: string }>;
  };
  description?: string;
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

// Thrown by patchEvent specifically (not deleteEvent, which already treats
// gone-ness as success) — a target replica missing on PATCH means the caller
// needs to decide what to do next (re-create it), not just swallow the error.
export class EventGoneError extends Error {
  constructor(eventId: string) {
    super(`Google Calendar event ${eventId} no longer exists (404/410)`);
    this.name = "EventGoneError";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries 429/5xx with exponential backoff (honoring Retry-After when Google
// sends one). Other statuses (2xx, and 4xx other than 429) are returned as-is
// immediately for the caller to interpret — those aren't retryable.
async function googleFetch(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    res = await fetch(url, init);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_RETRY_ATTEMPTS) return res;
    const retryAfterHeader = res.headers.get("Retry-After");
    const delayMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2 ** attempt * 250;
    await sleep(delayMs);
  }
  return res!;
}

interface EventsListResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export async function fetchEventsDelta(
  accessToken: string,
  source: { syncToken: string } | { timeMin: string; timeMax?: string },
): Promise<EventsDeltaResult> {
  const events: GoogleCalendarEvent[] = [];
  let nextSyncToken: string | undefined;
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const params = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
    if ("syncToken" in source) {
      params.set("syncToken", source.syncToken);
    } else {
      params.set("timeMin", source.timeMin);
      if (source.timeMax) params.set("timeMax", source.timeMax);
    }
    if (pageToken) params.set("pageToken", pageToken);

    const res = await googleFetch(`${EVENTS_URL}?${params.toString()}`, {
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

    pages++;
    if (pageToken && pages >= MAX_PAGES) {
      throw new Error(`Google Calendar list exceeded ${MAX_PAGES} pages — aborting to stay within Worker limits`);
    }
  } while (pageToken);

  if (!nextSyncToken) {
    throw new Error("Google Calendar list completed without a nextSyncToken on the final page");
  }

  return { events, nextSyncToken };
}

// Used only by the daily recurring-series audit (syncEngine.ts) to look
// ahead for occurrences of a known series that have newly entered the sync
// window (see FUTURE_WINDOW_MS). Deliberately a separate endpoint from fetchEventsDelta:
// events.instances() takes timeMin/timeMax directly with no syncToken
// involved at all, so none of the incremental-sync bounding restrictions
// that motivated this function's existence apply to it — this is the one
// call in the whole app that can genuinely ask Google "what's in this exact
// date range" without fighting the syncToken-exclusivity rule.
export async function fetchRecurringInstances(
  accessToken: string,
  recurringEventId: string,
  timeMin: string,
  timeMax: string,
): Promise<GoogleCalendarEvent[]> {
  const events: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const params = new URLSearchParams({ timeMin, timeMax, maxResults: "250" });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await googleFetch(`${EVENTS_URL}/${encodeURIComponent(recurringEventId)}/instances?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // The master event (and so its instances) may be gone by the time the
    // daily audit gets to it — treat like any other "already handled"
    // gone-ness in this file rather than erroring the whole audit run.
    if (res.status === 404 || res.status === 410) return events;
    if (!res.ok) {
      throw new Error(`Google Calendar instances list failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json<EventsListResponse>();
    events.push(...(data.items ?? []));
    pageToken = data.nextPageToken;

    pages++;
    if (pageToken && pages >= MAX_PAGES) {
      throw new Error(`Google Calendar instances list exceeded ${MAX_PAGES} pages — aborting to stay within Worker limits`);
    }
  } while (pageToken);

  return events;
}

export async function insertEvent(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<GoogleCalendarEvent> {
  const res = await googleFetch(EVENTS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Calendar insert failed: ${res.status} ${await res.text()}`);
  return res.json<GoogleCalendarEvent>();
}

// Sets conferenceDataVersion=1 and expects the caller's body to include
// conferenceData.createRequest.requestId — per Google's documented shape for
// auto-generating a Meet link on insert (verified against current docs this
// session, not assumed from memory). A separate function from insertEvent,
// not a flag on it: every other caller of insertEvent (the appointment
// placeholder itself, when not remote) has no reason to ever touch
// conferencing, and keeping the plain path's signature/behavior unchanged
// avoids any risk of an accidental conferenceDataVersion on a call site that
// doesn't want it.
export async function insertEventWithMeetLink(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<GoogleCalendarEvent> {
  const res = await googleFetch(`${EVENTS_URL}?conferenceDataVersion=1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Calendar insert (with Meet link) failed: ${res.status} ${await res.text()}`);
  return res.json<GoogleCalendarEvent>();
}

interface CalendarMetadata {
  timeZone?: string;
}

// Used to attach the correct timeZone to a booked appointment (see
// confirmAppointmentBooking, trustedAccess.ts) so it displays correctly on
// the target account's own calendar — the owner's calendar timezone is
// authoritative (user decision), not the invitee's browser zone.
export async function getCalendarTimeZone(accessToken: string): Promise<string> {
  const res = await googleFetch(CALENDAR_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google Calendar metadata fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<CalendarMetadata>();
  return data.timeZone ?? "UTC";
}

export interface FreeBusyInterval {
  start: string;
  end: string;
}

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: FreeBusyInterval[] }>;
}

// Used by computeAvailableSlots (trustedAccess.ts) to check real availability
// on the target calendar — deliberately Google's purpose-built endpoint
// rather than fetching every event via fetchEventsDelta/events.list and
// computing busy blocks ourselves: it's a single call, always returns
// absolute UTC instants (no timezone ambiguity to resolve on our side at
// all), and needs no syncToken/window-filter machinery.
export async function fetchFreeBusy(accessToken: string, timeMin: string, timeMax: string): Promise<FreeBusyInterval[]> {
  const res = await googleFetch(FREEBUSY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: "primary" }] }),
  });
  if (!res.ok) throw new Error(`Google Calendar freeBusy failed: ${res.status} ${await res.text()}`);
  const data = await res.json<FreeBusyResponse>();
  return data.calendars?.primary?.busy ?? [];
}

export async function patchEvent(
  accessToken: string,
  eventId: string,
  body: Record<string, unknown>,
): Promise<GoogleCalendarEvent> {
  const res = await googleFetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404 || res.status === 410) throw new EventGoneError(eventId);
  if (!res.ok) throw new Error(`Google Calendar patch failed: ${res.status} ${await res.text()}`);
  return res.json<GoogleCalendarEvent>();
}

// Idempotent: a target event that's already gone (deleted by hand, or a
// previous run's DELETE succeeded but the D1 mapping-row delete that should
// have followed it didn't) is treated as success, not an error, since the
// caller's goal — "this replica no longer exists" — is already satisfied.
export async function deleteEvent(accessToken: string, eventId: string): Promise<void> {
  const res = await googleFetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar delete failed: ${res.status} ${await res.text()}`);
  }
}

// Used only for 410-recovery reconciliation (syncEngine.ts): a forced full
// re-sync (timeMin-bounded, no syncToken) doesn't reliably report deletions
// the way an incremental sync does, so previously-mapped source events need a
// direct existence check instead.
export async function getEvent(accessToken: string, eventId: string): Promise<GoogleCalendarEvent | null> {
  const res = await googleFetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`Google Calendar get failed: ${res.status} ${await res.text()}`);
  const event = await res.json<GoogleCalendarEvent>();
  return event.status === "cancelled" ? null : event;
}
