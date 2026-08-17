import { vi } from "vitest";
import type { GoogleCalendarEvent } from "../../src/services/googleCalendar";
import type { FreeBusyInterval } from "../../src/services/googleCalendar";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const CALENDAR_URL = "https://www.googleapis.com/calendar/v3/calendars/primary";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

export interface MockInsert {
  accessToken: string;
  body: Record<string, unknown>;
}
export interface MockPatch {
  accessToken: string;
  eventId: string;
  body: Record<string, unknown>;
}
export interface MockDelete {
  accessToken: string;
  eventId: string;
}

export class GoogleCalendarMock {
  // What the next LIST call for a given access token should return. `"410"`
  // simulates an expired syncToken; consumed once, then falls through to the
  // next queued response (or an empty 200 if the queue is empty).
  private listQueues = new Map<string, Array<{ events: GoogleCalendarEvent[]; nextSyncToken: string } | "410">>();
  // eventIds that should 404 the *next* PATCH only (simulates a replica
  // deleted out from under a sync run) — consumed once.
  private goneOnPatch = new Set<string>();
  // Explicit existence per eventId, for single-event GET (getEvent, used by
  // 410-recovery reconciliation). Deliberately has no default — a test that
  // triggers reconciliation without configuring this should fail loudly, not
  // silently assume an answer.
  private eventExistence = new Map<string, boolean>();
  // originEventIds whose insert should always 500 (see the POST handler) —
  // simulates an event that can never be created, for per-event isolation tests.
  private poisonedOriginEventIds = new Set<string>();
  // Unlike poisonedOriginEventIds (keyed off sync-engine metadata a booking/
  // poll insert never sets), this fails *every* insert regardless of body —
  // for tests simulating a Google failure on the one-off placeholder events
  // trustedAccess.ts writes (no originEventId to key off of).
  private poisonAllInserts_ = false;
  // What the next events.instances() call for a given (accessToken,
  // recurringEventId) pair should return — used by the daily recurring
  // audit's tests (runDailyRecurringAudit, syncEngine.ts). Keyed same as
  // listQueues but scoped per-series, since a real account can have more
  // than one tracked series being audited in the same test.
  private instancesQueues = new Map<string, GoogleCalendarEvent[]>();
  inserts: MockInsert[] = [];
  patches: MockPatch[] = [];
  deletes: MockDelete[] = [];
  private nextId = 1;
  // What calendars.get('primary') and freeBusy.query should report for a
  // given access token — UTC / no busy intervals unless a test configures
  // otherwise, so tests that don't care about timezone/availability specifics
  // (most of syncEngine.test.ts) can ignore these entirely. Not "consumed
  // once" like listQueues — computeAvailableSlots and confirmAppointmentBooking
  // (trustedAccess.ts) both call freeBusy in the same test, and both should
  // see the same configured state unless a test explicitly calls setFreeBusy
  // again between the two (e.g. to simulate a slot going stale).
  private calendarTimeZones = new Map<string, string>();
  private freeBusyByToken = new Map<string, FreeBusyInterval[]>();

  queueList(accessToken: string, response: { events: GoogleCalendarEvent[]; nextSyncToken: string } | "410") {
    const queue = this.listQueues.get(accessToken) ?? [];
    queue.push(response);
    this.listQueues.set(accessToken, queue);
  }

  queueInstances(accessToken: string, recurringEventId: string, events: GoogleCalendarEvent[]) {
    this.instancesQueues.set(`${accessToken}:${recurringEventId}`, events);
  }

  makeNextPatchGone(eventId: string) {
    this.goneOnPatch.add(eventId);
  }

  setEventExists(eventId: string, exists: boolean) {
    this.eventExistence.set(eventId, exists);
  }

  poisonInsertsForEvent(originEventId: string) {
    this.poisonedOriginEventIds.add(originEventId);
  }

  poisonAllInserts() {
    this.poisonAllInserts_ = true;
  }

  setCalendarTimeZone(accessToken: string, timeZone: string) {
    this.calendarTimeZones.set(accessToken, timeZone);
  }

  setFreeBusy(accessToken: string, intervals: FreeBusyInterval[]) {
    this.freeBusyByToken.set(accessToken, intervals);
  }

  private bearer(init?: RequestInit): string {
    const headers = init?.headers as Record<string, string> | undefined;
    const auth = headers?.Authorization ?? "";
    return auth.replace(/^Bearer /, "");
  }

  // Delegates anything it doesn't recognize to whatever fetch was installed
  // before it, rather than throwing outright — so this composes with another
  // mock (e.g. ResendMock) installed in either order in the same test,
  // instead of one silently clobbering the other via vi.stubGlobal.
  install() {
    const previousFetch = globalThis.fetch;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const accessToken = this.bearer(init);

      if (url.origin + url.pathname === EVENTS_URL && method === "GET") {
        const queue = this.listQueues.get(accessToken) ?? [];
        const next = queue.shift();
        if (next === "410") return new Response("Gone", { status: 410 });
        if (!next) return new Response(JSON.stringify({ items: [], nextSyncToken: "empty-token" }), { status: 200 });
        return new Response(JSON.stringify({ items: next.events, nextSyncToken: next.nextSyncToken }), {
          status: 200,
        });
      }

      if (url.origin + url.pathname === EVENTS_URL && method === "POST") {
        if (this.poisonAllInserts_) {
          return new Response("Internal Server Error", { status: 500 });
        }
        const body = JSON.parse(String(init?.body)) as {
          extendedProperties?: { private?: { originEventId?: string } };
          conferenceData?: { createRequest?: { requestId?: string } };
        };
        const originEventId = body.extendedProperties?.private?.originEventId;
        // Persistent (not consumed) so retries inside googleFetch also fail —
        // simulates an event that can genuinely never be inserted, not a
        // transient blip that a retry would paper over.
        if (originEventId && this.poisonedOriginEventIds.has(originEventId)) {
          return new Response("Internal Server Error", { status: 500 });
        }
        this.inserts.push({ accessToken, body });
        const id = `mock-event-${this.nextId++}`;
        // insertEventWithMeetLink (googleCalendar.ts) posts to this same
        // path+conferenceDataVersion=1 query param — url.pathname ignores
        // the query string, so it lands here too. Only fabricate
        // conferenceData when the request actually asked for it, matching
        // Google's real "pending -> success" shape closely enough for tests
        // that just need a real-looking entryPoints URI.
        const conferenceData = body.conferenceData?.createRequest
          ? {
              conferenceSolution: { key: { type: "hangoutsMeet" } },
              entryPoints: [{ entryPointType: "video", uri: `https://meet.google.com/mock-${id}` }],
            }
          : undefined;
        return new Response(JSON.stringify({ id, ...body, ...(conferenceData ? { conferenceData } : {}) }), { status: 200 });
      }

      if (url.origin + url.pathname === CALENDAR_URL && method === "GET") {
        return new Response(JSON.stringify({ timeZone: this.calendarTimeZones.get(accessToken) ?? "UTC" }), { status: 200 });
      }

      if (url.origin + url.pathname === FREEBUSY_URL && method === "POST") {
        const busy = this.freeBusyByToken.get(accessToken) ?? [];
        return new Response(JSON.stringify({ calendars: { primary: { busy } } }), { status: 200 });
      }

      // Checked before the generic patchMatch below — its (.+)$ would
      // otherwise greedily swallow ".../{id}/instances" as if {id}/instances
      // were itself an event id.
      const instancesMatch = url.pathname.match(/^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)\/instances$/);
      if (instancesMatch && method === "GET") {
        const recurringEventId = decodeURIComponent(instancesMatch[1]!);
        const events = this.instancesQueues.get(`${accessToken}:${recurringEventId}`) ?? [];
        return new Response(JSON.stringify({ items: events }), { status: 200 });
      }

      const patchMatch = url.pathname.match(/^\/calendar\/v3\/calendars\/primary\/events\/(.+)$/);
      if (patchMatch && method === "PATCH") {
        const eventId = decodeURIComponent(patchMatch[1]!);
        if (this.goneOnPatch.has(eventId)) {
          this.goneOnPatch.delete(eventId); // consumed once
          return new Response("Gone", { status: 404 });
        }
        const body = JSON.parse(String(init?.body));
        this.patches.push({ accessToken, eventId, body });
        return new Response(JSON.stringify({ id: eventId, ...body }), { status: 200 });
      }

      if (patchMatch && method === "DELETE") {
        const eventId = decodeURIComponent(patchMatch[1]!);
        this.deletes.push({ accessToken, eventId });
        return new Response(null, { status: 204 });
      }

      if (patchMatch && method === "GET") {
        const eventId = decodeURIComponent(patchMatch[1]!);
        const exists = this.eventExistence.get(eventId);
        if (exists === undefined) {
          throw new Error(`Mock: getEvent(${eventId}) called without configuring existence via setEventExists()`);
        }
        if (!exists) return new Response("Gone", { status: 404 });
        return new Response(JSON.stringify({ id: eventId, status: "confirmed" }), { status: 200 });
      }

      if (url.origin + url.pathname === EVENTS_URL || instancesMatch || patchMatch) {
        throw new Error(`Unhandled mock request: ${method} ${url.toString()}`);
      }
      return previousFetch(input, init);
    });

    vi.stubGlobal("fetch", fn);
    return fn;
  }
}
