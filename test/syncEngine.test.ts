import { env } from "cloudflare:workers";
import { it, expect, beforeEach } from "vitest";
import { runFullSync } from "../src/services/syncEngine";
import { findEventMappingsBySource } from "../src/db/schema";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { createTestUser, createTestAccount } from "./helpers/fixtures";

function originEventIdOf(body: Record<string, unknown>): string | undefined {
  const props = body.extendedProperties as { private?: { originEventId?: string } } | undefined;
  return props?.private?.originEventId;
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
        start: { dateTime: "2026-08-12T10:00:00Z" },
        end: { dateTime: "2026-08-12T11:00:00Z" },
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
        start: { date: "2026-08-12" },
        end: { date: "2026-08-13" },
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
    start: { dateTime: "2026-08-12T10:00:00Z" },
    end: { dateTime: "2026-08-12T11:00:00Z" },
  };

  mock.queueList("tok-biz", { events: [nativeEvent], nextSyncToken: "biz-token-1" });
  await runFullSync(env, userId);
  expect(mock.inserts).toHaveLength(1);
  const mappingsAfterCreate = await findEventMappingsBySource(env.DB, biz.id, "ev1");
  expect(mappingsAfterCreate).toHaveLength(1);
  const targetEventId = mappingsAfterCreate[0]!.target_event_id;

  // Second sync: same event id, changed time, still native (no extendedProperties).
  mock.queueList("tok-biz", {
    events: [{ ...nativeEvent, start: { dateTime: "2026-08-12T14:00:00Z" }, end: { dateTime: "2026-08-12T15:00:00Z" } }],
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
        start: { dateTime: "2026-08-12T10:00:00Z" },
        end: { dateTime: "2026-08-12T11:00:00Z" },
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
        start: { dateTime: "2026-08-12T10:00:00Z" },
        end: { dateTime: "2026-08-12T11:00:00Z" },
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
        start: { dateTime: "2026-08-12T10:00:00Z" },
        end: { dateTime: "2026-08-12T11:00:00Z" },
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
        start: { dateTime: "2026-08-12T10:00:00Z" },
        end: { dateTime: "2026-08-12T11:00:00Z" },
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
    start: { dateTime: "2026-08-12T10:00:00Z" },
    end: { dateTime: "2026-08-12T11:00:00Z" },
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
        start: { dateTime: "2026-08-12T09:00:00Z" },
        end: { dateTime: "2026-08-12T09:30:00Z" },
      },
      {
        id: "ev-good",
        status: "confirmed",
        transparency: "opaque",
        start: { dateTime: "2026-08-12T10:00:00Z" },
        end: { dateTime: "2026-08-12T11:00:00Z" },
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
        start: { dateTime: "2026-08-12T10:00:00Z" },
        end: { dateTime: "2026-08-12T11:00:00Z" },
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
