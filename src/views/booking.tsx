import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { PublicShell } from "./layout";

// Mirrors the mockup's 4-dot step indicator (Verify email / Enter code /
// Pick time / Confirmed) — purely cosmetic, doesn't affect which step is
// actually being rendered (each step is still its own real page/route).
const BOOKING_STEPS = ["Verify email", "Enter code", "Pick time", "Confirmed"] as const;
const ProgressDots: FC<{ step: number }> = ({ step }) => (
  <div style="display: flex; gap: 0.375rem; margin-bottom: 1.75rem;">
    {BOOKING_STEPS.map((_, i) => (
      <div
        style={`flex: 1; height: 4px; border-radius: 999px; background: ${
          i <= step ? "var(--accent)" : "var(--border)"
        };`}
      />
    ))}
  </div>
);

export const BookingErrorPage: FC<{ message: string }> = ({ message }) => (
  <PublicShell title="Booking link">
    <h1>This link isn't available</h1>
    <p>{message}</p>
  </PublicShell>
);

export const EmailVerifyForm: FC<{ inviteId: string; error?: string }> = ({ inviteId, error }) => (
  <PublicShell title="Verify your email">
    <ProgressDots step={0} />
    <h1>Verify your email</h1>
    <p class="lede" style="max-width: none;">
      Enter your email address and we'll send you a 6-digit code to confirm it's really you.
    </p>
    {error && <p class="error">{error}</p>}
    <form class="stack" method="post" action={`/book/${inviteId}/verify`}>
      <label for="email">
        Email address
        <input type="email" id="email" name="email" required />
      </label>
      <div>
        <button class="btn-primary" type="submit">
          Send code
        </button>
      </div>
    </form>
  </PublicShell>
);

export const CodeEntryForm: FC<{ inviteId: string; email: string; error?: string }> = ({
  inviteId,
  email,
  error,
}) => (
  <PublicShell title="Enter your code">
    <ProgressDots step={1} />
    <h1>Enter your code</h1>
    <p class="lede" style="max-width: none;">
      We sent a 6-digit code to <code>{email}</code>. It expires in 10 minutes.
    </p>
    {error && <p class="error">{error}</p>}
    <form class="stack" method="post" action={`/book/${inviteId}/confirm-email`}>
      <input type="hidden" name="email" value={email} />
      <label for="code">
        Code
        <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} required />
      </label>
      <div>
        <button class="btn-primary" type="submit">
          Confirm
        </button>
      </div>
    </form>
    <form method="post" action={`/book/${inviteId}/verify`} style="margin-top: 0.75rem;">
      <input type="hidden" name="email" value={email} />
      <p class="hint">
        Didn't get it? <button class="link" type="submit">Resend code</button> (once per minute)
      </p>
    </form>
  </PublicShell>
);

// Slot values are exact UTC instants (see computeAvailableSlots,
// trustedAccess.ts) — real availability, not blind-accept. There's no
// timezone field to submit at all: what gets POSTed back on confirm is one
// of these exact values, unmodified, so there's nothing for this form to get
// wrong or for a client to need to disambiguate. The inline script only
// rewrites each <option>'s *display text* to the browser's local
// representation of that same instant — a pure display convenience, not
// something the submitted value depends on.
export const SlotPickerForm: FC<{ inviteId: string; slots: string[]; durationMinutes: number; error?: string }> = ({
  inviteId,
  slots,
  durationMinutes,
  error,
}) => (
  <PublicShell title="Pick a time" wide>
    <ProgressDots step={2} />
    <h1>Pick a time</h1>
    <p class="lede" style="max-width: none;">
      This will book a {durationMinutes}-minute appointment. It's shown as busy time only — no details are shared.
      Times below are shown in your own local time.
    </p>
    {error && <p class="error">{error}</p>}
    {slots.length === 0 ? (
      <p>No times are available right now. Please check back later.</p>
    ) : (
      <form method="post" action={`/book/${inviteId}/confirm`}>
        <style>
          {raw(
            ".slot-option { display: flex; align-items: center; gap: 0.625rem; padding: 0.7rem 0.875rem; " +
              "border-radius: 8px; border: 1px solid var(--border); cursor: pointer; font-size: 0.85rem; } " +
              ".slot-option:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }",
          )}
        </style>
        <div class="stack" style="gap: 0.5rem; margin-bottom: 1.375rem;">
          {slots.map((iso, i) => (
            <label class="slot-option">
              <input type="radio" name="start" value={iso} required checked={i === 0} />
              <span class="local-time" data-start={iso}>
                {iso}
              </span>
            </label>
          ))}
        </div>
        <script>
          {raw(
            "document.querySelectorAll('.local-time[data-start]').forEach(function(el) { " +
              "el.textContent = new Date(el.dataset.start).toLocaleString(undefined, " +
              "{ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); });",
          )}
        </script>
        <button class="btn-primary" type="submit">
          Book appointment
        </button>
      </form>
    )}
  </PublicShell>
);

export const BookingConfirmedPage: FC<{ startIso: string; durationMinutes: number }> = ({
  startIso,
  durationMinutes,
}) => (
  <PublicShell title="Appointment booked">
    <ProgressDots step={3} />
    <h1>You're booked</h1>
    <p class="lede" style="max-width: none;">
      {durationMinutes} minutes starting{" "}
      <strong id="confirmed-start" data-start={startIso} style="color: var(--text);">
        {startIso}
      </strong>{" "}
      (your local time). You can close this page.
    </p>
    <script>
      {raw(
        "(function(){ var el = document.getElementById('confirmed-start'); " +
          "el.textContent = new Date(el.dataset.start).toLocaleString(); })();",
      )}
    </script>
  </PublicShell>
);
