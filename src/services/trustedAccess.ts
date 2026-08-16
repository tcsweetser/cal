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
import type { Env } from "../types";
import {
  createTrustedInvite,
  findTrustedInvite,
  findAccountForUser,
  markInviteVerified,
  tryConsumeInvite,
  upsertEmailVerification,
  findEmailVerification,
  countVerificationTargets,
  incrementVerificationAttempts,
  type TrustedInviteKind,
  type TrustedInviteRow,
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

export interface CreateInviteInput {
  userId: string;
  accountId: string;
  kind: TrustedInviteKind;
  inviteeEmail: string;
  meetingPollId?: string;
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
  const id = crypto.randomUUID();
  await createTrustedInvite(env.DB, {
    id,
    userId: input.userId,
    accountId: input.accountId,
    kind: input.kind,
    inviteeEmail: input.inviteeEmail,
    meetingPollId: input.meetingPollId ?? null,
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
