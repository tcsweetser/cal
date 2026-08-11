import { vi } from "vitest";
import type { GoogleCalendarEvent } from "../../src/services/googleCalendar";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

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
  inserts: MockInsert[] = [];
  patches: MockPatch[] = [];
  deletes: MockDelete[] = [];
  private nextId = 1;

  queueList(accessToken: string, response: { events: GoogleCalendarEvent[]; nextSyncToken: string } | "410") {
    const queue = this.listQueues.get(accessToken) ?? [];
    queue.push(response);
    this.listQueues.set(accessToken, queue);
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

  private bearer(init?: RequestInit): string {
    const headers = init?.headers as Record<string, string> | undefined;
    const auth = headers?.Authorization ?? "";
    return auth.replace(/^Bearer /, "");
  }

  install() {
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
        const body = JSON.parse(String(init?.body)) as {
          extendedProperties?: { private?: { originEventId?: string } };
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
        return new Response(JSON.stringify({ id, ...body }), { status: 200 });
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

      throw new Error(`Unhandled mock request: ${method} ${url.toString()}`);
    });

    vi.stubGlobal("fetch", fn);
    return fn;
  }
}
