// Shared trusted-party access layer for TODO.md's two features (appointment
// dialog, multi-party meeting planner — see task_plan.md Phase 7). An invite
// needs no account in this system, but whoever actually uses the link must
// verify control of the email address they're using first — even if the
// link was forwarded on from the person it was originally sent to, since
// identity here is "proven control of this inbox," not "matches the
// original recipient."
//
// Phase 7.1 scope only: invite issuance, email delivery, and the
// verify/consume lifecycle. Phase 7.3 (meeting planner) will extend this
// with a poll-aware variant whose expiry is tied to the chosen slot's end
// time rather than a fixed TTL/single use — not built here, per this
// project's "don't build for a phase that hasn't started" convention.

import { sha256Hex } from "../lib/crypto";
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
  type TrustedInviteKind,
  type TrustedInviteRow,
  type AppointmentModality,
  type SchedulingSettingsRow,
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
  | { ok: false; reason: "invite-not-available" | "invalid-email" | "cooldown" | "too-many-targets" };

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
  if (!existing) {
    const targetCount = await countVerificationTargets(env.DB, inviteId);
    if (targetCount >= MAX_VERIFICATION_TARGETS_PER_INVITE) {
      return { ok: false, reason: "too-many-targets" };
    }
  }

  const code = generateNumericCode();
  const codeHash = await sha256Hex(code);
  await upsertEmailVerification(env.DB, {
    id: crypto.randomUUID(),
    inviteId,
    email,
    codeHash,
    expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS).toISOString(),
  });
  await sendEmail(env, {
    to: email,
    subject: "Your verification code",
    html: `<p>Your verification code is <strong>${code}</strong>. It expires in 10 minutes.</p>`,
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

// Only meaningful for invite.modality === 'remote'. Returns null if remote
// meetings can't actually be completed right now — no Meet account
// configured, or it's been disconnected/revoked since the invite was
// created (createInvite already checks this at creation time; this is the
// same check re-run, since settings can change afterward) — checked both
// when offering slots and again at confirm time, so a broken Meet
// configuration surfaces as "not available" rather than a Calendar API
// error deep in the booking flow.
async function resolveMeetAccessToken(
  env: Env,
  invite: TrustedInviteRow,
  settings: SchedulingSettingsRow,
  primaryAccessToken: string,
): Promise<string | null> {
  if (!settings.meet_account_id) return null;
  const meetAccount = await findAccountForUser(env.DB, invite.user_id, settings.meet_account_id);
  if (!meetAccount || meetAccount.status !== "active") return null;
  return meetAccount.id === invite.account_id ? primaryAccessToken : getValidAccessToken(env, meetAccount.id);
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
    if (invite.modality === "remote" && !(await resolveMeetAccessToken(env, invite, settings, accessToken))) {
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
      meetAccessToken = await resolveMeetAccessToken(env, invite, settings, accessToken);
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
