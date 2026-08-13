import { env } from "cloudflare:workers";
import { it, expect, beforeEach } from "vitest";
import { runFullSync, runDailyRecurringAudit } from "../src/services/syncEngine";
import { findEventMappingsBySource } from "../src/db/schema";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { createTestUser, createTestAccount } from "./helpers/fixtures";

function originEventIdOf(body: Record<string, unknown>): string | undefined {
  const props = body.extendedProperties as { private?: { originEventId?: string } } | undefined;
  return props?.private?.originEventId;
}

// Relative to test-run time, not hardcoded — syncAccount's withinSyncWindow
// filter (syncEngine.ts) rejects events outside [now, now+30d], so a fixture
// with a hardcoded absolute date silently starts failing the moment the real
// calendar date passes it. Every "near-term" test event uses these instead.
function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}
function dateDaysFromNow(d: number): string {
  return new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

let mock: GoogleCalendarMock;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  mock.install();
});

it("secondary event fans out to primary and every other secondary, never to itself", async () => {
  const userId = await createTestUser();
  const primary = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });
  const side = await createTestAccount(userId, "secondary", {
    email: "side@example.com",
    tag: "side_hustle",
    accessToken: "tok-side",
  });

  mock.queueList("tok-biz", {
    events: [
      {
        id: "ev1",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(2) },
        end: { dateTime: hoursFromNow(3) },
      },
    ],
    nextSyncToken: "biz-token-1",
  });

  await runFullSync(env, userId);

  expect(mock.inserts).toHaveLength(2);
  const targets = mock.inserts.map((i) => i.accessToken).sort();
  expect(targets).toEqual(["tok-primary", "tok-side"].sort());

  for (const insert of mock.inserts) {
    expect(insert.body.summary).toBe("Busy");
    const props = (insert.body.extendedProperties as { private: Record<string, string> }).private;
    expect(props.syncEngine).toBe("cf-cal-replication");
    expect(props.originAccountId).toBe(biz.id);
    expect(props.originEventId).toBe("ev1");
  }

  const mappings = await findEventMappingsBySource(env.DB, biz.id, "ev1");
  expect(mappings).toHaveLength(2);
  expect(mappings.map((m) => m.target_account_id).sort()).toEqual([primary.id, side.id].sort());
});

it("primary event fans out to every secondary as Personal Time", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  await createTestAccount(userId, "secondary", { email: "biz@example.com", tag: "business", accessToken: "tok-biz" });
  await createTestAccount(userId, "secondary", {
    email: "side@example.com",
    tag: "side_hustle",
    accessToken: "tok-side",
  });

  mock.queueList("tok-primary", {
    events: [
      {
        id: "ev-p1",
        status: "confirmed",
        transparency: "opaque",
        start: { date: dateDaysFromNow(0) },
        end: { date: dateDaysFromNow(1) },
      },
    ],
    nextSyncToken: "primary-token-1",
  });

  await runFullSync(env, userId);

  expect(mock.inserts).toHaveLength(2);
  for (const insert of mock.inserts) {
    expect(insert.body.summary).toBe("Personal Time");
  }
});

it("a previously-synced event is PATCHed on the next sync, not duplicated", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  const nativeEvent = {
    id: "ev1",
    status: "confirmed" as const,
    transparency: "opaque" as const,
    start: { dateTime: hoursFromNow(2) },
    end: { dateTime: hoursFromNow(3) },
  };

  mock.queueList("tok-biz", { events: [nativeEvent], nextSyncToken: "biz-token-1" });
  await runFullSync(env, userId);
  expect(mock.inserts).toHaveLength(1);
  const mappingsAfterCreate = await findEventMappingsBySource(env.DB, biz.id, "ev1");
  expect(mappingsAfterCreate).toHaveLength(1);
  const targetEventId = mappingsAfterCreate[0]!.target_event_id;

  // Second sync: same event id, changed time, still native (no extendedProperties).
  mock.queueList("tok-biz", {
    events: [{ ...nativeEvent, start: { dateTime: hoursFromNow(6) }, end: { dateTime: hoursFromNow(7) } }],
    nextSyncToken: "biz-token-2",
  });
  await runFullSync(env, userId);

  expect(mock.inserts).toHaveLength(1); // still just the one from round 1 — no duplicate POST
  expect(mock.patches).toHaveLength(1);
  expect(mock.patches[0]!.eventId).toBe(targetEventId); // patched the SAME replica, not a new one
  expect(mock.patches[0]!.accessToken).toBe("tok-primary");

  const mappingsAfterUpdate = await findEventMappingsBySource(env.DB, biz.id, "ev1");
  expect(mappingsAfterUpdate).toHaveLength(1); // still exactly one mapping row, not two
});

it("cancelling a source event deletes every mapped replica, not just one", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });
  await createTestAccount(userId, "secondary", {
    email: "side@example.com",
    tag: "side_hustle",
    accessToken: "tok-side",
  });

  mock.queueList("tok-biz", {
    events: [
      {
        id: "ev1",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(2) },
        end: { dateTime: hoursFromNow(3) },
      },
    ],
    nextSyncToken: "biz-token-1",
  });
  await runFullSync(env, userId);
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev1")).toHaveLength(2);

  // Google reports a cancelled event with only id + status — nothing else.
  mock.queueList("tok-biz", {
    events: [{ id: "ev1", status: "cancelled" }],
    nextSyncToken: "biz-token-2",
  });
  await runFullSync(env, userId);

  expect(mock.deletes).toHaveLength(2);
  const deleteTargets = mock.deletes.map((d) => d.accessToken).sort();
  expect(deleteTargets).toEqual(["tok-primary", "tok-side"].sort());
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev1")).toHaveLength(0);
});

it("a replica appearing in a source account's own delta is never relayed further (duplicate-delivery regression)", async () => {
  const userId = await createTestUser();
  const primary = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });
  await createTestAccount(userId, "secondary", { email: "side@example.com", tag: "side_hustle", accessToken: "tok-side" });

  // Round 1: primary's native event fans out to biz and side (2 inserts).
  mock.queueList("tok-primary", {
    events: [
      {
        id: "ev-p1",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(2) },
        end: { dateTime: hoursFromNow(3) },
      },
    ],
    nextSyncToken: "primary-token-1",
  });
  await runFullSync(env, userId);
  expect(mock.inserts).toHaveLength(2);
  mock.inserts.length = 0; // reset for round 2 assertions

  // Round 2: bizʼs OWN delta now includes the replica that got POSTed onto its
  // calendar in round 1 (Google would report it back to us on the next poll).
  // If the replica-skip filter is broken, this would relay onward to "side"
  // and/or back to "primary" — the exact bug caught earlier in this project.
  mock.queueList("tok-biz", {
    events: [
      {
        id: "replica-on-biz",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(2) },
        end: { dateTime: hoursFromNow(3) },
        extendedProperties: {
          private: {
            syncEngine: "cf-cal-replication",
            originAccountId: primary.id,
            originEventId: "ev-p1",
            syncGroupId: userId,
          },
        },
      },
    ],
    nextSyncToken: "biz-token-1",
  });
  await runFullSync(env, userId);

  expect(mock.inserts).toHaveLength(0);
  expect(mock.patches).toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, biz.id, "replica-on-biz")).toHaveLength(0);
});

it("a 410 Gone response wipes the stored syncToken and falls back to a full re-sync", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  // First sync establishes a syncToken.
  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-stale" });
  await runFullSync(env, userId);

  // Second sync: the stored syncToken is now rejected by Google (410), then
  // the fallback timeMin-based retry succeeds and returns one event.
  mock.queueList("tok-biz", "410");
  mock.queueList("tok-biz", {
    events: [
      {
        id: "ev-recovered",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(2) },
        end: { dateTime: hoursFromNow(3) },
      },
    ],
    nextSyncToken: "biz-token-fresh",
  });
  await runFullSync(env, userId);

  expect(mock.inserts.length).toBeGreaterThan(0);
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-recovered")).not.toHaveLength(0);
});

it("skips a run entirely while another sync is genuinely in progress", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  await createTestAccount(userId, "secondary", { email: "biz@example.com", tag: "business", accessToken: "tok-biz" });

  await env.DB.prepare("INSERT INTO sync_logs (id, user_id, status) VALUES (?, ?, 'in_progress')")
    .bind(crypto.randomUUID(), userId)
    .run();

  const fetchSpy = mock.install(); // reinstall to get a fresh call-count spy
  await runFullSync(env, userId);

  expect(fetchSpy).not.toHaveBeenCalled();
});

it("recovers from a stale in_progress lock instead of deadlocking forever", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  await createTestAccount(userId, "secondary", { email: "biz@example.com", tag: "business", accessToken: "tok-biz" });

  const staleTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago > 15 min stale threshold
  await env.DB.prepare("INSERT INTO sync_logs (id, user_id, status, created_at) VALUES (?, ?, 'in_progress', ?)")
    .bind(crypto.randomUUID(), userId, staleTimestamp)
    .run();

  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-1" });
  const fetchSpy = mock.install();
  await runFullSync(env, userId);

  expect(fetchSpy).toHaveBeenCalled();
  const { results } = await env.DB.prepare("SELECT status FROM sync_logs WHERE user_id = ? ORDER BY created_at ASC")
    .bind(userId)
    .all<{ status: string }>();
  expect(results[0]!.status).toBe("error"); // the stale lock was marked error, not left dangling
  expect(results.some((r) => r.status === "success")).toBe(true); // and a real run completed after it
});

it("a replica deleted by hand (PATCH 404) is re-created instead of wedging the account forever", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  const nativeEvent = {
    id: "ev1",
    status: "confirmed" as const,
    transparency: "opaque" as const,
    start: { dateTime: hoursFromNow(2) },
    end: { dateTime: hoursFromNow(3) },
  };

  mock.queueList("tok-biz", { events: [nativeEvent], nextSyncToken: "biz-token-1" });
  await runFullSync(env, userId);
  const originalMapping = (await findEventMappingsBySource(env.DB, biz.id, "ev1"))[0]!;
  expect(mock.inserts).toHaveLength(1);

  // Second sync: event unchanged on the source, but its Primary-side replica
  // was deleted out from under us — the PATCH to fix it up will 404.
  mock.makeNextPatchGone(originalMapping.target_event_id);
  mock.queueList("tok-biz", { events: [nativeEvent], nextSyncToken: "biz-token-2" });
  await runFullSync(env, userId);

  expect(mock.inserts).toHaveLength(2); // the gone replica was re-created, not just dropped
  const mappingsAfter = await findEventMappingsBySource(env.DB, biz.id, "ev1");
  expect(mappingsAfter).toHaveLength(1); // still exactly one mapping for this (source, target) pair
  expect(mappingsAfter[0]!.target_event_id).not.toBe(originalMapping.target_event_id); // points at the new replica

  const logs = await env.DB.prepare("SELECT status FROM sync_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(userId)
    .first<{ status: string }>();
  expect(logs?.status).toBe("success"); // recovered cleanly, not logged as an error
});

it("one event that can never be inserted doesn't block the rest of the delta or advancing the syncToken", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  mock.poisonInsertsForEvent("ev-poison");
  mock.queueList("tok-biz", {
    events: [
      {
        id: "ev-poison",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(1) },
        end: { dateTime: hoursFromNow(1.5) },
      },
      {
        id: "ev-good",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(2) },
        end: { dateTime: hoursFromNow(3) },
      },
    ],
    nextSyncToken: "biz-token-1",
  });

  await runFullSync(env, userId);

  // The good event still fanned out despite the poisoned one failing.
  expect(mock.inserts.some((i) => originEventIdOf(i.body) === "ev-good")).toBe(true);
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-good")).not.toHaveLength(0);
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-poison")).toHaveLength(0);

  // The run is logged as an error (so it's visible), but the syncToken still
  // advanced — the critical part: a poisoned event doesn't cause the same
  // delta to be replayed and fail identically forever.
  const stored = await env.DB.prepare(
    "SELECT sync_token FROM sync_tokens WHERE user_id = ? AND account_id = ?",
  )
    .bind(userId, biz.id)
    .first<{ sync_token: string }>();
  expect(stored?.sync_token).toBe("biz-token-1");

  const log = await env.DB.prepare("SELECT status, message FROM sync_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(userId)
    .first<{ status: string; message: string }>();
  expect(log?.status).toBe("error");
  expect(log?.message).toContain("ev-poison");
}, 10000);

it("410 recovery reconciles pre-existing mappings, removing replicas for events deleted while the token was stale", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  // Round 1: a normal sync creates a mapping.
  mock.queueList("tok-biz", {
    events: [
      {
        id: "ev-will-vanish",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: hoursFromNow(2) },
        end: { dateTime: hoursFromNow(3) },
      },
    ],
    nextSyncToken: "biz-token-1",
  });
  await runFullSync(env, userId);
  const mappingBefore = await findEventMappingsBySource(env.DB, biz.id, "ev-will-vanish");
  expect(mappingBefore).toHaveLength(1);

  // Round 2: token expired; the forced full re-sync doesn't even mention the
  // now-deleted event (Google just omits it, doesn't report a cancellation) —
  // reconciliation must existence-check it directly.
  mock.queueList("tok-biz", "410");
  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-2" });
  mock.setEventExists("ev-will-vanish", false);
  await runFullSync(env, userId);

  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-will-vanish")).toHaveLength(0);
  expect(mock.deletes.some((d) => d.eventId === mappingBefore[0]!.target_event_id)).toBe(true);
});

it("a backlog larger than one invocation's call budget drains across two runs without re-fetching or duplicating", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  // 40 events, each fanning out to exactly 1 target (primary — no other
  // secondary in this test) — comfortably over the 35-call-per-invocation
  // budget (syncEngine.ts's MAX_CALENDAR_API_CALLS_PER_RUN).
  const events = Array.from({ length: 40 }, (_, i) => ({
    id: `ev-${i}`,
    status: "confirmed" as const,
    transparency: "opaque" as const,
    start: { dateTime: hoursFromNow(2) },
    end: { dateTime: hoursFromNow(3) },
  }));
  mock.queueList("tok-biz", { events, nextSyncToken: "biz-token-1" });

  await runFullSync(env, userId);

  // 1 call spent on the list, leaving 34 for inserts this round — not all 40.
  expect(mock.inserts).toHaveLength(34);

  // The batch isn't fully drained yet, so the real syncToken must NOT have
  // advanced — losing that would mean the 6 leftover events are never seen
  // again once a future incremental sync moves past them.
  const midRun = await env.DB.prepare("SELECT sync_token FROM sync_tokens WHERE user_id = ? AND account_id = ?")
    .bind(userId, biz.id)
    .first<{ sync_token: string }>();
  expect(midRun).toBeNull();

  // Second run: biz's already-queued backlog must NOT be re-listed from
  // Google. Checked via call count on biz's own token specifically (not "no
  // list calls at all" — the shared budget exhausting on biz's backlog in
  // round 1 also pushed primary's own first-ever, unrelated fetch to round
  // 2, which is correct fairness, not something this test is about).
  const fetchSpy = mock.install();
  await runFullSync(env, userId);

  const bizListCalls = fetchSpy.mock.calls.filter(([input, init]) => {
    const url = new URL(String(input));
    const isList = url.pathname.endsWith("/events") && (init?.method ?? "GET") === "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    return isList && headers?.Authorization === "Bearer tok-biz";
  });
  expect(bizListCalls).toHaveLength(0);

  expect(mock.inserts).toHaveLength(40); // every event now replicated exactly once
  for (const event of events) {
    expect(await findEventMappingsBySource(env.DB, biz.id, event.id)).toHaveLength(1); // never duplicated
  }

  // Queue is fully drained now — the pending syncToken is finally promoted.
  const afterRun = await env.DB.prepare("SELECT sync_token FROM sync_tokens WHERE user_id = ? AND account_id = ?")
    .bind(userId, biz.id)
    .first<{ sync_token: string }>();
  expect(afterRun?.sync_token).toBe("biz-token-1");
}, 15000);

it("an incremental delta with a far-future recurring event doesn't queue it, but still deletes a far-future cancellation", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  // Round 1: establish a real syncToken (empty delta) — this is what puts
  // the account on the incremental path for round 2, the case Google won't
  // let us bound with timeMax at all (mutually exclusive with syncToken).
  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-1" });
  await runFullSync(env, userId);

  const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString(); // ~13 months out
  const nearTerm = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour out

  // Round 2: incremental delta reports a newly-created indefinitely-recurring
  // event's expanded occurrence far outside the 30-day window, alongside a
  // normal near-term event — simulating exactly what exposed the bug (a
  // weekly series with no end date, picked up via syncToken with no bound).
  mock.queueList("tok-biz", {
    events: [
      {
        id: "ev-far-future",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: farFuture },
        end: { dateTime: farFuture },
      },
      {
        id: "ev-near-term",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: nearTerm },
        end: { dateTime: nearTerm },
      },
    ],
    nextSyncToken: "biz-token-2",
  });
  await runFullSync(env, userId);

  // Only the near-term event replicated — the far-future one was filtered
  // before ever reaching the queue, not just left unprocessed.
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-near-term")).toHaveLength(1);
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-far-future")).toHaveLength(0);
  const queued = await env.DB.prepare("SELECT event_id FROM sync_queue WHERE account_id = ?")
    .bind(biz.id)
    .all<{ event_id: string }>();
  expect(queued.results.map((r) => r.event_id)).not.toContain("ev-far-future");

  // Round 3: that far-future event gets cancelled before ever being synced.
  // Cancellations must never be dropped by the window filter — if a replica
  // had existed (e.g. created before this fix shipped), losing the
  // cancellation here would orphan it on every target calendar forever.
  mock.queueList("tok-biz", {
    events: [{ id: "ev-far-future", status: "cancelled" }],
    nextSyncToken: "biz-token-3",
  });
  await runFullSync(env, userId);

  const log = await env.DB.prepare("SELECT status FROM sync_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(userId)
    .first<{ status: string }>();
  expect(log?.status).toBe("success"); // the cancellation was processed cleanly, not silently skipped
});

it("an incremental delta with a newly-created recurring series' past occurrences doesn't queue them, only the in-window ones", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  // Round 1: establish a real syncToken, putting the account on the
  // incremental path — the case Google won't let us bound with timeMin
  // (or timeMax) at all, since they're mutually exclusive with syncToken.
  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-1" });
  await runFullSync(env, userId);

  const farPast = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString(); // ~10 months ago
  const nearTerm = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour out

  // Round 2: incremental delta reports a newly-created weekly series whose
  // start date is months in the past, alongside a normal near-term event —
  // simulating the exact production incident: Google reports every already-
  // elapsed occurrence of a brand-new series in one shot, since a delta has
  // no inherent "don't tell me about the past" behavior of its own.
  mock.queueList("tok-biz", {
    events: [
      {
        id: "ev-far-past",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: farPast },
        end: { dateTime: farPast },
      },
      {
        id: "ev-near-term",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: nearTerm },
        end: { dateTime: nearTerm },
      },
    ],
    nextSyncToken: "biz-token-2",
  });
  await runFullSync(env, userId);

  // Only the near-term event replicated — the past occurrence was filtered
  // before ever reaching the queue, matching "don't sync past events unless
  // they're repeating past the current date and time."
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-near-term")).toHaveLength(1);
  expect(await findEventMappingsBySource(env.DB, biz.id, "ev-far-past")).toHaveLength(0);
  const queued = await env.DB.prepare("SELECT event_id FROM sync_queue WHERE account_id = ?")
    .bind(biz.id)
    .all<{ event_id: string }>();
  expect(queued.results.map((r) => r.event_id)).not.toContain("ev-far-past");

  // Round 3: that far-past event gets cancelled (e.g. the whole series was
  // deleted) before ever being synced. Cancellations must never be dropped
  // by the window filter regardless of direction — a stale replica (if one
  // existed) needs cleaning up no matter how far in the past it would have been.
  mock.queueList("tok-biz", {
    events: [{ id: "ev-far-past", status: "cancelled" }],
    nextSyncToken: "biz-token-3",
  });
  await runFullSync(env, userId);

  const log = await env.DB.prepare("SELECT status FROM sync_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(userId)
    .first<{ status: string }>();
  expect(log?.status).toBe("success"); // the cancellation was processed cleanly, not silently skipped
});

it("a genuine race between two concurrent runFullSync calls only lets one proceed", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  await createTestAccount(userId, "secondary", { email: "biz@example.com", tag: "business", accessToken: "tok-biz" });

  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-1" });
  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-2" }); // only consumed if the race isn't closed

  await Promise.all([runFullSync(env, userId), runFullSync(env, userId)]);

  const { results } = await env.DB.prepare("SELECT status FROM sync_logs WHERE user_id = ?")
    .bind(userId)
    .all<{ status: string }>();
  expect(results).toHaveLength(1); // the loser never even inserted a sync_logs row
  expect(results[0]!.status).toBe("success");
});

it("the daily recurring audit picks up an occurrence the 10-minute sync would never see, and only that gap", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  // Simulate a series already discovered by a prior normal sync — its
  // covered_through is stuck a day behind today's window edge, exactly the
  // state an unedited recurring series is left in forever without this audit.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO tracked_recurring_series (user_id, account_id, recurring_event_id, covered_through) VALUES (?, ?, ?, ?)",
  )
    .bind(userId, biz.id, "series-abc", yesterday)
    .run();

  // The newly-exposed occurrence — the one thing the incremental (syncToken)
  // path could never surface on its own, since the series itself never changed.
  mock.queueInstances("tok-biz", "series-abc", [
    {
      id: "series-abc_20260901T100000Z",
      status: "confirmed",
      transparency: "opaque",
      recurringEventId: "series-abc",
      start: { dateTime: hoursFromNow(500) },
      end: { dateTime: hoursFromNow(501) },
    },
  ]);

  await runDailyRecurringAudit(env);

  // The audit only enqueues — draining (and so replication) happens on the
  // next normal sync, reusing the exact same machinery as everything else.
  const queued = await env.DB.prepare("SELECT event_id FROM sync_queue WHERE account_id = ?")
    .bind(biz.id)
    .all<{ event_id: string }>();
  expect(queued.results.map((r) => r.event_id)).toContain("series-abc_20260901T100000Z");

  mock.queueList("tok-biz", { events: [], nextSyncToken: "biz-token-1" }); // nothing new on the normal incremental path
  await runFullSync(env, userId);
  expect(await findEventMappingsBySource(env.DB, biz.id, "series-abc_20260901T100000Z")).not.toHaveLength(0);

  // covered_through advanced to today's window edge — the next daily run
  // won't re-check this same gap again.
  const row = await env.DB.prepare("SELECT covered_through FROM tracked_recurring_series WHERE account_id = ? AND recurring_event_id = ?")
    .bind(biz.id, "series-abc")
    .first<{ covered_through: string }>();
  expect(new Date(row!.covered_through).getTime()).toBeGreaterThan(new Date(yesterday).getTime());
});

it("the daily recurring audit skips a series whose covered_through is already caught up, with no API call", async () => {
  const userId = await createTestUser();
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  const wellAhead = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString(); // already past today+30d
  await env.DB.prepare(
    "INSERT INTO tracked_recurring_series (user_id, account_id, recurring_event_id, covered_through) VALUES (?, ?, ?, ?)",
  )
    .bind(userId, biz.id, "series-caught-up", wellAhead)
    .run();

  // Scoped to this series specifically, not "zero calls at all" — D1 state
  // persists across tests in this file, so an unrelated series tracked by an
  // earlier test can legitimately still need its own audit call here too.
  const fetchSpy = mock.install(); // reinstall for a fresh call-count spy
  await runDailyRecurringAudit(env);

  const calledForThisSeries = fetchSpy.mock.calls.some(([input]) => String(input).includes("series-caught-up"));
  expect(calledForThisSeries).toBe(false);
});

it("a normal sync only tracks a series on its first sighting, never overwriting a covered_through the daily audit already advanced", async () => {
  const userId = await createTestUser();
  await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });

  const advancedFar = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO tracked_recurring_series (user_id, account_id, recurring_event_id, covered_through) VALUES (?, ?, ?, ?)",
  )
    .bind(userId, biz.id, "series-already-tracked", advancedFar)
    .run();

  // A normal incremental sync sees ANOTHER occurrence of the same series —
  // this must not reset covered_through back down to today's window edge.
  mock.queueList("tok-biz", {
    events: [
      {
        id: "series-already-tracked_20260815T100000Z",
        status: "confirmed",
        transparency: "opaque",
        recurringEventId: "series-already-tracked",
        start: { dateTime: hoursFromNow(2) },
        end: { dateTime: hoursFromNow(3) },
      },
    ],
    nextSyncToken: "biz-token-1",
  });
  await runFullSync(env, userId);

  const row = await env.DB.prepare("SELECT covered_through FROM tracked_recurring_series WHERE account_id = ? AND recurring_event_id = ?")
    .bind(biz.id, "series-already-tracked")
    .first<{ covered_through: string }>();
  expect(row?.covered_through).toBe(advancedFar); // untouched, not reset
});
