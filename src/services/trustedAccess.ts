// Shared trusted-party access layer for TODO.md's two features (appointment
// dialog, multi-party meeting planner — see task_plan.md Phase 7). An invite
// needs no account in this system, but whoever actually uses the link must
// verify control of the email address they're using first — even if the
// link was forwarded on from the person it was originally sent to, since
// identity here is "proven control of this inbox," not "matches the
// original recipient."
//
// Phase 7.1: invite issuance, email delivery, and the verify/consume
// lifecycle, shared by both features below. Phase 7.2: appointment booking
// (single-use invites, real availability). Phase 7.3: the meeting-planner
// poll functions further down — poll invites are *not* single-use like an
// appointment invite (voting is resubmittable across multiple visits until
// the poll is finalized), so they never go through tryConsumeInvite at all;
// their usability is instead governed by isPollLinkExpired, tied to the
// chosen slot's end time once finalized.

import { sha256Hex, importHmacKey, signJSON, verifyJSON } from "../lib/crypto";
import { sendEmail } from "../lib/emailService";
import { getValidAccessToken } from "./tokenManager";
import { insertEvent, insertEventWithMeetLink, getCalendarTimeZone, fetchFreeBusy, type FreeBusyInterval } from "./googleCalendar";
import type { Env } from "../types";
import {
  createTrustedInvite,
  findTrustedInvite,
  findAccountForUser,
  getOrCreateSchedulingSettings,
  markInviteVerified,
  tryConsumeInvite,
  recordAppointmentBooking,
  upsertEmailVerification,
  findEmailVerification,
  countVerificationTargets,
  incrementVerificationAttempts,
  createMeetingPoll,
  findMeetingPoll,
  findMeetingPollForUser,
  createMeetingPollSlots,
  listMeetingPollSlots,
  castVote,
  listVotesForPoll,
  countDistinctParticipants,
  tryClaimPollSlot,
  finalizeMeetingPollBooking,
  releasePollSlotClaim,
  cancelOpenPoll,
  type TrustedInviteKind,
  type TrustedInviteRow,
  type AppointmentModality,
  type SchedulingSettingsRow,
  type MeetingPollRow,
  type MeetingPollSlotRow,
} from "../db/schema";

const INVITE_TTL_MS: Record<TrustedInviteKind, number> = {
  appointment: 7 * 24 * 60 * 60 * 1000,
  meeting_poll: 30 * 24 * 60 * 60 * 1000,
};
const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;
// Resending before this elapses is refused — without a cooldown,
// requestEmailVerification is a free "send one email to any address" call on
// every invocation, regardless of whether the code is ever guessed.
const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
// Caps how many distinct addresses one invite can ever request a code for.
// Forwarding a link to a *few* alternate addresses is the intended use case;
// an unbounded count turns one valid invite id into an open mail relay.
const MAX_VERIFICATION_TARGETS_PER_INVITE = 5;
// Caps total emails ever sent to one (invite, email) pair, independent of
// the resend cooldown above — the cooldown alone never terminates (every
// resend refreshes created_at, sliding the window forward forever; see
// migration 0005's comment on email_verifications.sends), so over a poll
// invite's 30-day TTL that's tens of thousands of sends to one address with
// no other limit in place. Found in an independent security review of Phase
// 7.3. 10 is generous for a legitimate participant needing a few retries
// across the invite's full lifetime.
const MAX_VERIFICATION_SENDS_PER_TARGET = 10;

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmailFormat(email: string): boolean {
  return EMAIL_FORMAT_RE.test(email);
}

function generateNumericCode(): string {
  // 6 digits, zero-padded. crypto.getRandomValues, not Math.random — this
  // code gates a real calendar action, the same trust bar as the OAuth PKCE
  // state elsewhere in this codebase.
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, "0");
}

// Proves the caller has completed email verification for THIS specific
// invite — set as a signed, HttpOnly, path-scoped cookie (routes/booking.tsx,
// routes/pollVoting.tsx) once confirmEmailVerification succeeds, and checked
// before rendering/accepting anything past the email-verify step. Closes a
// real gap found in an independent security review of Phase 7.3: before
// this, verification was tracked purely on the invite's own DB row
// (status='verified'), so once *anyone* verified a link, anyone else who
// later obtained the same URL — forwarded mail, a shared screenshot, a
// mailing-list archive — could read and act on it with no proof of their
// own inbox control, for as long as the invite stayed valid (up to 30 days
// for a poll). The route layer additionally scopes the cookie's Path to
// this exact invite (`/book/:id` / `/meet/:id`) so it's never even sent for
// a different invite's requests, and callers here further require the
// signed payload's inviteId to match, and its email to match the invite's
// own recorded verified_email — closing the analogous gap where a *second*,
// different email could independently pass its own code check (allowed by
// confirmEmailVerification's existing 'verified'-status branch, unchanged
// by this fix) and receive a valid cookie that then can't actually be used
// for anything, rather than silently acting under the first verifier's
// identity.
export const INVITE_VERIFY_COOKIE = "trusted_invite_verify";

interface InviteVerifyCookiePayload {
  inviteId: string;
  email: string;
}

export async function signInviteVerifyCookie(env: Env, inviteId: string, email: string): Promise<string> {
  const key = await importHmacKey(env.SESSION_SECRET);
  const payload: InviteVerifyCookiePayload = { inviteId, email };
  return signJSON(key, payload);
}

// Returns the verified email if `cookieValue` is a validly-signed,
// untampered cookie for exactly this inviteId — null for anything else
// (missing, malformed, tampered, or scoped to a different invite). Callers
// treat null as "not verified from this browser," regardless of what the
// invite's own DB status says.
export async function verifyInviteVerifyCookie(
  env: Env,
  inviteId: string,
  cookieValue: string | undefined,
): Promise<string | null> {
  if (!cookieValue) return null;
  const key = await importHmacKey(env.SESSION_SECRET);
  const payload = await verifyJSON<InviteVerifyCookiePayload>(key, cookieValue);
  if (!payload || payload.inviteId !== inviteId) return null;
  return payload.email;
}

// Matches the cookie's lifetime to the invite kind's own TTL (see
// INVITE_TTL_MS below) — long enough that a poll participant who verifies
// once doesn't need to re-verify on every visit across the poll's full
// voting window.
export function inviteCookieMaxAgeSeconds(kind: TrustedInviteKind): number {
  return Math.floor(INVITE_TTL_MS[kind] / 1000);
}

function isInviteReceivingVerification(invite: TrustedInviteRow, now = Date.now()): boolean {
  // A code can be requested/confirmed against a 'pending' invite (normal
  // case) or a 'verified' one (idempotent re-confirm, e.g. a page refresh
  // before the booking step) — never 'used'/'revoked', and never expired.
  return (invite.status === "pending" || invite.status === "verified") && Date.parse(invite.expires_at) > now;
}

// Owner-configurable range (scheduling_settings, migration 0006), not a
// hardcoded list — e.g. min=30/max=90/step=15 -> [30, 45, 60, 75, 90].
export function allowedAppointmentDurations(settings: SchedulingSettingsRow): number[] {
  const durations: number[] = [];
  for (let d = settings.min_duration_minutes; d <= settings.max_duration_minutes; d += settings.duration_step_minutes) {
    durations.push(d);
  }
  return durations;
}

export interface CreateInviteInput {
  userId: string;
  accountId: string;
  kind: TrustedInviteKind;
  inviteeEmail: string;
  meetingPollId?: string;
  // Both required for kind='appointment' (validated below); unused for
  // 'meeting_poll', whose timing/format come from meeting_poll_slots (Phase 7.3).
  durationMinutes?: number;
  modality?: AppointmentModality;
}

// Security model (task_plan.md Phase 7): invite creation is the one place in
// this whole feature where trust originates — everything downstream (email
// verification, booking/voting) only ever acts within a grant this function
// already made, and can never mint a new one. So this checked in depth, not
// just at the route layer that will call it (Phase 7.2/7.3): the caller
// supplies userId (expected to come from an authenticated session — routes
// must never call this without requireAuth having run first) and this
// function independently re-verifies accountId actually belongs to that
// user before creating anything, closing the gap where a route bug (or a
// future call site that forgets the check) could let an authenticated user
// target an account — and so a calendar — that isn't theirs.
export async function createInvite(env: Env, input: CreateInviteInput): Promise<string> {
  if (!isValidEmailFormat(input.inviteeEmail)) {
    throw new Error(`createInvite: invitee_email is not a valid email address: ${input.inviteeEmail}`);
  }
  const account = await findAccountForUser(env.DB, input.userId, input.accountId);
  if (!account) {
    throw new Error(`createInvite: account ${input.accountId} does not belong to user ${input.userId}`);
  }
  if (account.status !== "active") {
    throw new Error(`createInvite: account ${input.accountId} is not active (status: ${account.status})`);
  }

  let durationMinutes: number | null = null;
  let modality: AppointmentModality | null = null;
  if (input.kind === "appointment") {
    const settings = await getOrCreateSchedulingSettings(env.DB, input.userId);
    const allowed = allowedAppointmentDurations(settings);
    if (input.durationMinutes == null || !allowed.includes(input.durationMinutes)) {
      throw new Error(`createInvite: durationMinutes must be one of ${allowed.join(", ")} for kind='appointment'`);
    }
    if (input.modality == null) {
      throw new Error("createInvite: modality ('in_person' or 'remote') is required for kind='appointment'");
    }
    // Fail at creation time, not when the invitee tries to book — a remote
    // invite whose Meet account isn't configured (or was never active) would
    // otherwise only surface as a dead end deep in the booking flow.
    if (input.modality === "remote") {
      if (!settings.meet_account_id) {
        throw new Error("createInvite: remote appointments require a Meet account to be configured in Settings first");
      }
      const meetAccount = await findAccountForUser(env.DB, input.userId, settings.meet_account_id);
      if (!meetAccount || meetAccount.status !== "active") {
        throw new Error("createInvite: the configured Meet account is no longer active — update it in Settings");
      }
    }
    durationMinutes = input.durationMinutes;
    modality = input.modality;
  } else if (!input.meetingPollId) {
    throw new Error("createInvite: meetingPollId is required for kind='meeting_poll'");
  }

  const id = crypto.randomUUID();
  await createTrustedInvite(env.DB, {
    id,
    userId: input.userId,
    accountId: input.accountId,
    kind: input.kind,
    inviteeEmail: input.inviteeEmail,
    meetingPollId: input.meetingPollId ?? null,
    durationMinutes,
    modality,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS[input.kind]).toISOString(),
  });
  return id;
}

// baseUrl is the Worker's own origin (derived from the incoming request, same
// pattern the OAuth callback uses — see routes/auth.ts — rather than a
// hardcoded domain, so this works identically in local dev and production).
export async function sendInviteEmail(
  env: Env,
  invite: { id: string; inviteeEmail: string; kind: TrustedInviteKind },
  baseUrl: string,
): Promise<void> {
  const path = invite.kind === "appointment" ? "book" : "meet";
  const url = `${baseUrl}/${path}/${invite.id}`;
  const subject =
    invite.kind === "appointment" ? "You're invited to book an appointment" : "You're invited to a scheduling poll";
  await sendEmail(env, {
    to: invite.inviteeEmail,
    subject,
    html: `<p>Follow this link to continue: <a href="${url}">${url}</a></p><p>If this wasn't meant for you, you can ignore this email.</p>`,
  });
}

export type RequestVerificationResult =
  | { ok: true }
  | { ok: false; reason: "invite-not-available" | "invalid-email" | "cooldown" | "too-many-targets" | "send-failed" };

// Three checks stand between this and being an unauthenticated "email
// anyone, anytime" relay (all added in this project's post-commit security
// review — see task_plan.md Phase 7.1): the invite must genuinely exist and
// be usable (closes sending mail against a garbage/nonexistent id), a resend
// to the same address is cooldown-limited (closes unlimited free sends to
// one target), and the number of distinct addresses one invite can ever
// target is capped (closes unlimited targets from one valid invite).
export async function requestEmailVerification(
  env: Env,
  inviteId: string,
  email: string,
): Promise<RequestVerificationResult> {
  if (!isValidEmailFormat(email)) return { ok: false, reason: "invalid-email" };

  const invite = await findTrustedInvite(env.DB, inviteId);
  if (!invite || !isInviteReceivingVerification(invite)) {
    return { ok: false, reason: "invite-not-available" };
  }

  const existing = await findEmailVerification(env.DB, inviteId, email);
  if (existing && Date.now() - Date.parse(existing.created_at) < VERIFICATION_RESEND_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown" };
  }
  // Reuses the "cooldown" reason rather than a distinct one — an attacker
  // probing for a send-count limit shouldn't get a different response shape
  // than an ordinary too-soon resend; a legitimate caller sees the same
  // "wait / check your inbox" message either way.
  if (existing && existing.sends >= MAX_VERIFICATION_SENDS_PER_TARGET) {
    return { ok: false, reason: "cooldown" };
  }
  if (!existing) {
    const targetCount = await countVerificationTargets(env.DB, inviteId);
    if (targetCount >= MAX_VERIFICATION_TARGETS_PER_INVITE) {
      return { ok: false, reason: "too-many-targets" };
    }
  }

  const code = generateNumericCode();
  // Send before persisting the code hash, not after: a Resend outage/
  // misconfiguration must degrade to a normal "couldn't send" response, not
  // an uncaught exception reaching app.onError's bare 500 for a public,
  // unauthenticated caller — the same class of gap
  // computeAvailableSlots/confirmAppointmentBooking already guard against
  // for Google failures (Phase 7.2), caught here for real during this
  // phase's wrangler dev smoke test (a genuine 401 from Resend against a
  // placeholder local API key), not hypothetical. Ordering matters beyond
  // just catching the throw: writing the row *before* a failed send would
  // also start the resend cooldown for a code the recipient never got,
  // locking them out of retrying for no reason — sending first avoids that
  // too, and a failed attempt leaves no row at all, so a later successful
  // retry is a plain first-time upsert.
  try {
    await sendEmail(env, {
      to: email,
      subject: "Your verification code",
      html: `<p>Your verification code is <strong>${code}</strong>. It expires in 10 minutes.</p>`,
    });
  } catch (err) {
    console.error(`requestEmailVerification: send failed for invite ${inviteId}:`, err instanceof Error ? err.message : err);
    return { ok: false, reason: "send-failed" };
  }
  const codeHash = await sha256Hex(code);
  await upsertEmailVerification(env.DB, {
    id: crypto.randomUUID(),
    inviteId,
    email,
    codeHash,
    expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS).toISOString(),
  });
  return { ok: true };
}

export type ConfirmVerificationResult =
  | { ok: true }
  | { ok: false; reason: "invite-not-available" | "not-requested" | "expired" | "too-many-attempts" | "wrong-code" };

// Checks attempts/expiry before comparing the code, then increments attempts
// only on a wrong guess — mirrors tokenManager.ts's double-check-before-
// refresh in spirit: this narrows the concurrent-double-submit race (two
// guesses both passing the attempts check before either increments) rather
// than eliminating it outright, an accepted tradeoff at this codebase's
// existing bar given the code is also short-TTL and attempt-capped.
export async function confirmEmailVerification(
  env: Env,
  inviteId: string,
  email: string,
  code: string,
): Promise<ConfirmVerificationResult> {
  const invite = await findTrustedInvite(env.DB, inviteId);
  if (!invite || !isInviteReceivingVerification(invite)) {
    return { ok: false, reason: "invite-not-available" };
  }

  const verification = await findEmailVerification(env.DB, inviteId, email);
  if (!verification) return { ok: false, reason: "not-requested" };
  if (verification.attempts >= MAX_VERIFICATION_ATTEMPTS) return { ok: false, reason: "too-many-attempts" };
  if (Date.parse(verification.expires_at) <= Date.now()) return { ok: false, reason: "expired" };

  const codeHash = await sha256Hex(code);
  if (codeHash !== verification.code_hash) {
    await incrementVerificationAttempts(env.DB, verification.id);
    return { ok: false, reason: "wrong-code" };
  }

  // Already 'verified' (idempotent re-confirm, e.g. a page refresh) needs no
  // further write. Otherwise the invite was 'pending' (the only other state
  // isInviteReceivingVerification allows) — attempt the transition and
  // actually check whether it took: markInviteVerified can lose a race (the
  // invite was consumed/revoked between the read above and this write) and
  // now reports that via its return value instead of the caller blindly
  // trusting it, which previously let this function report `ok: true` even
  // when the invite's real status hadn't changed (state drift, caught in
  // this project's post-commit security review — see task_plan.md Phase 7.1).
  if (invite.status === "pending") {
    const transitioned = await markInviteVerified(env.DB, inviteId, email);
    if (!transitioned) return { ok: false, reason: "invite-not-available" };
  }
  return { ok: true };
}

export function isInviteExpired(invite: TrustedInviteRow, now = Date.now()): boolean {
  return Date.parse(invite.expires_at) <= now;
}

export async function getUsableInvite(
  env: Env,
  id: string,
): Promise<{ invite: TrustedInviteRow } | { invite: null; reason: "not-found" | "expired" | "revoked" }> {
  const invite = await findTrustedInvite(env.DB, id);
  if (!invite) return { invite: null, reason: "not-found" };
  if (invite.status === "revoked") return { invite: null, reason: "revoked" };
  if (isInviteExpired(invite)) return { invite: null, reason: "expired" };
  return { invite };
}

// Wraps the atomic UPDATE in db/schema.ts with the same-shaped result as
// getUsableInvite, so callers (routes/booking.tsx) don't need two different
// failure-handling styles for "can't read this invite" vs "can't consume it".
export async function consumeInvite(env: Env, id: string): Promise<boolean> {
  return tryConsumeInvite(env.DB, id);
}

// Slots are offered/accepted every AVAILABILITY_WINDOW_DAYS out, stepped by
// the owner's duration_step_minutes — implementation details, not owner-
// facing parameters (only duration range/step and buffer were asked to be
// configurable), so these stay plain constants.
const AVAILABILITY_WINDOW_DAYS = 7;
const MAX_OFFERED_SLOTS = 60;

// Minutes-since-midnight for a UTC instant, as seen in a specific IANA zone
// — the building block for the workday-window check below. `% 24` guards
// against a documented Intl quirk where midnight can format as "24" instead
// of "0" under hour12:false.
function minutesSinceMidnightInZone(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(
    new Date(ms),
  );
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

// The owner's "never book before/after X" mask (scheduling_settings), a
// single daily window applied every day, interpreted in the *target
// account's* calendar timezone — owner's calendar timezone is authoritative
// (user decision), not the invitee's browser zone. Rejects a candidate whose
// wall-clock end falls before its wall-clock start in that zone too (the
// meeting would cross midnight) rather than risk a false-accept from the
// day wrapping around.
function isWithinWorkday(startMs: number, endMs: number, timeZone: string, settings: SchedulingSettingsRow): boolean {
  const startMinutes = minutesSinceMidnightInZone(startMs, timeZone);
  const endMinutes = minutesSinceMidnightInZone(endMs, timeZone);
  return (
    endMinutes > startMinutes &&
    startMinutes >= settings.workday_start_minutes &&
    endMinutes <= settings.workday_end_minutes
  );
}

// Buffer applies symmetrically — the candidate needs `buffer_minutes` of
// clear space on *both* sides of any existing event, not just no direct
// overlap.
function hasBufferedConflict(startMs: number, endMs: number, bufferMs: number, busy: FreeBusyInterval[]): boolean {
  const bufferedStart = startMs - bufferMs;
  const bufferedEnd = endMs + bufferMs;
  return busy.some((interval) => {
    const busyStart = Date.parse(interval.start);
    const busyEnd = Date.parse(interval.end);
    return busyStart < bufferedEnd && busyEnd > bufferedStart;
  });
}

// Only meaningful when the caller's modality is 'remote'. Returns null if
// remote meetings can't actually be completed right now — no Meet account
// configured, or it's been disconnected/revoked since the invite/poll was
// created (createInvite/createMeetingPollWithSlots already check this at
// creation time; this is the same check re-run, since settings can change
// afterward) — checked both when offering slots and again at confirm/
// finalize time, so a broken Meet configuration surfaces as "not available"
// rather than a Calendar API error deep in the booking flow. Takes a plain
// {userId, accountId} rather than a TrustedInviteRow so it's shared by both
// the appointment path (invite.user_id/account_id) and the poll finalize
// path (poll.user_id/account_id, no invite in scope at that point).
async function resolveMeetAccessToken(
  env: Env,
  owner: { userId: string; accountId: string },
  settings: SchedulingSettingsRow,
  primaryAccessToken: string,
): Promise<string | null> {
  if (!settings.meet_account_id) return null;
  const meetAccount = await findAccountForUser(env.DB, owner.userId, settings.meet_account_id);
  if (!meetAccount || meetAccount.status !== "active") return null;
  return meetAccount.id === owner.accountId ? primaryAccessToken : getValidAccessToken(env, meetAccount.id);
}

// Creates a small helper event on the designated Meet account's own calendar
// purely to mint a conferenceData room (see googleCalendar.ts's
// insertEventWithMeetLink for the request shape, verified against Google's
// current docs) and extract its join URL. Deliberately left in place, not
// deleted after — Meet rooms created via Calendar API conferenceData are
// tied to their event's lifecycle, and this codebase doesn't currently rely
// on any documented deletion-safe behavior for that. The upside is
// consistent with the rest of this account's calendar anyway: it shows the
// same busy block a normal booking would.
async function mintMeetLink(accessToken: string, startMs: number, endMs: number): Promise<string | null> {
  const event = await insertEventWithMeetLink(accessToken, {
    summary: "Busy (booked via invite)",
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(endMs).toISOString() },
    transparency: "opaque",
    conferenceData: { createRequest: { requestId: crypto.randomUUID() } },
  });
  return event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ?? null;
}

export type AvailableSlotsResult =
  | { ok: true; slots: string[]; durationMinutes: number } // slots are ISO UTC instants (start times)
  | { ok: false; reason: "invite-not-available" | "meet-unavailable" };

// Real availability, not blind-accept: computed as true UTC instants via
// Google's freeBusy endpoint (itself always UTC — no wall-clock guessing
// needed anywhere in this function), filtered by the owner's workday window
// and buffer. The invitee's browser converts these same instants for
// display client-side (routes/booking.tsx / views/booking.tsx) — nothing
// about *which* slots are valid depends on the invitee's timezone at all.
export async function computeAvailableSlots(env: Env, inviteId: string): Promise<AvailableSlotsResult> {
  const invite = await findTrustedInvite(env.DB, inviteId);
  if (!invite || invite.kind !== "appointment" || invite.duration_minutes == null || invite.modality == null) {
    return { ok: false, reason: "invite-not-available" };
  }
  if (invite.status !== "verified" || isInviteExpired(invite)) {
    return { ok: false, reason: "invite-not-available" };
  }

  const settings = await getOrCreateSchedulingSettings(env.DB, invite.user_id);

  // Anything from here on touches Google (token refresh, calendar metadata,
  // freeBusy) — a public, unauthenticated invitee is the caller, so a
  // failure here (most realistically: the owner's Google access was revoked
  // since the invite was created, or a transient Google API error) must
  // degrade to a normal "not available" response, not an uncaught exception
  // reaching app.onError's bare 500 (caught for real during this phase's
  // wrangler dev smoke test, not hypothetical).
  let accessToken: string;
  let timeZone: string;
  let busy: FreeBusyInterval[];
  const now = Date.now();
  const windowEnd = now + AVAILABILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  try {
    accessToken = await getValidAccessToken(env, invite.account_id);
    if (invite.modality === "remote" && !(await resolveMeetAccessToken(env, { userId: invite.user_id, accountId: invite.account_id }, settings, accessToken))) {
      return { ok: false, reason: "meet-unavailable" };
    }
    [timeZone, busy] = await Promise.all([
      getCalendarTimeZone(accessToken),
      fetchFreeBusy(accessToken, new Date(now).toISOString(), new Date(windowEnd).toISOString()),
    ]);
  } catch (err) {
    console.error(`computeAvailableSlots: Google Calendar access failed for invite ${inviteId}:`, err instanceof Error ? err.message : err);
    return { ok: false, reason: "invite-not-available" };
  }

  const durationMs = invite.duration_minutes * 60 * 1000;
  const bufferMs = settings.buffer_minutes * 60 * 1000;
  const stepMs = settings.duration_step_minutes * 60 * 1000;

  // Rounds the first candidate up to the next step boundary strictly after
  // "now" (e.g. :00/:15/:30/:45 for a 15-minute step) — Math.floor+stepMs,
  // not Math.ceil: if "now" itself already sits exactly on a boundary,
  // ceil would offer that exact instant as a slot, which
  // confirmAppointmentBooking's own future-check (startMs <= Date.now())
  // would then always reject. floor+stepMs always lands one full step past
  // "now" regardless, so every offered slot is guaranteed bookable.
  const slots: string[] = [];
  for (
    let candidateStart = Math.floor(now / stepMs) * stepMs + stepMs;
    candidateStart < windowEnd && slots.length < MAX_OFFERED_SLOTS;
    candidateStart += stepMs
  ) {
    const candidateEnd = candidateStart + durationMs;
    if (isWithinWorkday(candidateStart, candidateEnd, timeZone, settings) && !hasBufferedConflict(candidateStart, candidateEnd, bufferMs, busy)) {
      slots.push(new Date(candidateStart).toISOString());
    }
  }
  return { ok: true, slots, durationMinutes: invite.duration_minutes };
}

export type ConfirmAppointmentResult =
  | { ok: true; googleEventId: string }
  | { ok: false; reason: "invite-not-available" | "invalid-time" | "slot-no-longer-available" | "meet-unavailable" };

// The one place this feature actually writes to a real calendar. Order
// matters for correctness, not just style: everything read-only (settings,
// access tokens, the fresh free/busy re-check, resolving the Meet account)
// happens *before* tryConsumeInvite, and every real Calendar write (minting
// a Meet room, creating the placeholder event) happens *after* it — so
// under a concurrent double-submit (two tabs, a retried request) at most one
// racer can ever get past the atomic consume, and only that one writes
// anything. The accepted tradeoff: if a write after that point still fails
// (a transient Calendar API error), the invite is left 'used' with no
// booking recorded rather than fully rolled back — a rare, recoverable-by-
// hand edge case, not a saga/rollback mechanism, consistent with this
// codebase's existing risk bar elsewhere (see tokenManager.ts's accepted KV
// refresh race).
//
// startIso is a UTC instant, not a wall-clock string — it's one of the exact
// values computeAvailableSlots offered, submitted back unmodified (see
// views/booking.tsx's slot picker), so there's no ambiguity to resolve here
// at all. It's re-validated against fresh free/busy data below rather than
// trusted as still valid — the offered list can go stale between page load
// and submission (another booking landing, or the invitee just sitting on
// the form), and that re-check *is* the real buffer/workday enforcement.
export async function confirmAppointmentBooking(env: Env, inviteId: string, startIso: string): Promise<ConfirmAppointmentResult> {
  const invite = await findTrustedInvite(env.DB, inviteId);
  if (!invite || invite.kind !== "appointment" || invite.duration_minutes == null || invite.modality == null) {
    return { ok: false, reason: "invite-not-available" };
  }
  if (invite.status !== "verified" || isInviteExpired(invite)) {
    return { ok: false, reason: "invite-not-available" };
  }

  const startMs = Date.parse(startIso);
  if (Number.isNaN(startMs) || startMs <= Date.now()) {
    return { ok: false, reason: "invalid-time" };
  }
  const endMs = startMs + invite.duration_minutes * 60 * 1000;

  const settings = await getOrCreateSchedulingSettings(env.DB, invite.user_id);

  // Same reasoning as computeAvailableSlots: everything read-only that
  // touches Google happens before tryConsumeInvite, wrapped so a failure
  // (revoked owner access, a transient Google error) degrades to a normal
  // "not available" response instead of an uncaught exception — nothing
  // here has consumed the invite yet, so there's nothing to leave in a bad
  // state by bailing out early.
  let accessToken: string;
  let meetAccessToken: string | null = null;
  let timeZone: string;
  try {
    accessToken = await getValidAccessToken(env, invite.account_id);
    let busy: FreeBusyInterval[];
    [timeZone, busy] = await Promise.all([
      getCalendarTimeZone(accessToken),
      fetchFreeBusy(accessToken, new Date(startMs).toISOString(), new Date(endMs).toISOString()),
    ]);
    if (!isWithinWorkday(startMs, endMs, timeZone, settings) || hasBufferedConflict(startMs, endMs, settings.buffer_minutes * 60 * 1000, busy)) {
      return { ok: false, reason: "slot-no-longer-available" };
    }
    if (invite.modality === "remote") {
      meetAccessToken = await resolveMeetAccessToken(env, { userId: invite.user_id, accountId: invite.account_id }, settings, accessToken);
      if (!meetAccessToken) return { ok: false, reason: "meet-unavailable" };
    }
  } catch (err) {
    console.error(`confirmAppointmentBooking: Google Calendar access failed for invite ${inviteId}:`, err instanceof Error ? err.message : err);
    return { ok: false, reason: "invite-not-available" };
  }

  const consumed = await tryConsumeInvite(env.DB, inviteId);
  if (!consumed) return { ok: false, reason: "invite-not-available" }; // lost a race, or expired between the read above and now

  const meetUrl = meetAccessToken ? await mintMeetLink(meetAccessToken, startMs, endMs) : null;

  // Generic placeholder only — no invitee-supplied title/description is ever
  // written to the real calendar (user decision, see task_plan.md Phase 7's
  // clarified requirements). The Meet link is the one exception, and
  // deliberately so: it's system-generated, not invitee content, and the
  // owner needs it to actually join a remote meeting they've been booked
  // into — the "generic placeholder" rule is about not leaking what the
  // invitee typed, not about the event carrying zero operationally-necessary
  // information.
  const event = await insertEvent(accessToken, {
    summary: "Busy (booked via invite)",
    ...(meetUrl ? { description: `Join: ${meetUrl}` } : {}),
    start: { dateTime: new Date(startMs).toISOString(), timeZone },
    end: { dateTime: new Date(endMs).toISOString(), timeZone },
    transparency: "opaque",
  });

  await recordAppointmentBooking(env.DB, inviteId, new Date(startMs).toISOString(), new Date(endMs).toISOString(), event.id);
  return { ok: true, googleEventId: event.id };
}

// --- Phase 7.3: multi-party meeting planner ---
// A poll is one meeting_polls row plus a fixed set of owner-picked candidate
// slots (meeting_poll_slots) and one trusted_invites row per participant
// (kind='meeting_poll', meeting_poll_id -> the poll), reusing Phase 7.1's
// email-verification lifecycle unchanged. The route layer creates those
// per-participant invites itself, one createInvite/sendInviteEmail call per
// email — the exact same per-email-isolated loop routes/invites.tsx already
// uses for appointments — rather than this service doing it in bulk, so one
// bad address in a pasted batch can't stop the rest (see routes/meetingPolls.tsx).

const MIN_POLL_SLOTS = 2;
const MAX_POLL_SLOTS = 20;

export interface CreatePollInput {
  userId: string;
  accountId: string;
  title: string;
  durationMinutes: number;
  modality: AppointmentModality;
  // ISO UTC instants, owner-picked candidate start times — this feature has
  // no free/busy-driven candidate generation (out of scope per task_plan.md
  // Phase 7.3; that's what the appointment flow's computeAvailableSlots is
  // for), so these come from the dashboard form as-is.
  slotStarts: string[];
}

// Mirrors createInvite's owner-auth-only enforcement exactly (same two
// checks, same reasoning: task_plan.md Phase 7's security model — invite/
// poll creation is the one place trust originates, checked here independent
// of whatever the route layer already checked) plus the same duration-range/
// Meet-account validation createInvite applies for kind='appointment', since
// a poll's duration/modality apply to every candidate slot the same way.
export async function createMeetingPollWithSlots(env: Env, input: CreatePollInput): Promise<string> {
  const account = await findAccountForUser(env.DB, input.userId, input.accountId);
  if (!account) {
    throw new Error(`createMeetingPollWithSlots: account ${input.accountId} does not belong to user ${input.userId}`);
  }
  if (account.status !== "active") {
    throw new Error(`createMeetingPollWithSlots: account ${input.accountId} is not active (status: ${account.status})`);
  }

  const settings = await getOrCreateSchedulingSettings(env.DB, input.userId);
  const allowed = allowedAppointmentDurations(settings);
  if (!allowed.includes(input.durationMinutes)) {
    throw new Error(`createMeetingPollWithSlots: durationMinutes must be one of ${allowed.join(", ")}`);
  }
  if (input.modality === "remote") {
    if (!settings.meet_account_id) {
      throw new Error("createMeetingPollWithSlots: remote meetings require a Meet account to be configured in Settings first");
    }
    const meetAccount = await findAccountForUser(env.DB, input.userId, settings.meet_account_id);
    if (!meetAccount || meetAccount.status !== "active") {
      throw new Error("createMeetingPollWithSlots: the configured Meet account is no longer active — update it in Settings");
    }
  }

  const title = input.title.trim();
  if (!title) throw new Error("createMeetingPollWithSlots: title is required");

  // De-duped and filtered to distinct, parseable, future instants — mirrors
  // parseEmailList's dedupe/trim conventions (routes/invites.tsx) applied to
  // times instead of addresses. A poll needs at least MIN_POLL_SLOTS genuine
  // options to be a poll at all (a single-candidate "poll" is really just an
  // appointment invite with extra steps); MAX_POLL_SLOTS bounds the vote
  // matrix a participant has to fill out and the rows finalize has to scan.
  const now = Date.now();
  const uniqueMs = Array.from(new Set(input.slotStarts.map((s) => Date.parse(s)).filter((ms) => !Number.isNaN(ms) && ms > now)));
  if (uniqueMs.length < MIN_POLL_SLOTS) {
    throw new Error(`createMeetingPollWithSlots: at least ${MIN_POLL_SLOTS} distinct future candidate times are required`);
  }
  if (uniqueMs.length > MAX_POLL_SLOTS) {
    throw new Error(`createMeetingPollWithSlots: at most ${MAX_POLL_SLOTS} candidate times are allowed`);
  }

  const pollId = crypto.randomUUID();
  await createMeetingPoll(env.DB, {
    id: pollId,
    userId: input.userId,
    accountId: input.accountId,
    title,
    durationMinutes: input.durationMinutes,
    modality: input.modality,
  });
  const durationMs = input.durationMinutes * 60 * 1000;
  await createMeetingPollSlots(
    env.DB,
    uniqueMs
      .sort((a, b) => a - b)
      .map((ms) => ({
        id: crypto.randomUUID(),
        pollId,
        startTime: new Date(ms).toISOString(),
        endTime: new Date(ms + durationMs).toISOString(),
      })),
  );
  return pollId;
}

export type PollLinkFailureReason =
  | "not-found"
  | "expired"
  | "revoked"
  | "not-a-poll-invite"
  | "poll-cancelled"
  | "poll-concluded";

export type PollLinkResult =
  | { ok: true; invite: TrustedInviteRow; poll: MeetingPollRow; slots: MeetingPollSlotRow[] }
  | { ok: false; reason: PollLinkFailureReason };

// A finalized poll's link stays valid for viewing (not voting — the route
// layer branches on poll.status) only until the booked meeting's own end
// time — same "time-based expiry against the chosen slot's end time, not a
// fixed TTL/single use" rule as task_plan.md Phase 7.3 specifies, layered on
// top of (not replacing) the invite's own creation-time TTL that
// getUsableInvite already enforces.
function isPollLinkExpired(poll: MeetingPollRow, now = Date.now()): boolean {
  if (poll.status !== "finalized") return false;
  return poll.booked_end == null || Date.parse(poll.booked_end) <= now;
}

export async function getPollForInvite(env: Env, inviteId: string): Promise<PollLinkResult> {
  const usable = await getUsableInvite(env, inviteId);
  if (!usable.invite) return { ok: false, reason: usable.reason };
  const invite = usable.invite;
  if (invite.kind !== "meeting_poll" || !invite.meeting_poll_id) {
    return { ok: false, reason: "not-a-poll-invite" };
  }
  const poll = await findMeetingPoll(env.DB, invite.meeting_poll_id);
  if (!poll) return { ok: false, reason: "not-found" };
  if (poll.status === "cancelled") return { ok: false, reason: "poll-cancelled" };
  if (isPollLinkExpired(poll)) return { ok: false, reason: "poll-concluded" };
  const slots = await listMeetingPollSlots(env.DB, invite.meeting_poll_id);
  return { ok: true, invite, poll, slots };
}

export type CastVotesResult = { ok: true } | { ok: false; reason: "invite-not-available" | "poll-not-open" | "invalid-slot" };

// Identity is the invite's own verified_email — the same address that
// completed email verification for *this* invite link, not a value the
// caller supplies separately — so a participant can only ever vote as
// themselves, matching the appointment flow's "identity is proven by
// verifying this address" model exactly.
//
// Validates every slotId before writing any vote, not per-item as it goes —
// a partially-applied vote submission (some slots written, then a bad id
// aborts) would be a confusing half-state for a form that's meant to be
// resubmittable as a whole.
export async function castPollVotes(env: Env, inviteId: string, votes: Record<string, boolean>): Promise<CastVotesResult> {
  const result = await getPollForInvite(env, inviteId);
  if (!result.ok) return { ok: false, reason: "invite-not-available" };
  const { invite, poll, slots } = result;
  if (invite.status !== "verified" || !invite.verified_email) {
    return { ok: false, reason: "invite-not-available" };
  }
  if (poll.status !== "open") return { ok: false, reason: "poll-not-open" };

  const slotIds = new Set(slots.map((s) => s.id));
  const entries = Object.entries(votes);
  for (const [slotId] of entries) {
    if (!slotIds.has(slotId)) return { ok: false, reason: "invalid-slot" };
  }
  for (const [slotId, available] of entries) {
    await castVote(env.DB, poll.id, slotId, invite.verified_email, available);
  }
  return { ok: true };
}

export interface PollTallySlot {
  slot: MeetingPollSlotRow;
  availableCount: number;
  fullyAvailable: boolean;
}
export interface PollTally {
  totalParticipants: number;
  slots: PollTallySlot[];
}

// Owner-facing live tally (routes/meetingPolls.tsx) — computed in
// application code from the raw vote rows rather than a SQL aggregation:
// poll sizes here are small (MAX_POLL_SLOTS=20 slots x realistically a
// handful of participants), and this keeps "how many distinct participants
// have voted at all" (the denominator) and "is every one of them available
// on this slot" (fullyAvailable) expressed in one place, matching
// findFullyAvailableSlot below exactly rather than two SQL queries that
// could silently drift apart from each other.
export async function getPollTally(env: Env, pollId: string): Promise<PollTally> {
  const [slots, votes, totalParticipants] = await Promise.all([
    listMeetingPollSlots(env.DB, pollId),
    listVotesForPoll(env.DB, pollId),
    countDistinctParticipants(env.DB, pollId),
  ]);
  return {
    totalParticipants,
    slots: slots.map((slot) => {
      const availableCount = votes.filter((v) => v.slot_id === slot.id && v.available === 1).length;
      return { slot, availableCount, fullyAvailable: totalParticipants > 0 && availableCount === totalParticipants };
    }),
  };
}

// The slot every distinct participant marked available, if one exists.
// Ties (more than one fully-available slot) resolve to the chronologically
// earliest — listMeetingPollSlots already returns slots ordered by
// start_time ASC, so the first *future* match found is that slot; a
// deliberate, simple tie-break (not asked for explicitly in task_plan.md's
// spec) rather than surfacing a choice back to the owner for what's expected
// to be a rare case.
//
// Filters to slots strictly after `now` — without this, a poll left open
// past all its candidate times (nobody ever finalized it) would book a real
// calendar event *in the past* the moment someone finally clicked Finalize,
// and — worse — the tie-break above meant it always picked the *stalest*
// fully-available candidate, not even the most-recently-past one. Found in
// an independent security review of Phase 7.3, reproduced with a poll whose
// only fully-available slots were both already past. `onlyPastAvailable`
// lets finalizePoll report a distinct, honest reason ("every viable
// candidate has already passed") instead of the misleading
// "no-fully-available-slot" (which reads as "nobody agreed on anything").
async function findFullyAvailableSlot(
  env: Env,
  pollId: string,
  now = Date.now(),
): Promise<{ winner: MeetingPollSlotRow | null; onlyPastAvailable: boolean }> {
  const tally = await getPollTally(env, pollId);
  const fullyAvailable = tally.slots.filter((s) => s.fullyAvailable);
  const future = fullyAvailable.find((s) => Date.parse(s.slot.start_time) > now);
  return { winner: future?.slot ?? null, onlyPastAvailable: !future && fullyAvailable.length > 0 };
}

export type FinalizePollResult =
  | { ok: true; googleEventId: string }
  | {
      ok: false;
      reason:
        | "poll-not-found"
        | "poll-not-open"
        | "no-fully-available-slot"
        | "all-candidates-in-the-past"
        | "meet-unavailable"
        | "calendar-unavailable"
        | "cancelled-during-finalize";
    };

// Owner-only — the route layer requireAuth-gates this and findMeetingPollForUser
// re-verifies pollId actually belongs to userId (same defense-in-depth
// pattern as createInvite/createMeetingPollWithSlots).
//
// Ordering mirrors confirmAppointmentBooking exactly, adapted for the fact
// that finalizing writes chosen_slot_id/status together rather than a
// single-use consume: everything read-only (access token, timezone,
// resolving the Meet account) happens before tryClaimPollSlot; the atomic
// claim happens next (closing the race between two concurrent finalize
// calls); the real Google writes (Meet room, placeholder event) happen only
// after the claim succeeds; finalizeMeetingPollBooking — the second, final
// write — happens last. See migration 0007's CHECK comment for why the claim
// and the finalize-write are two separate updates instead of one.
export async function finalizePoll(env: Env, userId: string, pollId: string): Promise<FinalizePollResult> {
  const poll = await findMeetingPollForUser(env.DB, userId, pollId);
  if (!poll) return { ok: false, reason: "poll-not-found" };
  if (poll.status !== "open") return { ok: false, reason: "poll-not-open" };

  const { winner: winningSlot, onlyPastAvailable } = await findFullyAvailableSlot(env, pollId);
  if (!winningSlot) return { ok: false, reason: onlyPastAvailable ? "all-candidates-in-the-past" : "no-fully-available-slot" };

  const settings = await getOrCreateSchedulingSettings(env.DB, userId);
  const startMs = Date.parse(winningSlot.start_time);
  const endMs = Date.parse(winningSlot.end_time);

  let accessToken: string;
  let timeZone: string;
  let meetAccessToken: string | null = null;
  try {
    accessToken = await getValidAccessToken(env, poll.account_id);
    timeZone = await getCalendarTimeZone(accessToken);
    if (poll.modality === "remote") {
      meetAccessToken = await resolveMeetAccessToken(env, { userId: poll.user_id, accountId: poll.account_id }, settings, accessToken);
      if (!meetAccessToken) return { ok: false, reason: "meet-unavailable" };
    }
  } catch (err) {
    console.error(`finalizePoll: Google Calendar access failed for poll ${pollId}:`, err instanceof Error ? err.message : err);
    return { ok: false, reason: "calendar-unavailable" };
  }

  const claimed = await tryClaimPollSlot(env.DB, pollId, winningSlot.id);
  if (!claimed) return { ok: false, reason: "poll-not-open" }; // lost a race, or already claimed

  // The two real Google writes happen only after the claim succeeds (see
  // migration 0007's CHECK comment for the full ordering rationale) — but
  // unlike confirmAppointmentBooking's single-use tryConsumeInvite, a claim
  // failure here is recoverable, not a dead invite: release it back to
  // 'open' so a later finalize attempt (after the owner clicks the button
  // again, or Google recovers) isn't permanently blocked by
  // tryClaimPollSlot's own "chosen_slot_id IS NULL" requirement. Found in an
  // independent security review of Phase 7.3 — this exact gap (missing
  // try/catch around a Google write, no release path) was already fixed
  // once for requestEmailVerification/computeAvailableSlots in Phase 7.1/7.2
  // and was reintroduced here.
  let event: { id: string };
  try {
    const meetUrl = meetAccessToken ? await mintMeetLink(meetAccessToken, startMs, endMs) : null;
    // Same generic-placeholder-only rule as confirmAppointmentBooking — no
    // participant- or owner-supplied poll title is ever written to the real
    // calendar, only the system-generated Meet link when applicable.
    event = await insertEvent(accessToken, {
      summary: "Busy (booked via invite)",
      ...(meetUrl ? { description: `Join: ${meetUrl}` } : {}),
      start: { dateTime: new Date(startMs).toISOString(), timeZone },
      end: { dateTime: new Date(endMs).toISOString(), timeZone },
      transparency: "opaque",
    });
  } catch (err) {
    console.error(`finalizePoll: Google Calendar write failed after claiming a slot for poll ${pollId}:`, err instanceof Error ? err.message : err);
    await releasePollSlotClaim(env.DB, pollId);
    return { ok: false, reason: "calendar-unavailable" };
  }

  const finalized = await finalizeMeetingPollBooking(
    env.DB,
    pollId,
    winningSlot.id,
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
    event.id,
  );
  if (!finalized) {
    // Lost a race against cancelOpenPoll, which can still succeed between
    // the claim above and this write (the claim deliberately leaves status
    // 'open' — see tryClaimPollSlot's comment). The real calendar event
    // (and Meet room, if any) was already created and is now orphaned —
    // logged so the owner can be told to remove it by hand, matching this
    // codebase's existing accepted-tradeoff bar for post-claim failures
    // (see confirmAppointmentBooking's own documented one) rather than a
    // saga/rollback mechanism.
    console.error(
      `finalizePoll: poll ${pollId} was cancelled mid-finalize — real calendar event ${event.id} was created and is now orphaned; remove it by hand.`,
    );
    return { ok: false, reason: "cancelled-during-finalize" };
  }
  return { ok: true, googleEventId: event.id };
}

export async function cancelPoll(env: Env, userId: string, pollId: string): Promise<boolean> {
  const poll = await findMeetingPollForUser(env.DB, userId, pollId);
  if (!poll) return false;
  return cancelOpenPoll(env.DB, pollId);
}
