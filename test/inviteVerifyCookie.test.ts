// Regression coverage for the [CRITICAL] finding from an independent
// security review of Phase 7.3 (see task_plan.md): verification was tracked
// purely on the invite's own DB row (status='verified'), so once *anyone*
// verified a link, anyone else who later obtained the same URL — forwarded
// mail, a shared screenshot, a mailing-list archive — could read and act on
// it with no proof of their own inbox control. This is a route-layer bug
// (the cookie is set/read by routes/booking.tsx and routes/pollVoting.tsx,
// not by the trustedAccess.ts service functions the rest of the test suite
// exercises directly), so these tests drive the real Hono app end-to-end via
// its exported fetch handler, not the service layer.
import { env } from "cloudflare:workers";
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import {
  createInvite,
  requestEmailVerification,
  confirmEmailVerification,
  castPollVotes,
  getPollTally,
  createMeetingPollWithSlots,
  allowedAppointmentDurations,
} from "../src/services/trustedAccess";
import { getOrCreateSchedulingSettings, listMeetingPollSlots } from "../src/db/schema";
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
// current date, not an arbitrary far-off one, since markInviteVerified's
// `expires_at > strftime(...,'now')` check runs against D1's own clock,
// unaffected by vi.useFakeTimers().
const realNow = new Date();
const FIXED_NOW = new Date(Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth(), realNow.getUTCDate(), 12, 0, 0));

function pinTime() {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
}

async function setup() {
  const userId = await createTestUser();
  const account = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  return { userId, account };
}

function latestCode(): string {
  return mock.sends[mock.sends.length - 1]!.html.match(/(\d{6})/)![1]!;
}

function cookieHeaderFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header in the response");
  return setCookie.split(";")[0]!;
}

function form(fields: Record<string, string>): { headers: Record<string, string>; body: string } {
  return { headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
}

// --- Appointment flow (routes/booking.tsx) ---

it("booking: a cookie-less GET after someone else verified the invite shows the verify form, not the slot picker", async () => {
  pinTime();
  const { userId, account } = await setup();
  const settings = await getOrCreateSchedulingSettings(env.DB, userId);
  const id = await createInvite(env, {
    userId,
    accountId: account.id,
    kind: "appointment",
    inviteeEmail: "invitee@example.com",
    durationMinutes: allowedAppointmentDurations(settings)[0]!,
    modality: "in_person",
  });
  // Verified via the service layer directly — simulates someone else having
  // completed verification from a different browser; no cookie exists here.
  await requestEmailVerification(env, id, "invitee@example.com");
  await confirmEmailVerification(env, id, "invitee@example.com", latestCode());

  const res = await worker.fetch(new Request(`https://cal.test/book/${id}`), env);
  const text = await res.text();
  expect(text).toContain("Verify your email");
  expect(text).not.toContain("Pick a time");
});

it("booking: a cookie-less POST /confirm after someone else verified doesn't book anything", async () => {
  pinTime();
  const { userId, account } = await setup();
  const settings = await getOrCreateSchedulingSettings(env.DB, userId);
  const id = await createInvite(env, {
    userId,
    accountId: account.id,
    kind: "appointment",
    inviteeEmail: "invitee@example.com",
    durationMinutes: allowedAppointmentDurations(settings)[0]!,
    modality: "in_person",
  });
  await requestEmailVerification(env, id, "invitee@example.com");
  await confirmEmailVerification(env, id, "invitee@example.com", latestCode());

  const res = await worker.fetch(
    new Request(`https://cal.test/book/${id}/confirm`, { method: "POST", ...form({ start: new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000).toISOString() }) }),
    env,
  );
  const text = await res.text();
  expect(text).toContain("This link isn&#39;t available anymore.");
  expect(googleMock.inserts).toHaveLength(0);
});

it("booking: the legitimate verifier's own cookie, obtained through the real HTTP flow, unlocks the slot picker and lets them book", async () => {
  pinTime();
  const { userId, account } = await setup();
  const settings = await getOrCreateSchedulingSettings(env.DB, userId);
  const id = await createInvite(env, {
    userId,
    accountId: account.id,
    kind: "appointment",
    inviteeEmail: "invitee@example.com",
    durationMinutes: allowedAppointmentDurations(settings)[0]!,
    modality: "in_person",
  });

  await worker.fetch(new Request(`https://cal.test/book/${id}/verify`, { method: "POST", ...form({ email: "invitee@example.com" }) }), env);
  const confirmRes = await worker.fetch(
    new Request(`https://cal.test/book/${id}/confirm-email`, { method: "POST", ...form({ email: "invitee@example.com", code: latestCode() }) }),
    env,
  );
  const cookie = cookieHeaderFrom(confirmRes);
  expect(await confirmRes.text()).toContain("Pick a time"); // renders the slot picker immediately, same response

  const getRes = await worker.fetch(new Request(`https://cal.test/book/${id}`, { headers: { cookie } }), env);
  const getText = await getRes.text();
  expect(getText).toContain("Pick a time");

  // Slot picker renders as radio inputs (Phase 9 UI redesign), not <select><option> —
  // same `name="start"` / value semantics, different markup.
  const slotMatch = getText.match(/<input type="radio" name="start" value="([^"]+)"/);
  expect(slotMatch).not.toBeNull();
  const start = slotMatch![1]!;

  const bookRes = await worker.fetch(
    new Request(`https://cal.test/book/${id}/confirm`, { method: "POST", headers: { ...form({ start }).headers, cookie }, body: form({ start }).body }),
    env,
  );
  expect(await bookRes.text()).toContain("Appointment booked — CAL");
  expect(googleMock.inserts).toHaveLength(1);
});

it("booking: a cookie scoped to a DIFFERENT invite doesn't unlock this one", async () => {
  pinTime();
  const { userId, account } = await setup();
  const settings = await getOrCreateSchedulingSettings(env.DB, userId);
  const durationMinutes = allowedAppointmentDurations(settings)[0]!;
  const idA = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "a@example.com", durationMinutes, modality: "in_person" });
  const idB = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "b@example.com", durationMinutes, modality: "in_person" });

  await worker.fetch(new Request(`https://cal.test/book/${idA}/verify`, { method: "POST", ...form({ email: "a@example.com" }) }), env);
  const confirmResA = await worker.fetch(
    new Request(`https://cal.test/book/${idA}/confirm-email`, { method: "POST", ...form({ email: "a@example.com", code: latestCode() }) }),
    env,
  );
  const cookieA = cookieHeaderFrom(confirmResA);

  // B is also legitimately verified (so this isolates "wrong cookie" from
  // "never verified"), just not by whoever holds cookieA.
  await requestEmailVerification(env, idB, "b@example.com");
  await confirmEmailVerification(env, idB, "b@example.com", latestCode());

  const res = await worker.fetch(new Request(`https://cal.test/book/${idB}`, { headers: { cookie: cookieA } }), env);
  const text = await res.text();
  expect(text).toContain("Verify your email");
  expect(text).not.toContain("Pick a time");
});

// --- Meeting poll flow (routes/pollVoting.tsx) ---

async function pollWithSlot(userId: string, accountId: string) {
  const pollId = await createMeetingPollWithSlots(env, {
    userId,
    accountId,
    title: "Sync",
    durationMinutes: 30,
    modality: "in_person",
    slotStarts: [new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(), new Date(FIXED_NOW.getTime() + 48 * 60 * 60 * 1000).toISOString()],
  });
  const slots = await listMeetingPollSlots(env.DB, pollId);
  return { pollId, slots };
}

it("poll: a cookie-less GET after someone else verified shows the verify form, not the voting form", async () => {
  pinTime();
  const { userId, account } = await setup();
  const { pollId } = await pollWithSlot(userId, account.id);
  const inviteId = await createInvite(env, { userId, accountId: account.id, kind: "meeting_poll", inviteeEmail: "alice@example.com", meetingPollId: pollId });
  await requestEmailVerification(env, inviteId, "alice@example.com");
  await confirmEmailVerification(env, inviteId, "alice@example.com", latestCode());

  const res = await worker.fetch(new Request(`https://cal.test/meet/${inviteId}`), env);
  const text = await res.text();
  expect(text).toContain("Verify your email");
  expect(text).not.toContain("Mark which of these times work");
});

it("poll: a cookie-less vote after someone else verified doesn't overwrite their ballot — reproduces the reported scenario exactly", async () => {
  pinTime();
  const { userId, account } = await setup();
  const { pollId, slots } = await pollWithSlot(userId, account.id);
  const inviteId = await createInvite(env, { userId, accountId: account.id, kind: "meeting_poll", inviteeEmail: "alice@example.com", meetingPollId: pollId });
  await requestEmailVerification(env, inviteId, "alice@example.com");
  await confirmEmailVerification(env, inviteId, "alice@example.com", latestCode());
  // Alice's own legitimate vote (service layer stands in for her real,
  // cookie-bearing session — this test is about what a DIFFERENT,
  // cookie-less caller can do to her ballot afterward).
  await castPollVotes(env, inviteId, { [slots[0]!.id]: true, [slots[1]!.id]: true });
  const before = await getPollTally(env, pollId);
  expect(before.slots.find((s) => s.slot.id === slots[0]!.id)?.availableCount).toBe(1);

  const res = await worker.fetch(
    new Request(`https://cal.test/meet/${inviteId}/vote`, {
      method: "POST",
      ...form({ [`available:${slots[0]!.id}`]: "no", [`available:${slots[1]!.id}`]: "no" }),
    }),
    env,
  );
  expect(await res.text()).toContain("This link isn&#39;t available anymore.");

  const after = await getPollTally(env, pollId);
  expect(after.slots.find((s) => s.slot.id === slots[0]!.id)?.availableCount).toBe(1); // unchanged, not flipped to 0
});

it("poll: the legitimate verifier's own cookie, obtained through the real HTTP flow, lets them vote", async () => {
  pinTime();
  const { userId, account } = await setup();
  const { pollId, slots } = await pollWithSlot(userId, account.id);
  const inviteId = await createInvite(env, { userId, accountId: account.id, kind: "meeting_poll", inviteeEmail: "alice@example.com", meetingPollId: pollId });

  await worker.fetch(new Request(`https://cal.test/meet/${inviteId}/verify`, { method: "POST", ...form({ email: "alice@example.com" }) }), env);
  const confirmRes = await worker.fetch(
    new Request(`https://cal.test/meet/${inviteId}/confirm-email`, { method: "POST", ...form({ email: "alice@example.com", code: latestCode() }) }),
    env,
  );
  const cookie = cookieHeaderFrom(confirmRes);
  expect(await confirmRes.text()).toContain("Mark which of these times work"); // renders the voting form immediately

  const voteRes = await worker.fetch(
    new Request(`https://cal.test/meet/${inviteId}/vote`, {
      method: "POST",
      headers: { ...form({ [`available:${slots[0]!.id}`]: "yes" }).headers, cookie },
      body: form({ [`available:${slots[0]!.id}`]: "yes" }).body,
    }),
    env,
  );
  expect(voteRes.status).toBe(200);

  const tally = await getPollTally(env, pollId);
  expect(tally.slots.find((s) => s.slot.id === slots[0]!.id)?.availableCount).toBe(1);
});
