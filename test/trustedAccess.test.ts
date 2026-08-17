import { env } from "cloudflare:workers";
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createInvite,
  sendInviteEmail,
  requestEmailVerification,
  confirmEmailVerification,
  computeAvailableSlots,
  confirmAppointmentBooking,
  allowedAppointmentDurations,
  consumeInvite,
  getUsableInvite,
} from "../src/services/trustedAccess";
import { findTrustedInvite, markAccountStatus, createAccount, getOrCreateSchedulingSettings, updateSchedulingSettings } from "../src/db/schema";
import { ResendMock } from "./helpers/emailMock";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { createTestUser, createTestAccount } from "./helpers/fixtures";

let mock: ResendMock;
let googleMock: GoogleCalendarMock;

beforeEach(() => {
  mock = new ResendMock();
  mock.install();
  // Each mock's install() delegates unrecognized URLs to whatever fetch was
  // already stubbed (see emailMock.ts/googleMock.ts) — so installing both in
  // the same test composes correctly regardless of order.
  googleMock = new GoogleCalendarMock();
  googleMock.install();
});

afterEach(() => {
  vi.useRealTimers();
});

async function verifiedAppointmentInvite(
  userId: string,
  accountId: string,
  opts: { durationMinutes?: number; modality?: "in_person" | "remote" } = {},
): Promise<string> {
  const settings = await getOrCreateSchedulingSettings(env.DB, userId);
  const id = await createInvite(env, {
    userId,
    accountId,
    kind: "appointment",
    inviteeEmail: "invitee@example.com",
    durationMinutes: opts.durationMinutes ?? allowedAppointmentDurations(settings)[0]!,
    modality: opts.modality ?? "in_person",
  });
  await requestEmailVerification(env, id, "invitee@example.com");
  const code = mock.sends[mock.sends.length - 1]!.html.match(/(\d{6})/)![1]!;
  await confirmEmailVerification(env, id, "invitee@example.com", code);
  return id;
}

function wrongCodeFor(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

async function setup() {
  const userId = await createTestUser();
  const account = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  return { userId, account };
}

it("issues an invite and emails it to the invitee, not any other address", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });
  await sendInviteEmail(env, { id, inviteeEmail: "invitee@example.com", kind: "appointment" }, "https://example.workers.dev");

  expect(mock.sends).toHaveLength(1);
  expect(mock.sends[0]!.to).toBe("invitee@example.com");
  expect(mock.sends[0]!.html).toContain(`/book/${id}`);
});

it("full verify-then-consume flow: wrong code fails without consuming an attempt budget it shouldn't, right code verifies, consume succeeds exactly once", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });

  await requestEmailVerification(env, id, "invitee@example.com");
  expect(mock.sends).toHaveLength(1);
  const sentCode = mock.sends[0]!.html.match(/(\d{6})/)![1]!;

  const wrong = await confirmEmailVerification(env, id, "invitee@example.com", wrongCodeFor(sentCode));
  expect(wrong).toEqual({ ok: false, reason: "wrong-code" });

  const right = await confirmEmailVerification(env, id, "invitee@example.com", sentCode);
  expect(right).toEqual({ ok: true });

  const invite = await findTrustedInvite(env.DB, id);
  expect(invite?.status).toBe("verified");
  expect(invite?.verified_email).toBe("invitee@example.com");

  expect(await consumeInvite(env, id)).toBe(true);
  expect(await consumeInvite(env, id)).toBe(false); // single-use: second consume rejected

  const used = await findTrustedInvite(env.DB, id);
  expect(used?.status).toBe("used");
});

it("verifying with a forwarded link's own email works — identity is proven per-verifier, not tied to the original invitee", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, {
    userId,
    accountId: account.id,
    kind: "appointment",
    inviteeEmail: "original-invitee@example.com",
    durationMinutes: 30,
    modality: "in_person",
  });

  await requestEmailVerification(env, id, "forwarded-to@example.com");
  const sentCode = mock.sends[0]!.html.match(/(\d{6})/)![1]!;

  const result = await confirmEmailVerification(env, id, "forwarded-to@example.com", sentCode);
  expect(result).toEqual({ ok: true });

  const invite = await findTrustedInvite(env.DB, id);
  expect(invite?.verified_email).toBe("forwarded-to@example.com");
  expect(invite?.invitee_email).toBe("original-invitee@example.com"); // unchanged
});

it("rejects a code after 5 wrong attempts, even if the 6th guess would have been correct", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });
  await requestEmailVerification(env, id, "invitee@example.com");
  const sentCode = mock.sends[0]!.html.match(/(\d{6})/)![1]!;
  const wrongCode = wrongCodeFor(sentCode);

  for (let i = 0; i < 5; i++) {
    const result = await confirmEmailVerification(env, id, "invitee@example.com", wrongCode);
    expect(result.ok).toBe(false);
  }

  const finalTry = await confirmEmailVerification(env, id, "invitee@example.com", sentCode);
  expect(finalTry).toEqual({ ok: false, reason: "too-many-attempts" });
});

it("consumeInvite fails on an invite that was never verified", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });
  expect(await consumeInvite(env, id)).toBe(false);
});

it("getUsableInvite reports a not-found invite distinctly from a real one", async () => {
  const result = await getUsableInvite(env, "does-not-exist");
  expect(result).toEqual({ invite: null, reason: "not-found" });
});

// --- Regressions for the post-commit security review (see task_plan.md Phase 7.1) ---

it("degrades gracefully (not a 500) when the email provider fails, and doesn't start a resend cooldown for a code that was never delivered — caught for real during Phase 7.3's wrangler dev smoke test", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });

  // Persistent failure, not makeNextSendFail's single-shot one: resendFetch
  // (emailService.ts) retries 429/5xx internally, so a one-shot failure gets
  // silently absorbed by a successful retry — this needs every attempt to
  // fail to actually exercise a fully-exhausted send. Fake timers skip the
  // real backoff sleeps between those retry attempts.
  mock.makeAllSendsFail();
  vi.useFakeTimers();
  const failedPromise = requestEmailVerification(env, id, "invitee@example.com");
  await vi.runAllTimersAsync();
  const failed = await failedPromise;
  expect(failed).toEqual({ ok: false, reason: "send-failed" });
  vi.useRealTimers();
  mock.stopFailingAllSends();

  // No cooldown lock and no dangling verification row from the failed
  // attempt — a normal retry immediately after must succeed outright.
  const retried = await requestEmailVerification(env, id, "invitee@example.com");
  expect(retried).toEqual({ ok: true });
  expect(mock.sends).toHaveLength(1);
});

it("refuses to send a verification code against a nonexistent invite id (was an open mail relay)", async () => {
  const result = await requestEmailVerification(env, "does-not-exist", "victim@example.com");
  expect(result).toEqual({ ok: false, reason: "invite-not-available" });
  expect(mock.sends).toHaveLength(0);
});

it("refuses a resend to the same address before the cooldown elapses", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });

  const first = await requestEmailVerification(env, id, "invitee@example.com");
  expect(first).toEqual({ ok: true });
  const second = await requestEmailVerification(env, id, "invitee@example.com");
  expect(second).toEqual({ ok: false, reason: "cooldown" });
  expect(mock.sends).toHaveLength(1); // second attempt never sent
});

it("caps how many distinct addresses one invite can request codes for", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });

  for (let i = 0; i < 5; i++) {
    const result = await requestEmailVerification(env, id, `target-${i}@example.com`);
    expect(result).toEqual({ ok: true });
  }
  const sixth = await requestEmailVerification(env, id, "target-5@example.com");
  expect(sixth).toEqual({ ok: false, reason: "too-many-targets" });
  expect(mock.sends).toHaveLength(5);
});

it("a resend does not reset the attempt lockout (was a full rate-limit bypass)", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });
  await requestEmailVerification(env, id, "invitee@example.com");
  const firstCode = mock.sends[0]!.html.match(/(\d{6})/)![1]!;
  const wrongCode = wrongCodeFor(firstCode);

  for (let i = 0; i < 5; i++) {
    await confirmEmailVerification(env, id, "invitee@example.com", wrongCode);
  }
  expect((await confirmEmailVerification(env, id, "invitee@example.com", firstCode))).toEqual({
    ok: false,
    reason: "too-many-attempts",
  });

  // Simulate the cooldown having elapsed (backdating directly, rather than a
  // real 60s wait) and request a fresh code for the same address.
  await env.DB.prepare(
    "UPDATE email_verifications SET created_at = '2000-01-01T00:00:00.000Z' WHERE invite_id = ? AND email = ?",
  )
    .bind(id, "invitee@example.com")
    .run();
  const resend = await requestEmailVerification(env, id, "invitee@example.com");
  expect(resend).toEqual({ ok: true });
  const secondCode = mock.sends[1]!.html.match(/(\d{6})/)![1]!;

  // The lockout must still be in effect — even the brand-new, correct code
  // is rejected, because `attempts` was never reset by the resend.
  const stillLocked = await confirmEmailVerification(env, id, "invitee@example.com", secondCode);
  expect(stillLocked).toEqual({ ok: false, reason: "too-many-attempts" });
});

// Regression: an independent security review of Phase 7.3 found that the
// resend cooldown above never actually terminates — every resend refreshes
// created_at, sliding the 60s window forward forever rather than ending it
// — so nothing capped the *total* number of emails one (invite, email) pair
// could ever receive. Backdates created_at directly (same technique as the
// lockout test above) rather than a real 60s wait per iteration.
it("caps total emails sent to one address over an invite's lifetime, independent of (and in addition to) the resend cooldown", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });

  for (let i = 0; i < 10; i++) {
    const result = await requestEmailVerification(env, id, "invitee@example.com");
    expect(result).toEqual({ ok: true });
    await env.DB.prepare("UPDATE email_verifications SET created_at = '2000-01-01T00:00:00.000Z' WHERE invite_id = ? AND email = ?")
      .bind(id, "invitee@example.com")
      .run();
  }
  expect(mock.sends).toHaveLength(10);

  const eleventh = await requestEmailVerification(env, id, "invitee@example.com");
  // Reuses the "cooldown" reason rather than a distinct one — an attacker
  // probing for a lifetime-cap error shouldn't learn anything a normal
  // too-soon resend wouldn't also tell them.
  expect(eleventh).toEqual({ ok: false, reason: "cooldown" });
  expect(mock.sends).toHaveLength(10); // no 11th send, even though the cooldown alone was cleared
});

it("refuses to create an invite against another user's account (security model: invite creation is the one place trust originates)", async () => {
  const { userId } = await setup();
  const otherUserId = await createTestUser("other");
  const otherAccount = await createTestAccount(otherUserId, "primary", { email: "other-owner@example.com", accessToken: "tok-other" });

  await expect(
    createInvite(env, {
      userId,
      accountId: otherAccount.id,
      kind: "appointment",
      inviteeEmail: "invitee@example.com",
      durationMinutes: 30,
      modality: "in_person",
    }),
  ).rejects.toThrow(/does not belong to user/);
});

it("refuses to create an invite against a non-active account", async () => {
  const { userId, account } = await setup();
  await markAccountStatus(env.DB, account.id, "revoked");

  await expect(
    createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" }),
  ).rejects.toThrow(/is not active/);
});

it("never reports verification success against an invite that's already used (was state drift)", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com", durationMinutes: 30, modality: "in_person" });
  await requestEmailVerification(env, id, "invitee@example.com");
  const code = mock.sends[0]!.html.match(/(\d{6})/)![1]!;
  expect(await confirmEmailVerification(env, id, "invitee@example.com", code)).toEqual({ ok: true });
  expect(await consumeInvite(env, id)).toBe(true); // status now 'used'

  const replay = await confirmEmailVerification(env, id, "invitee@example.com", code);
  expect(replay).toEqual({ ok: false, reason: "invite-not-available" });

  const invite = await findTrustedInvite(env.DB, id);
  expect(invite?.status).toBe("used"); // unchanged, not silently re-flipped
});

// --- Phase 7.2: appointment booking (confirmAppointmentBooking) ---

// Noon UTC on the real current date — comfortably inside the default
// 9:00-17:00 UTC workday window, so slot math is deterministic without
// depending on what hour the suite happens to run at. Deliberately *not* an
// arbitrary fixed calendar date: expires_at comparisons in tryConsumeInvite/
// markInviteVerified (schema.ts) use SQLite's own `strftime(...,'now')`,
// which runs on D1's real system clock and is completely unaffected by
// vi.useFakeTimers() — pinning JS's Date.now() to a date months away from
// the real one would make every "not yet expired" check fail against SQL's
// real `now`, even though the JS side thinks it's fine.
const realNow = new Date();
const FIXED_NOW = new Date(Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth(), realNow.getUTCDate(), 12, 0, 0));

function pinTime() {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
}

it("computes real availability: offers slots within the default workday window at the default step", async () => {
  pinTime();
  const { userId, account } = await setup();
  const id = await verifiedAppointmentInvite(userId, account.id);

  const result = await computeAvailableSlots(env, id);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.slots.length).toBeGreaterThan(0);
  for (const slot of result.slots) {
    const minutes = new Date(slot).getUTCHours() * 60 + new Date(slot).getUTCMinutes();
    expect(minutes).toBeGreaterThanOrEqual(9 * 60);
    expect(minutes).toBeLessThan(17 * 60);
  }
});

it("books a real appointment from an offered slot: creates exactly one placeholder event, records the booking, marks the invite used", async () => {
  pinTime();
  const { userId, account } = await setup();
  const id = await verifiedAppointmentInvite(userId, account.id, { durationMinutes: 30 });

  const available = await computeAvailableSlots(env, id);
  if (!available.ok) throw new Error("unreachable");
  const start = available.slots[0]!;

  const result = await confirmAppointmentBooking(env, id, start);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");

  expect(googleMock.inserts).toHaveLength(1);
  const body = googleMock.inserts[0]!.body as {
    summary: string;
    description?: string;
    start: { dateTime: string };
    end: { dateTime: string };
  };
  expect(body.summary).not.toContain("invitee"); // generic placeholder only — no invitee detail on the real calendar
  expect(body.description).toBeUndefined(); // in-person: no Meet link to embed
  expect(new Date(body.end.dateTime).getTime() - new Date(body.start.dateTime).getTime()).toBe(30 * 60 * 1000);

  const invite = await findTrustedInvite(env.DB, id);
  expect(invite?.status).toBe("used");
  expect(invite?.google_event_id).toBe(result.googleEventId);
  expect(invite?.booked_start).toBe(start);
});

it("rejects booking a time in the past", async () => {
  pinTime();
  const { userId, account } = await setup();
  const id = await verifiedAppointmentInvite(userId, account.id);

  const result = await confirmAppointmentBooking(env, id, new Date(FIXED_NOW.getTime() - 60 * 60 * 1000).toISOString());
  expect(result).toEqual({ ok: false, reason: "invalid-time" });
  expect(googleMock.inserts).toHaveLength(0);
});

it("rejects a second booking attempt on the same invite (single-use, atomic consume before the Google write)", async () => {
  pinTime();
  const { userId, account } = await setup();
  const id = await verifiedAppointmentInvite(userId, account.id);

  const available = await computeAvailableSlots(env, id);
  if (!available.ok) throw new Error("unreachable");

  const first = await confirmAppointmentBooking(env, id, available.slots[0]!);
  expect(first.ok).toBe(true);
  const second = await confirmAppointmentBooking(env, id, available.slots[1]!);
  expect(second).toEqual({ ok: false, reason: "invite-not-available" });
  expect(googleMock.inserts).toHaveLength(1); // second attempt never reached Google at all
});

it("refuses to book (or offer slots for) an invite that hasn't been email-verified yet", async () => {
  pinTime();
  const { userId, account } = await setup();
  const id = await createInvite(env, {
    userId,
    accountId: account.id,
    kind: "appointment",
    inviteeEmail: "invitee@example.com",
    durationMinutes: 30,
    modality: "in_person",
  });

  expect(await computeAvailableSlots(env, id)).toEqual({ ok: false, reason: "invite-not-available" });
  const result = await confirmAppointmentBooking(env, id, FIXED_NOW.toISOString());
  expect(result).toEqual({ ok: false, reason: "invite-not-available" });
  expect(googleMock.inserts).toHaveLength(0);
});

it("enforces the configured buffer: excludes a slot too close to an existing event, and confirms the same rule again at booking time", async () => {
  pinTime();
  const { userId, account } = await setup();
  await updateSchedulingSettings(env.DB, userId, {
    minDurationMinutes: 30,
    maxDurationMinutes: 90,
    durationStepMinutes: 15,
    bufferMinutes: 15,
    workdayStartMinutes: 9 * 60,
    workdayEndMinutes: 17 * 60,
    meetAccountId: null,
  });
  // Busy one hour after FIXED_NOW, for 30 minutes. With a 15-minute buffer,
  // nothing may start closer than 15 minutes before that block starts (a
  // 30-min meeting + 15-min buffer must clear the block's start) or within
  // 15 minutes after it ends.
  const atOffset = (minutes: number) => new Date(FIXED_NOW.getTime() + minutes * 60 * 1000).toISOString();
  googleMock.setFreeBusy("tok-primary", [{ start: atOffset(60), end: atOffset(90) }]);

  const id = await verifiedAppointmentInvite(userId, account.id, { durationMinutes: 30 });
  const result = await computeAvailableSlots(env, id);
  if (!result.ok) throw new Error("unreachable");

  expect(result.slots).not.toContain(atOffset(30)); // ends right as the buffer would start
  expect(result.slots).toContain(atOffset(105)); // clears the buffer exactly (90 + 15)

  // Re-check at confirm time, not just the offered list: booking a slot that
  // violates the buffer directly (bypassing computeAvailableSlots entirely)
  // must still be rejected — this is the real enforcement point.
  const stale = await confirmAppointmentBooking(env, id, atOffset(30));
  expect(stale).toEqual({ ok: false, reason: "slot-no-longer-available" });
  expect(googleMock.inserts).toHaveLength(0);
});

it("restricts offered slots to the configured workday window", async () => {
  pinTime();
  const { userId, account } = await setup();
  await updateSchedulingSettings(env.DB, userId, {
    minDurationMinutes: 30,
    maxDurationMinutes: 90,
    durationStepMinutes: 15,
    bufferMinutes: 0,
    workdayStartMinutes: 10 * 60,
    workdayEndMinutes: 11 * 60,
    meetAccountId: null,
  });

  const id = await verifiedAppointmentInvite(userId, account.id, { durationMinutes: 30 });
  const result = await computeAvailableSlots(env, id);
  if (!result.ok) throw new Error("unreachable");

  expect(result.slots.length).toBeGreaterThan(0);
  for (const slot of result.slots) {
    const minutes = new Date(slot).getUTCHours() * 60 + new Date(slot).getUTCMinutes();
    expect(minutes).toBeGreaterThanOrEqual(10 * 60);
    expect(minutes + 30).toBeLessThanOrEqual(11 * 60);
  }
});

it("rejects an appointment duration outside the configured range", async () => {
  const { userId, account } = await setup();
  await expect(
    createInvite(env, {
      userId,
      accountId: account.id,
      kind: "appointment",
      inviteeEmail: "invitee@example.com",
      durationMinutes: 10, // below the default min (30)
      modality: "in_person",
    }),
  ).rejects.toThrow(/durationMinutes must be one of/);
});

it("remote appointments mint a Meet link via the designated account, regardless of which calendar hosts the appointment", async () => {
  pinTime();
  const { userId, account: targetAccount } = await setup();
  const meetAccount = await createTestAccount(userId, "secondary", {
    email: "meet@example.com",
    tag: "business",
    accessToken: "tok-meet",
  });
  await updateSchedulingSettings(env.DB, userId, {
    minDurationMinutes: 30,
    maxDurationMinutes: 90,
    durationStepMinutes: 15,
    bufferMinutes: 15,
    workdayStartMinutes: 9 * 60,
    workdayEndMinutes: 17 * 60,
    meetAccountId: meetAccount.id,
  });

  const id = await verifiedAppointmentInvite(userId, targetAccount.id, { durationMinutes: 30, modality: "remote" });
  const available = await computeAvailableSlots(env, id);
  if (!available.ok) throw new Error("unreachable");

  const result = await confirmAppointmentBooking(env, id, available.slots[0]!);
  expect(result.ok).toBe(true);

  expect(googleMock.inserts).toHaveLength(2);
  const meetRoomInsert = googleMock.inserts.find((i) => i.accessToken === "tok-meet");
  const targetInsert = googleMock.inserts.find((i) => i.accessToken === "tok-primary");
  expect(meetRoomInsert?.body).toMatchObject({ conferenceData: { createRequest: expect.anything() } });
  expect(targetInsert?.body.description).toContain("https://meet.google.com/");
  expect(targetInsert?.body.description).not.toContain("invitee"); // still no invitee-supplied content
});

it("createInvite refuses a remote appointment when no Meet account is configured", async () => {
  const { userId, account } = await setup();
  await expect(
    createInvite(env, {
      userId,
      accountId: account.id,
      kind: "appointment",
      inviteeEmail: "invitee@example.com",
      durationMinutes: 30,
      modality: "remote",
    }),
  ).rejects.toThrow(/Meet account/);
});

it("reports meet-unavailable if the designated Meet account is deactivated after the invite was created", async () => {
  pinTime();
  const { userId, account } = await setup();
  const meetAccount = await createTestAccount(userId, "secondary", {
    email: "meet@example.com",
    tag: "business",
    accessToken: "tok-meet",
  });
  await updateSchedulingSettings(env.DB, userId, {
    minDurationMinutes: 30,
    maxDurationMinutes: 90,
    durationStepMinutes: 15,
    bufferMinutes: 15,
    workdayStartMinutes: 9 * 60,
    workdayEndMinutes: 17 * 60,
    meetAccountId: meetAccount.id,
  });
  const id = await verifiedAppointmentInvite(userId, account.id, { durationMinutes: 30, modality: "remote" });

  await markAccountStatus(env.DB, meetAccount.id, "revoked");

  expect(await computeAvailableSlots(env, id)).toEqual({ ok: false, reason: "meet-unavailable" });
  const result = await confirmAppointmentBooking(env, id, new Date(FIXED_NOW.getTime() + 60 * 60 * 1000).toISOString());
  expect(result).toEqual({ ok: false, reason: "meet-unavailable" });
  expect(googleMock.inserts).toHaveLength(0);
});

it("degrades gracefully (not a 500) when the target account's Google access is broken — caught for real during this phase's wrangler dev smoke test", async () => {
  pinTime();
  const { userId } = await setup();
  // An account row with no stored tokens at all — the exact shape of the
  // real bug this regression test is for: getValidAccessToken throws
  // rather than returning, and computeAvailableSlots/confirmAppointmentBooking
  // must not let that propagate as an uncaught exception to a public,
  // unauthenticated caller.
  const brokenAccountId = crypto.randomUUID();
  await createAccount(env.DB, { id: brokenAccountId, userId, email: "broken@example.com", role: "primary", tag: null });

  const id = await verifiedAppointmentInvite(userId, brokenAccountId);
  expect(await computeAvailableSlots(env, id)).toEqual({ ok: false, reason: "invite-not-available" });
  const result = await confirmAppointmentBooking(env, id, new Date(FIXED_NOW.getTime() + 60 * 60 * 1000).toISOString());
  expect(result).toEqual({ ok: false, reason: "invite-not-available" });
});

it("getOrCreateSchedulingSettings returns sane defaults and is idempotent", async () => {
  const userId = await createTestUser();
  const first = await getOrCreateSchedulingSettings(env.DB, userId);
  expect(first).toMatchObject({
    min_duration_minutes: 30,
    max_duration_minutes: 90,
    duration_step_minutes: 15,
    buffer_minutes: 15,
    meet_account_id: null,
  });
  expect(allowedAppointmentDurations(first)).toEqual([30, 45, 60, 75, 90]);

  const second = await getOrCreateSchedulingSettings(env.DB, userId);
  expect(second).toEqual(first); // no second row, no reset
});

it("updateSchedulingSettings changes the allowed duration range for future invites", async () => {
  const userId = await createTestUser();
  await getOrCreateSchedulingSettings(env.DB, userId); // seed defaults first, matching real usage
  await updateSchedulingSettings(env.DB, userId, {
    minDurationMinutes: 20,
    maxDurationMinutes: 40,
    durationStepMinutes: 10,
    bufferMinutes: 10,
    workdayStartMinutes: 9 * 60,
    workdayEndMinutes: 17 * 60,
    meetAccountId: null,
  });
  const updated = await getOrCreateSchedulingSettings(env.DB, userId);
  expect(allowedAppointmentDurations(updated)).toEqual([20, 30, 40]);
});
