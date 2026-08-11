// Thin Google Calendar API v3 client. Every account in this system is only
// ever read/written via its own "primary" calendar (see plan.md §5) — so
// calendarId is always "primary", never parameterized.

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
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
