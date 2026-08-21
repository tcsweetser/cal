import { Hono } from "hono";
import type { AppBindings } from "../types";
import { requireAuth } from "../middleware/auth";
import {
  listAccountsForUser,
  getOrCreateSchedulingSettings,
  listMeetingPollsForUser,
  findMeetingPollForUser,
  findUserById,
  type AppointmentModality,
} from "../db/schema";
import {
  createMeetingPollWithSlots,
  createInvite,
  sendInviteEmail,
  allowedAppointmentDurations,
  getPollTally,
  finalizePoll,
  cancelPoll,
  type FinalizePollResult,
} from "../services/trustedAccess";
import { MeetingPollsPage, MeetingPollDetailPage } from "../views/meetingPolls";
import { toSidebarUser } from "./sidebarUser";

const meetingPolls = new Hono<AppBindings>();
meetingPolls.use("/dashboard/meeting-polls", requireAuth);
meetingPolls.use("/dashboard/meeting-polls/*", requireAuth);

// Same split/trim/lowercase/de-dupe as routes/invites.tsx's parseEmailList —
// a pasted participant list has the same kinds of noise as an invitee list.
function parseEmailList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  );
}

// Each candidate slot arrives as an ISO UTC instant, already converted
// client-side from the owner's local datetime-local input (see
// views/meetingPolls.tsx's inline script) — the owner's own browser is the
// authoritative source of "what local time did they mean," unlike the
// invitee-facing flow Phase 7.2 deliberately moved away from. Body values
// with `{ all: true }` come back as a single string when only one slot row
// was filled in, or an array when more than one was — normalize both.
function parseSlotList(raw: string | string[] | undefined): string[] {
  const values = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return Array.from(new Set(values.map((v) => v.trim()).filter((v) => v.length > 0)));
}

function parseModality(raw: unknown): AppointmentModality | null {
  return raw === "in_person" || raw === "remote" ? raw : null;
}

const FINALIZE_ERROR_MESSAGES: Record<Exclude<FinalizePollResult, { ok: true }>["reason"], string> = {
  "poll-not-found": "Poll not found.",
  "poll-not-open": "This poll can no longer be finalized (already finalized, cancelled, or a finalize is already in progress).",
  "no-fully-available-slot": "No candidate time has every participant marked as available yet.",
  "all-candidates-in-the-past": "Every candidate time with full agreement has already passed. Create a new poll with fresh times.",
  "meet-unavailable": "This meeting can't be finalized right now — its remote-meeting setup is unavailable. Check Settings.",
  "calendar-unavailable": "Couldn't reach Google Calendar to finalize this meeting. Try again shortly.",
  "cancelled-during-finalize": "This poll was cancelled while finalizing was in progress. Check your calendar for a stray event.",
};

// Every code this page can show via ?error=, including ones that aren't a
// FinalizePollResult reason (e.g. the cancel action's own failure) — kept as
// an explicit allowlist rather than rendering c.req.query("error") directly,
// so a crafted URL can't plant arbitrary text on the owner's own dashboard
// (found in an independent security review of Phase 7.3; Hono's JSX auto-
// escaping already prevented this from being an XSS path, but it could
// still display attacker-chosen prose).
const ERROR_MESSAGES: Record<string, string> = {
  ...FINALIZE_ERROR_MESSAGES,
  "cancel-failed": "This poll can't be cancelled right now — it may already be finalized, cancelled, or no longer exist.",
};

function lookupErrorMessage(code: string | undefined): string | undefined {
  return code != null && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : undefined;
}

meetingPolls.get("/dashboard/meeting-polls", async (c) => {
  const session = c.get("session");
  const [user, accounts, polls, settings] = await Promise.all([
    findUserById(c.env.DB, session.userId),
    listAccountsForUser(c.env.DB, session.userId),
    listMeetingPollsForUser(c.env.DB, session.userId),
    getOrCreateSchedulingSettings(c.env.DB, session.userId),
  ]);
  const sentParam = c.req.query("sent");
  const failedParam = c.req.query("failed");
  return c.html(
    <MeetingPollsPage
      user={toSidebarUser(user!)}
      accounts={accounts}
      polls={polls}
      allowedDurations={allowedAppointmentDurations(settings)}
      remoteAvailable={settings.meet_account_id != null}
      sent={sentParam ? Number(sentParam) : undefined}
      failed={failedParam ? Number(failedParam) : undefined}
    />,
  );
});

// HTML-only, requireAuth-gated — poll creation is invite creation under a
// different kind (task_plan.md Phase 7.3), inheriting the same "owner login
// only" enforcement every other /dashboard/* route gets, with
// createMeetingPollWithSlots itself independently re-checking account
// ownership as a second layer (see trustedAccess.ts), same as createInvite.
meetingPolls.post("/dashboard/meeting-polls", async (c) => {
  const session = c.get("session");
  const body = await c.req.parseBody({ all: true });

  const modality = parseModality(body.modality);
  if (!modality) {
    return c.text("Invalid meeting type. Must be 'in_person' or 'remote'.", 400);
  }
  const duration = Number(body.durationMinutes);
  const accountId = String(body.accountId ?? "");
  const title = String(body.title ?? "");
  const slotStarts = parseSlotList(body.slotStarts as string | string[] | undefined);
  const emails = parseEmailList(String(body.emails ?? ""));

  let pollId: string;
  try {
    pollId = await createMeetingPollWithSlots(c.env, {
      userId: session.userId,
      accountId,
      title,
      durationMinutes: duration,
      modality,
      slotStarts,
    });
  } catch (err) {
    return c.text(err instanceof Error ? err.message : "Failed to create poll.", 400);
  }

  const baseUrl = new URL(c.req.url).origin;
  // Per-email isolation, not all-or-nothing — same reasoning as
  // routes/invites.tsx: one bad address in a pasted batch shouldn't stop the
  // rest from going out. The poll itself is already created and usable
  // (finalizable) even if every single send fails; the owner can retry
  // sending from the poll detail page's participant list later if this
  // codebase grows a resend action (not built here, out of scope for 7.3).
  let sent = 0;
  let failed = 0;
  for (const email of emails) {
    try {
      const id = await createInvite(c.env, {
        userId: session.userId,
        accountId,
        kind: "meeting_poll",
        inviteeEmail: email,
        meetingPollId: pollId,
      });
      await sendInviteEmail(c.env, { id, inviteeEmail: email, kind: "meeting_poll" }, baseUrl);
      sent++;
    } catch (err) {
      console.error(`Failed to create/send poll invite to ${email}:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  return c.redirect(`/dashboard/meeting-polls/${pollId}?sent=${sent}&failed=${failed}`, 303);
});

meetingPolls.get("/dashboard/meeting-polls/:id", async (c) => {
  const session = c.get("session");
  const poll = await findMeetingPollForUser(c.env.DB, session.userId, c.req.param("id"));
  if (!poll) return c.text("Poll not found.", 404);
  const [user, tally, accounts] = await Promise.all([
    findUserById(c.env.DB, session.userId),
    getPollTally(c.env, poll.id),
    listAccountsForUser(c.env.DB, session.userId),
  ]);
  const sentParam = c.req.query("sent");
  const failedParam = c.req.query("failed");
  return c.html(
    <MeetingPollDetailPage
      user={toSidebarUser(user!)}
      poll={poll}
      tally={tally}
      accounts={accounts}
      error={lookupErrorMessage(c.req.query("error"))}
      sent={sentParam ? Number(sentParam) : undefined}
      failed={failedParam ? Number(failedParam) : undefined}
    />,
  );
});

meetingPolls.post("/dashboard/meeting-polls/:id/finalize", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await finalizePoll(c.env, session.userId, id);
  if (!result.ok) {
    return c.redirect(`/dashboard/meeting-polls/${id}?error=${encodeURIComponent(result.reason)}`, 303);
  }
  return c.redirect(`/dashboard/meeting-polls/${id}`, 303);
});

meetingPolls.post("/dashboard/meeting-polls/:id/cancel", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const cancelled = await cancelPoll(c.env, session.userId, id);
  if (!cancelled) {
    // cancelOpenPoll only ever fails on a poll that isn't found or isn't
    // 'open' — the previous version discarded this and always redirected as
    // if it worked, so cancelling an already-finalized poll (or one from a
    // stale/wrong id) looked identical to success. Found in an independent
    // security review of Phase 7.3.
    return c.redirect(`/dashboard/meeting-polls/${id}?error=cancel-failed`, 303);
  }
  return c.redirect(`/dashboard/meeting-polls/${id}`, 303);
});

export default meetingPolls;
