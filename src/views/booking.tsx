import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";

const css = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 420px;
    margin: 4rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
  }
  h1 { font-size: 1.3rem; }
  label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
  input[type="email"], input[type="text"], input[type="datetime-local"] {
    width: 100%; padding: 0.5rem; font: inherit; box-sizing: border-box;
    border: 1px solid light-dark(#ccc, #444); border-radius: 6px; background: light-dark(#fff, #1a1a1a); color: inherit;
  }
  button {
    margin-top: 1.25rem; font: inherit; padding: 0.6rem 1.2rem; border-radius: 6px;
    border: 1px solid light-dark(#ccc, #444); background: light-dark(#f5f5f5, #222); color: inherit; cursor: pointer;
  }
  button:hover { background: light-dark(#eaeaea, #2c2c2c); }
  .error { color: light-dark(#c0392b, #ff6b5f); }
  .hint { opacity: 0.7; font-size: 0.9em; }
`;

// Deliberately not the dashboard's Layout (no nav, no assumption of an
// authenticated session) — same reasoning as views/login.tsx: this is public,
// unauthenticated surface, HTML-only per the security model (task_plan.md
// Phase 7 — no JSON mode, so there's nothing here for a scripted client to
// discover or drive beyond submitting these exact forms).
const PublicLayout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — CAL</title>
      <style>{raw(css)}</style>
    </head>
    <body>{children}</body>
  </html>
);

export const BookingErrorPage: FC<{ message: string }> = ({ message }) => (
  <PublicLayout title="Booking link">
    <h1>This link isn't available</h1>
    <p>{message}</p>
  </PublicLayout>
);

export const EmailVerifyForm: FC<{ inviteId: string; error?: string }> = ({ inviteId, error }) => (
  <PublicLayout title="Verify your email">
    <h1>Verify your email</h1>
    <p>Enter your email address and we'll send you a 6-digit code to confirm it's really you.</p>
    {error && <p class="error">{error}</p>}
    <form method="post" action={`/book/${inviteId}/verify`}>
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" required />
      <button type="submit">Send code</button>
    </form>
  </PublicLayout>
);

export const CodeEntryForm: FC<{ inviteId: string; email: string; error?: string }> = ({
  inviteId,
  email,
  error,
}) => (
  <PublicLayout title="Enter your code">
    <h1>Enter your code</h1>
    <p>
      We sent a 6-digit code to <code>{email}</code>. It expires in 10 minutes.
    </p>
    {error && <p class="error">{error}</p>}
    <form method="post" action={`/book/${inviteId}/confirm-email`}>
      <input type="hidden" name="email" value={email} />
      <label for="code">Code</label>
      <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} required />
      <button type="submit">Confirm</button>
    </form>
    <form method="post" action={`/book/${inviteId}/verify`}>
      <input type="hidden" name="email" value={email} />
      <p class="hint">
        Didn't get it? <button type="submit">Resend code</button> (once per minute)
      </p>
    </form>
  </PublicLayout>
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
  <PublicLayout title="Pick a time">
    <h1>Pick a time</h1>
    <p>
      This will book a {durationMinutes}-minute appointment. It's shown as busy time only — no details are shared.
      Times below are shown in your own local time.
    </p>
    {error && <p class="error">{error}</p>}
    {slots.length === 0 ? (
      <p>No times are available right now. Please check back later.</p>
    ) : (
      <form method="post" action={`/book/${inviteId}/confirm`}>
        <label for="start">Start time</label>
        <select id="start" name="start" required>
          {slots.map((iso) => (
            <option value={iso}>{iso}</option>
          ))}
        </select>
        <script>
          {raw(
            "document.querySelectorAll('#start option').forEach(function(o) { " +
              "o.textContent = new Date(o.value).toLocaleString(undefined, " +
              "{ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); });",
          )}
        </script>
        <button type="submit">Book appointment</button>
      </form>
    )}
  </PublicLayout>
);

export const BookingConfirmedPage: FC<{ startIso: string; durationMinutes: number }> = ({
  startIso,
  durationMinutes,
}) => (
  <PublicLayout title="Appointment booked">
    <h1>You're booked</h1>
    <p>
      {durationMinutes} minutes starting{" "}
      <strong id="confirmed-start" data-start={startIso}>
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
  </PublicLayout>
);
