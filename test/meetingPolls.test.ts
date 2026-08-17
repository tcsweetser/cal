import { env } from "cloudflare:workers";
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createInvite,
  requestEmailVerification,
  confirmEmailVerification,
  createMeetingPollWithSlots,
  getPollForInvite,
  castPollVotes,
  getPollTally,
  finalizePoll,
  cancelPoll,
} from "../src/services/trustedAccess";
import { findMeetingPoll, listMeetingPollSlots, updateSchedulingSettings } from "../src/db/schema";
import { ResendMock } from "./helpers/emailMock";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { createTestUser, createTestAccount } from "./helpers/fixtures";

let mock: ResendMock;
let googleMock: GoogleCalendarMock;

beforeEach(() => {
  mock = new ResendMock();
  mock.install();
  googleMock = new GoogleCalendarMock();
  googleMock.install();
});

afterEach(() => {
  vi.useRealTimers();
});

// Same reasoning as trustedAccess.test.ts's FIXED_NOW: anchored to the real
// current date (not an arbitrary far-off one) because markInviteVerified's
// `expires_at > strftime(...,'now')` check runs against D1's real system
// clock, completely unaffected by vi.useFakeTimers().
const realNow = new Date();
const FIXED_NOW = new Date(Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth(), realNow.getUTCDate(), 12, 0, 0));

function pinTime() {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
}

function atOffsetHours(hours: number): string {
  return new Date(FIXED_NOW.getTime() + hours * 60 * 60 * 1000).toISOString();
}

async function setup() {
  const userId = await createTestUser();
  const account = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  return { userId, account };
}

async function createPollWithSlots(
  userId: string,
  accountId: string,
  opts: { modality?: "in_person" | "remote"; slotHours?: number[] } = {},
): Promise<string> {
  return createMeetingPollWithSlots(env, {
    userId,
    accountId,
    title: "Team sync",
    durationMinutes: 30,
    modality: opts.modality ?? "in_person",
    slotStarts: (opts.slotHours ?? [24, 48]).map(atOffsetHours),
  });
}

// Mirrors trustedAccess.test.ts's verifiedAppointmentInvite: creates a
// kind='meeting_poll' invite for one participant and drives it through email
// verification, returning the invite id ready to vote with.
async function verifiedPollInvite(userId: string, accountId: string, pollId: string, email: string): Promise<string> {
  const id = await createInvite(env, { userId, accountId, kind: "meeting_poll", inviteeEmail: email, meetingPollId: pollId });
  await requestEmailVerification(env, id, email);
  const code = mock.sends[mock.sends.length - 1]!.html.match(/(\d{6})/)![1]!;
  await confirmEmailVerification(env, id, email, code);
  return id;
}

it("full poll lifecycle: two participants converge on a slot, finalize books it, the link expires after the meeting ends", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const slots = await listMeetingPollSlots(env.DB, pollId);
  expect(slots).toHaveLength(2);

  const inviteA = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");
  const inviteB = await verifiedPollInvite(userId, account.id, pollId, "bob@example.com");

  // Both available on slots[0], only Alice available on slots[1].
  expect(await castPollVotes(env, inviteA, { [slots[0]!.id]: true, [slots[1]!.id]: true })).toEqual({ ok: true });
  expect(await castPollVotes(env, inviteB, { [slots[0]!.id]: true, [slots[1]!.id]: false })).toEqual({ ok: true });

  const tally = await getPollTally(env, pollId);
  expect(tally.totalParticipants).toBe(2);
  expect(tally.slots.find((s) => s.slot.id === slots[0]!.id)?.fullyAvailable).toBe(true);
  expect(tally.slots.find((s) => s.slot.id === slots[1]!.id)?.fullyAvailable).toBe(false);

  const result = await finalizePoll(env, userId, pollId);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");

  const poll = await findMeetingPoll(env.DB, pollId);
  expect(poll?.status).toBe("finalized");
  expect(poll?.chosen_slot_id).toBe(slots[0]!.id);
  expect(poll?.google_event_id).toBe(result.googleEventId);
  expect(googleMock.inserts).toHaveLength(1);
  const body = googleMock.inserts[0]!.body as { summary: string; description?: string };
  expect(body.summary).not.toContain("Team sync"); // generic placeholder only — no poll title on the real calendar
  expect(body.description).toBeUndefined(); // in-person: no Meet link

  // Still viewable (read-only) right up to the meeting's end...
  const stillUp = await getPollForInvite(env, inviteA);
  expect(stillUp.ok).toBe(true);
  if (!stillUp.ok) throw new Error("unreachable");
  expect(stillUp.poll.status).toBe("finalized");

  // ...but not after it, per task_plan.md Phase 7.3's time-based (not
  // fixed-TTL) expiry for poll links.
  vi.setSystemTime(new Date(Date.parse(poll!.booked_end!) + 60 * 1000));
  const afterMeeting = await getPollForInvite(env, inviteB);
  expect(afterMeeting).toEqual({ ok: false, reason: "poll-concluded" });
});

it("a participant can change their vote before finalize", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const [slot] = await listMeetingPollSlots(env.DB, pollId);
  const invite = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");

  expect(await castPollVotes(env, invite, { [slot!.id]: true })).toEqual({ ok: true });
  let tally = await getPollTally(env, pollId);
  expect(tally.slots[0]!.availableCount).toBe(1);

  expect(await castPollVotes(env, invite, { [slot!.id]: false })).toEqual({ ok: true });
  tally = await getPollTally(env, pollId);
  expect(tally.slots[0]!.availableCount).toBe(0); // overwritten, not accumulated
  expect(tally.totalParticipants).toBe(1); // still counted as a participant
});

it("finalize refuses when no candidate slot has every participant available", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const slots = await listMeetingPollSlots(env.DB, pollId);
  const inviteA = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");
  const inviteB = await verifiedPollInvite(userId, account.id, pollId, "bob@example.com");
  await castPollVotes(env, inviteA, { [slots[0]!.id]: true });
  await castPollVotes(env, inviteB, { [slots[0]!.id]: false, [slots[1]!.id]: true });

  const result = await finalizePoll(env, userId, pollId);
  expect(result).toEqual({ ok: false, reason: "no-fully-available-slot" });
  expect(googleMock.inserts).toHaveLength(0);
});

it("finalize refuses with no participants at all (never divides by zero into a false positive)", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id);
  const result = await finalizePoll(env, userId, pollId);
  expect(result).toEqual({ ok: false, reason: "no-fully-available-slot" });
});

it("rejects a second finalize attempt on the same poll (atomic claim before the Google write)", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const [slot] = await listMeetingPollSlots(env.DB, pollId);
  const invite = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");
  await castPollVotes(env, invite, { [slot!.id]: true });

  const first = await finalizePoll(env, userId, pollId);
  expect(first.ok).toBe(true);
  const second = await finalizePoll(env, userId, pollId);
  expect(second).toEqual({ ok: false, reason: "poll-not-open" });
  expect(googleMock.inserts).toHaveLength(1); // second attempt never reached Google at all
});

it("refuses to vote once the poll is no longer open (finalized or cancelled)", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const [slot] = await listMeetingPollSlots(env.DB, pollId);
  const invite = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");
  await castPollVotes(env, invite, { [slot!.id]: true });
  await finalizePoll(env, userId, pollId);

  const lateVote = await castPollVotes(env, invite, { [slot!.id]: false });
  expect(lateVote).toEqual({ ok: false, reason: "poll-not-open" });
});

it("cancelling an open poll stops further voting and can't be finalized", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const [slot] = await listMeetingPollSlots(env.DB, pollId);
  const invite = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");

  expect(await cancelPoll(env, userId, pollId)).toBe(true);
  expect(await cancelPoll(env, userId, pollId)).toBe(false); // already cancelled, not idempotently "true" again

  // getPollForInvite treats a cancelled poll as an unusable link outright
  // (same "not-found"-shaped failure as an expired/revoked invite), so
  // castPollVotes — which calls it first — reports the generic
  // invite-not-available reason here rather than poll-not-open; that reason
  // is reserved for a poll that's already been finalized (see the "refuses
  // to vote once the poll is no longer open" test above).
  expect(await castPollVotes(env, invite, { [slot!.id]: true })).toEqual({ ok: false, reason: "invite-not-available" });
  expect(await finalizePoll(env, userId, pollId)).toEqual({ ok: false, reason: "poll-not-open" });

  const link = await getPollForInvite(env, invite);
  expect(link).toEqual({ ok: false, reason: "poll-cancelled" });
});

it("rejects a vote against a slot id that doesn't belong to this poll", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const invite = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");

  const result = await castPollVotes(env, invite, { "not-a-real-slot-id": true });
  expect(result).toEqual({ ok: false, reason: "invalid-slot" });
});

it("refuses to vote before completing email verification", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const [slot] = await listMeetingPollSlots(env.DB, pollId);
  const id = await createInvite(env, { userId, accountId: account.id, kind: "meeting_poll", inviteeEmail: "alice@example.com", meetingPollId: pollId });

  const result = await castPollVotes(env, id, { [slot!.id]: true });
  expect(result).toEqual({ ok: false, reason: "invite-not-available" });
});

it("a forwarded poll link verified by a different email still works, matching the appointment flow's identity model", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const [slot] = await listMeetingPollSlots(env.DB, pollId);
  const id = await createInvite(env, {
    userId,
    accountId: account.id,
    kind: "meeting_poll",
    inviteeEmail: "original@example.com",
    meetingPollId: pollId,
  });
  await requestEmailVerification(env, id, "forwarded-to@example.com");
  const code = mock.sends[0]!.html.match(/(\d{6})/)![1]!;
  expect(await confirmEmailVerification(env, id, "forwarded-to@example.com", code)).toEqual({ ok: true });

  expect(await castPollVotes(env, id, { [slot!.id]: true })).toEqual({ ok: true });
  const tally = await getPollTally(env, pollId);
  expect(tally.totalParticipants).toBe(1); // counted once, under the verified (forwarded-to) address
});

it("remote polls mint a Meet link via the designated account, distinct from the target calendar", async () => {
  pinTime();
  const { userId, account: targetAccount } = await setup();
  const meetAccount = await createTestAccount(userId, "secondary", { email: "meet@example.com", tag: "business", accessToken: "tok-meet" });
  await updateSchedulingSettings(env.DB, userId, {
    minDurationMinutes: 30,
    maxDurationMinutes: 90,
    durationStepMinutes: 15,
    bufferMinutes: 15,
    workdayStartMinutes: 0,
    workdayEndMinutes: 1440,
    meetAccountId: meetAccount.id,
  });

  const pollId = await createPollWithSlots(userId, targetAccount.id, { modality: "remote", slotHours: [24, 48] });
  const [slot] = await listMeetingPollSlots(env.DB, pollId);
  const invite = await verifiedPollInvite(userId, targetAccount.id, pollId, "alice@example.com");
  await castPollVotes(env, invite, { [slot!.id]: true });

  const result = await finalizePoll(env, userId, pollId);
  expect(result.ok).toBe(true);

  expect(googleMock.inserts).toHaveLength(2);
  const meetRoomInsert = googleMock.inserts.find((i) => i.accessToken === "tok-meet");
  const targetInsert = googleMock.inserts.find((i) => i.accessToken === "tok-primary");
  expect(meetRoomInsert?.body).toMatchObject({ conferenceData: { createRequest: expect.anything() } });
  expect(targetInsert?.body.description).toContain("https://meet.google.com/");
});

it("createMeetingPollWithSlots refuses a remote poll when no Meet account is configured", async () => {
  const { userId, account } = await setup();
  await expect(createPollWithSlots(userId, account.id, { modality: "remote", slotHours: [24, 48] })).rejects.toThrow(/Meet account/);
});

it("createMeetingPollWithSlots requires at least 2 distinct future candidate times", async () => {
  const { userId, account } = await setup();
  await expect(createPollWithSlots(userId, account.id, { slotHours: [24] })).rejects.toThrow(/at least 2/);
  // A past time and a duplicate both collapse away, leaving fewer than 2.
  await expect(
    createMeetingPollWithSlots(env, {
      userId,
      accountId: account.id,
      title: "x",
      durationMinutes: 30,
      modality: "in_person",
      slotStarts: [new Date(Date.now() - 60 * 60 * 1000).toISOString(), atOffsetHours(24), atOffsetHours(24)],
    }),
  ).rejects.toThrow(/at least 2/);
});

it("createMeetingPollWithSlots rejects a duration outside the configured range", async () => {
  const { userId, account } = await setup();
  await expect(
    createMeetingPollWithSlots(env, {
      userId,
      accountId: account.id,
      title: "x",
      durationMinutes: 5, // below the default min (30)
      modality: "in_person",
      slotStarts: [atOffsetHours(24), atOffsetHours(48)],
    }),
  ).rejects.toThrow(/durationMinutes must be one of/);
});

it("createMeetingPollWithSlots refuses to create a poll against another user's account", async () => {
  const { userId } = await setup();
  const otherUserId = await createTestUser("other");
  const otherAccount = await createTestAccount(otherUserId, "primary", { email: "other-owner@example.com", accessToken: "tok-other" });

  await expect(createPollWithSlots(userId, otherAccount.id)).rejects.toThrow(/does not belong to user/);
});

// --- Regressions: the Phase 7.1 post-commit security review's protections
// (task_plan.md) must hold for poll invites too, not just appointment ones —
// same underlying requestEmailVerification/confirmEmailVerification code
// path, but verified explicitly rather than just assumed inherited. ---

it("refuses a resend to the same address before the cooldown elapses, for a poll invite too", async () => {
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const id = await createInvite(env, { userId, accountId: account.id, kind: "meeting_poll", inviteeEmail: "alice@example.com", meetingPollId: pollId });

  expect(await requestEmailVerification(env, id, "alice@example.com")).toEqual({ ok: true });
  expect(await requestEmailVerification(env, id, "alice@example.com")).toEqual({ ok: false, reason: "cooldown" });
  expect(mock.sends).toHaveLength(1);
});

it("a resend does not reset the attempt lockout for a poll invite (was a full rate-limit bypass)", async () => {
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const id = await createInvite(env, { userId, accountId: account.id, kind: "meeting_poll", inviteeEmail: "alice@example.com", meetingPollId: pollId });
  await requestEmailVerification(env, id, "alice@example.com");
  const firstCode = mock.sends[0]!.html.match(/(\d{6})/)![1]!;
  const wrongCode = firstCode === "000000" ? "111111" : "000000";

  for (let i = 0; i < 5; i++) {
    await confirmEmailVerification(env, id, "alice@example.com", wrongCode);
  }
  expect(await confirmEmailVerification(env, id, "alice@example.com", firstCode)).toEqual({ ok: false, reason: "too-many-attempts" });
});

// --- Regressions: an independent security review of this Phase 7.3
// implementation (task_plan.md) found and fixed 6 further issues beyond the
// Phase 7.1 protections above. Each of these covers one of them. ---

it("finalize refuses to book a slot once it's already in the past, and reports a distinct reason from 'nobody agreed' (was: books a real past-dated event)", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const [slot] = await listMeetingPollSlots(env.DB, pollId);
  const invite = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");
  await castPollVotes(env, invite, { [slot!.id]: true });

  // Nobody ever finalizes, and time marches on past the only
  // fully-available candidate.
  vi.setSystemTime(new Date(FIXED_NOW.getTime() + 25 * 60 * 60 * 1000));

  const result = await finalizePoll(env, userId, pollId);
  expect(result).toEqual({ ok: false, reason: "all-candidates-in-the-past" });
  expect(googleMock.inserts).toHaveLength(0); // never reached Google — no past-dated event created

  const pollAfter = await findMeetingPoll(env.DB, pollId);
  expect(pollAfter?.status).toBe("open"); // not claimed/stuck — a fresh poll can still be created and finalized normally
});

it("a cancel landing between the slot claim and the finalize-completion write isn't silently reverted back to finalized", async () => {
  pinTime();
  const { userId, account } = await setup();
  const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
  const [slot] = await listMeetingPollSlots(env.DB, pollId);
  const invite = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");
  await castPollVotes(env, invite, { [slot!.id]: true });

  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/calendar/v3/calendars/primary/events" && (init?.method ?? "GET") === "POST") {
      // Simulates a concurrent cancel request landing in the window between
      // tryClaimPollSlot and finalizeMeetingPollBooking — this is exactly
      // the race an independent security review reproduced by cancelling
      // from inside a mocked Google call and observing the poll end up
      // 'finalized' anyway with a real google_event_id.
      await cancelPoll(env, userId, pollId);
    }
    return originalFetch(input, init);
  });

  const result = await finalizePoll(env, userId, pollId);
  expect(result).toEqual({ ok: false, reason: "cancelled-during-finalize" });

  const pollAfter = await findMeetingPoll(env.DB, pollId);
  expect(pollAfter?.status).toBe("cancelled"); // stays cancelled, not silently flipped back to 'finalized'
  // The real event WAS created before the cancel was noticed — an accepted,
  // documented tradeoff (finalizePoll logs the orphan for manual cleanup),
  // not a data-loss bug in itself; what matters is the poll's own status
  // isn't lied about afterward.
  expect(googleMock.inserts).toHaveLength(1);
});

it(
  "releases the claimed slot and reports calendar-unavailable when the Google write fails after claiming, so a later finalize attempt isn't permanently blocked",
  async () => {
    const { userId, account } = await setup();
    const pollId = await createPollWithSlots(userId, account.id, { slotHours: [24, 48] });
    const [slot] = await listMeetingPollSlots(env.DB, pollId);
    const invite = await verifiedPollInvite(userId, account.id, pollId, "alice@example.com");
    await castPollVotes(env, invite, { [slot!.id]: true });

    // Not pinTime() here — googleFetch's real retry backoff uses a real
    // setTimeout, which deadlocks against vi.useFakeTimers() (an independent
    // security review hit exactly this trying to reproduce the same bug).
    googleMock.poisonAllInserts();
    const failed = await finalizePoll(env, userId, pollId);
    expect(failed).toEqual({ ok: false, reason: "calendar-unavailable" });

    const pollAfterFailure = await findMeetingPoll(env.DB, pollId);
    expect(pollAfterFailure?.status).toBe("open");
    expect(pollAfterFailure?.chosen_slot_id).toBeNull(); // released, not stuck forever

    // A later attempt, once Google recovers, can still succeed — the
    // earlier failure didn't permanently brick this poll (the actual bug:
    // tryClaimPollSlot's CAS requires chosen_slot_id IS NULL to claim again).
    googleMock = new GoogleCalendarMock();
    googleMock.install();
    const retried = await finalizePoll(env, userId, pollId);
    expect(retried.ok).toBe(true);
  },
  15000,
);
