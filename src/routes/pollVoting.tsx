import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppBindings } from "../types";
import {
  getPollForInvite,
  requestEmailVerification,
  confirmEmailVerification,
  castPollVotes,
  INVITE_VERIFY_COOKIE,
  signInviteVerifyCookie,
  verifyInviteVerifyCookie,
  inviteCookieMaxAgeSeconds,
  type RequestVerificationResult,
  type ConfirmVerificationResult,
  type PollLinkFailureReason,
} from "../services/trustedAccess";
import { listVotesForParticipant } from "../db/schema";
import {
  PollErrorPage,
  PollEmailVerifyForm,
  PollCodeEntryForm,
  PollVotingForm,
  PollFinalizedPage,
} from "../views/pollVoting";

// Public, unauthenticated, HTML-only (no JSON response mode) — same security
// model as routes/booking.tsx (task_plan.md Phase 7): every unsafe step
// (comparing a code, transitioning the invite, recording a vote) happens
// entirely server-side inside one of these handlers; the client only ever
// sees the invite id (in the URL) and plain form fields.
const pollVoting = new Hono<AppBindings>();

const NOT_AVAILABLE_MESSAGES: Record<PollLinkFailureReason, string> = {
  "not-found": "This link doesn't exist. Double-check the URL, or ask for a new invite.",
  expired: "This link has expired. Ask for a new invite.",
  revoked: "This link has been revoked.",
  "not-a-poll-invite": "This link isn't a meeting poll invite.",
  "poll-cancelled": "This poll has been cancelled by its organizer.",
  "poll-concluded": "This poll's meeting has already concluded.",
};

const VERIFY_ERROR_MESSAGES: Record<Extract<RequestVerificationResult, { ok: false }>["reason"], string> = {
  "invite-not-available": "This link isn't available anymore.",
  "invalid-email": "That doesn't look like a valid email address.",
  cooldown: "A code was already sent recently — check your inbox, or wait a minute before requesting another.",
  "too-many-targets": "Too many email addresses have been tried for this link.",
  "send-failed": "Couldn't send the code right now. Please try again in a moment.",
};

const CONFIRM_ERROR_MESSAGES: Record<Extract<ConfirmVerificationResult, { ok: false }>["reason"], string> = {
  "invite-not-available": "This link isn't available anymore.",
  "not-requested": "Request a code first.",
  expired: "That code has expired — request a new one.",
  "too-many-attempts": "Too many incorrect attempts. Request a new code.",
  "wrong-code": "That code isn't correct. Please try again.",
};

function normalizeEmail(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

// Renders the finalized/voting view for a caller already *known* to be
// verified for this exact invite (its cookie was checked, or this is the
// same request that just set it) — never re-checks the cookie itself, so
// it's safe to call immediately after confirmEmailVerification succeeds in
// the same response that's about to set the cookie (the browser hasn't sent
// it back yet at that point).
async function renderVerifiedPollState(c: Context<AppBindings>, id: string, verifiedEmail: string, voteError?: string) {
  const result = await getPollForInvite(c.env, id);
  if (!result.ok) {
    return c.html(<PollErrorPage message={NOT_AVAILABLE_MESSAGES[result.reason]} />);
  }
  const { poll, slots } = result;
  if (poll.status === "finalized") {
    return c.html(<PollFinalizedPage title={poll.title} bookedStart={poll.booked_start} durationMinutes={poll.duration_minutes} />);
  }
  const existingVotes = await listVotesForParticipant(c.env.DB, poll.id, verifiedEmail);
  const currentAvailability = new Map(existingVotes.map((v) => [v.slot_id, v.available === 1]));
  return c.html(
    <PollVotingForm inviteId={id} title={poll.title} slots={slots} currentAvailability={currentAvailability} error={voteError} />,
  );
}

// Shared by every place that needs to show the current state of a link from
// a fresh request (GET entry, re-rendered after a vote submission) — checks
// the invite-verify cookie before showing anything past the pending state.
// DB status alone (invite.status === 'verified') isn't proof THIS caller is
// the one who verified — see INVITE_VERIFY_COOKIE's doc comment in
// trustedAccess.ts for the bug this closes (found in an independent
// security review of Phase 7.3): without it, anyone who obtained the URL
// after someone else verified it — forwarded mail, a screenshot, a shared
// link — could read the poll and cast/overwrite votes with no proof of
// their own inbox control, for as long as the invite stayed valid (up to 30
// days).
async function renderPollState(c: Context<AppBindings>, id: string, voteError?: string) {
  const result = await getPollForInvite(c.env, id);
  if (!result.ok) {
    return c.html(<PollErrorPage message={NOT_AVAILABLE_MESSAGES[result.reason]} />);
  }
  const { invite } = result;
  if (invite.status === "pending") {
    return c.html(<PollEmailVerifyForm inviteId={id} />);
  }
  const cookieEmail = await verifyInviteVerifyCookie(c.env, id, getCookie(c, INVITE_VERIFY_COOKIE));
  if (!cookieEmail || cookieEmail !== invite.verified_email) {
    return c.html(<PollEmailVerifyForm inviteId={id} />);
  }
  return renderVerifiedPollState(c, id, cookieEmail, voteError);
}

pollVoting.get("/meet/:id", async (c) => renderPollState(c, c.req.param("id")));

pollVoting.post("/meet/:id/verify", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);

  const result = await requestEmailVerification(c.env, id, email);
  if (!result.ok) {
    return c.html(<PollEmailVerifyForm inviteId={id} error={VERIFY_ERROR_MESSAGES[result.reason]} />);
  }
  return c.html(<PollCodeEntryForm inviteId={id} email={email} />);
});

pollVoting.post("/meet/:id/confirm-email", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  const code = String(body.code ?? "").trim();

  const result = await confirmEmailVerification(c.env, id, email, code);
  if (!result.ok) {
    return c.html(<PollCodeEntryForm inviteId={id} email={email} error={CONFIRM_ERROR_MESSAGES[result.reason]} />);
  }

  // confirmEmailVerification's 'verified'-status branch (unchanged by this
  // fix) lets a *different* email independently pass its own code check
  // against an invite someone else already verified — check the invite's
  // actual recorded verified_email matches what was just confirmed before
  // handing out a cookie, so that case fails here (a clear dead end) rather
  // than succeeding into a cookie that castPollVotes would then reject
  // anyway (each invite belongs to one participant; there's no legitimate
  // reason for a second identity to attach to one that's already bound).
  const pollResult = await getPollForInvite(c.env, id);
  if (!pollResult.ok || pollResult.invite.verified_email !== email) {
    return c.html(<PollErrorPage message="This link isn't available anymore." />);
  }

  setCookie(c, INVITE_VERIFY_COOKIE, await signInviteVerifyCookie(c.env, id, email), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: inviteCookieMaxAgeSeconds("meeting_poll"),
    path: `/meet/${id}`,
  });
  return renderVerifiedPollState(c, id, email);
});

// Resubmittable — a participant can change their mind on any slot any number
// of times until the poll is finalized (task_plan.md Phase 7.3), unlike the
// appointment flow's single-use confirm. Every slotId in the submission is
// validated (castPollVotes) before anything is written.
pollVoting.post("/meet/:id/vote", async (c) => {
  const id = c.req.param("id");

  // Same cookie proof required here as every other verified-state view —
  // without it, anyone holding the URL after someone else verified it could
  // overwrite that participant's votes with no proof of their own inbox
  // control (found in an independent security review of Phase 7.3).
  const pollResult = await getPollForInvite(c.env, id);
  if (!pollResult.ok) {
    return c.html(<PollErrorPage message={NOT_AVAILABLE_MESSAGES[pollResult.reason]} />);
  }
  const cookieEmail = await verifyInviteVerifyCookie(c.env, id, getCookie(c, INVITE_VERIFY_COOKIE));
  if (!cookieEmail || cookieEmail !== pollResult.invite.verified_email) {
    return c.html(<PollErrorPage message="This link isn't available anymore." />);
  }

  const body = await c.req.parseBody({ all: true });
  const votes: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(body)) {
    const match = /^available:(.+)$/.exec(key);
    if (!match) continue;
    // The real <select> UI always submits a single string value per slot —
    // a duplicated `available:<slotId>` key (hand-crafted or a mangled
    // proxy replay) arrives as an array instead, and `value === "yes"`
    // would silently evaluate to false, recording "unavailable" for a slot
    // the participant never actually answered. Reject outright rather than
    // coercing. Found in an independent security review of Phase 7.3.
    if (typeof value !== "string") {
      return renderVerifiedPollState(c, id, cookieEmail, "That submission wasn't in the format this form expects. Please try again.");
    }
    votes[match[1]!] = value === "yes";
  }

  const result = await castPollVotes(c.env, id, votes);
  if (!result.ok) {
    const message =
      result.reason === "poll-not-open"
        ? "This poll is no longer accepting votes — it may have just been finalized or cancelled."
        : "This link isn't available anymore.";
    if (result.reason === "invalid-slot") {
      return renderVerifiedPollState(c, id, cookieEmail, "Something about that submission didn't match this poll. Please try again.");
    }
    return c.html(<PollErrorPage message={message} />);
  }
  return renderVerifiedPollState(c, id, cookieEmail);
});

export default pollVoting;
