import { Hono, type Context } from "hono";
import type { AppBindings } from "../types";
import {
  getUsableInvite,
  requestEmailVerification,
  confirmEmailVerification,
  computeAvailableSlots,
  confirmAppointmentBooking,
  type RequestVerificationResult,
  type ConfirmVerificationResult,
  type AvailableSlotsResult,
} from "../services/trustedAccess";
import {
  BookingErrorPage,
  EmailVerifyForm,
  CodeEntryForm,
  SlotPickerForm,
  BookingConfirmedPage,
} from "../views/booking";

// Public, unauthenticated, HTML-only (no JSON response mode) per the
// security model recorded in task_plan.md Phase 7 — every unsafe step
// (comparing a code, transitioning the invite, checking availability,
// writing to Google Calendar) happens entirely server-side inside one of
// these handlers; the client only ever sees the invite id (in the URL) and
// plain form fields.
const booking = new Hono<AppBindings>();

const NOT_AVAILABLE_MESSAGES: Record<"not-found" | "expired" | "revoked", string> = {
  "not-found": "This link doesn't exist. Double-check the URL, or ask for a new invite.",
  expired: "This link has expired. Ask for a new invite.",
  revoked: "This link has been revoked.",
};

const VERIFY_ERROR_MESSAGES: Record<Extract<RequestVerificationResult, { ok: false }>["reason"], string> = {
  "invite-not-available": "This link isn't available anymore.",
  "invalid-email": "That doesn't look like a valid email address.",
  cooldown: "A code was already sent recently — check your inbox, or wait a minute before requesting another.",
  "too-many-targets": "Too many email addresses have been tried for this link.",
};

const CONFIRM_ERROR_MESSAGES: Record<Extract<ConfirmVerificationResult, { ok: false }>["reason"], string> = {
  "invite-not-available": "This link isn't available anymore.",
  "not-requested": "Request a code first.",
  expired: "That code has expired — request a new one.",
  "too-many-attempts": "Too many incorrect attempts. Request a new code.",
  "wrong-code": "That code isn't correct. Please try again.",
};

const SLOTS_ERROR_MESSAGES: Record<Extract<AvailableSlotsResult, { ok: false }>["reason"], string> = {
  "invite-not-available": "This link isn't available anymore.",
  "meet-unavailable": "This appointment can't be booked right now — its remote-meeting setup is unavailable. Contact the organizer.",
};

function normalizeEmail(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

// Shared by the two places that need to show the slot picker (the GET entry
// point for an already-verified invite, and right after email verification
// succeeds) — keeps the "not available" branch in one place.
async function renderSlotPicker(c: Context<AppBindings>, id: string) {
  const result = await computeAvailableSlots(c.env, id);
  if (!result.ok) {
    return c.html(<BookingErrorPage message={SLOTS_ERROR_MESSAGES[result.reason]} />);
  }
  return c.html(<SlotPickerForm inviteId={id} slots={result.slots} durationMinutes={result.durationMinutes} />);
}

booking.get("/book/:id", async (c) => {
  const id = c.req.param("id");
  const result = await getUsableInvite(c.env, id);
  if (!result.invite) {
    return c.html(<BookingErrorPage message={NOT_AVAILABLE_MESSAGES[result.reason]} />);
  }
  const invite = result.invite;
  if (invite.kind !== "appointment" || invite.duration_minutes == null) {
    return c.html(<BookingErrorPage message="This link isn't an appointment invite." />);
  }
  if (invite.status === "used") {
    return c.html(<BookingErrorPage message="This appointment has already been booked." />);
  }
  if (invite.status === "verified") {
    return renderSlotPicker(c, id);
  }
  return c.html(<EmailVerifyForm inviteId={id} />);
});

booking.post("/book/:id/verify", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);

  const result = await requestEmailVerification(c.env, id, email);
  if (!result.ok) {
    return c.html(<EmailVerifyForm inviteId={id} error={VERIFY_ERROR_MESSAGES[result.reason]} />);
  }
  return c.html(<CodeEntryForm inviteId={id} email={email} />);
});

booking.post("/book/:id/confirm-email", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  const code = String(body.code ?? "").trim();

  const result = await confirmEmailVerification(c.env, id, email, code);
  if (!result.ok) {
    return c.html(<CodeEntryForm inviteId={id} email={email} error={CONFIRM_ERROR_MESSAGES[result.reason]} />);
  }
  return renderSlotPicker(c, id);
});

booking.post("/book/:id/confirm", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const start = String(body.start ?? "");

  // Read before attempting the booking, not after — once
  // confirmAppointmentBooking succeeds the invite is 'used' and
  // getUsableInvite would no longer consider it usable, but duration_minutes
  // is still needed for the confirmation page and never changes for an
  // invite regardless of status.
  const before = await getUsableInvite(c.env, id);
  if (!before.invite || before.invite.kind !== "appointment" || before.invite.duration_minutes == null) {
    return c.html(<BookingErrorPage message="This link isn't available anymore." />);
  }
  const durationMinutes = before.invite.duration_minutes;

  const result = await confirmAppointmentBooking(c.env, id, start);
  if (!result.ok) {
    if (result.reason === "invite-not-available") {
      return c.html(<BookingErrorPage message="This link isn't available anymore." />);
    }
    // invalid-time / slot-no-longer-available / meet-unavailable: the
    // invite itself is still usable, so re-offer a fresh slot list rather
    // than dead-ending — the picked slot most likely just went stale.
    const fresh = await computeAvailableSlots(c.env, id);
    if (!fresh.ok) {
      return c.html(<BookingErrorPage message={SLOTS_ERROR_MESSAGES[fresh.reason]} />);
    }
    const error =
      result.reason === "invalid-time"
        ? "Please pick a time in the future."
        : "That time is no longer available — someone may have just booked it. Please pick another.";
    return c.html(<SlotPickerForm inviteId={id} slots={fresh.slots} durationMinutes={fresh.durationMinutes} error={error} />);
  }
  return c.html(<BookingConfirmedPage startIso={start} durationMinutes={durationMinutes} />);
});

export default booking;
