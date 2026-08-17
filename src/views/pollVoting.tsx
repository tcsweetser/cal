import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";
import type { MeetingPollSlotRow } from "../db/schema";

const css = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 480px;
    margin: 4rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
  }
  h1 { font-size: 1.3rem; }
  label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
  input[type="email"], input[type="text"] {
    width: 100%; padding: 0.5rem; font: inherit; box-sizing: border-box;
    border: 1px solid light-dark(#ccc, #444); border-radius: 6px; background: light-dark(#fff, #1a1a1a); color: inherit;
  }
  select {
    font: inherit; padding: 0.35rem; border-radius: 6px; border: 1px solid light-dark(#ccc, #444);
    background: light-dark(#fff, #1a1a1a); color: inherit;
  }
  button {
    margin-top: 1.25rem; font: inherit; padding: 0.6rem 1.2rem; border-radius: 6px;
    border: 1px solid light-dark(#ccc, #444); background: light-dark(#f5f5f5, #222); color: inherit; cursor: pointer;
  }
  button:hover { background: light-dark(#eaeaea, #2c2c2c); }
  .error { color: light-dark(#c0392b, #ff6b5f); }
  .hint { opacity: 0.7; font-size: 0.9em; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid light-dark(#e5e5e5, #2a2a2a); }
`;

// Deliberately not the dashboard's Layout — same reasoning as views/booking.tsx:
// this is public, unauthenticated surface, HTML-only per the security model
// (task_plan.md Phase 7 — no JSON mode).
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

export const PollErrorPage: FC<{ message: string }> = ({ message }) => (
  <PublicLayout title="Meeting poll">
    <h1>This link isn't available</h1>
    <p>{message}</p>
  </PublicLayout>
);

export const PollEmailVerifyForm: FC<{ inviteId: string; error?: string }> = ({ inviteId, error }) => (
  <PublicLayout title="Verify your email">
    <h1>Verify your email</h1>
    <p>Enter your email address and we'll send you a 6-digit code to confirm it's really you.</p>
    {error && <p class="error">{error}</p>}
    <form method="post" action={`/meet/${inviteId}/verify`}>
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" required />
      <button type="submit">Send code</button>
    </form>
  </PublicLayout>
);

export const PollCodeEntryForm: FC<{ inviteId: string; email: string; error?: string }> = ({ inviteId, email, error }) => (
  <PublicLayout title="Enter your code">
    <h1>Enter your code</h1>
    <p>
      We sent a 6-digit code to <code>{email}</code>. It expires in 10 minutes.
    </p>
    {error && <p class="error">{error}</p>}
    <form method="post" action={`/meet/${inviteId}/confirm-email`}>
      <input type="hidden" name="email" value={email} />
      <label for="code">Code</label>
      <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} required />
      <button type="submit">Confirm</button>
    </form>
    <form method="post" action={`/meet/${inviteId}/verify`}>
      <input type="hidden" name="email" value={email} />
      <p class="hint">
        Didn't get it? <button type="submit">Resend code</button> (once per minute)
      </p>
    </form>
  </PublicLayout>
);

// Every slot always submits an explicit yes/no value via <select> (not a
// checkbox) — a checkbox that's simply left unchecked is omitted from the
// submitted form body entirely, which would mean re-marking a previously
// "available" slot as unavailable silently failed to update anything.
// Defaults to the participant's existing vote for that slot if they have
// one (a resubmission, e.g. changing their mind), else "unavailable" — an
// unanswered slot must never silently count as available.
export const PollVotingForm: FC<{
  inviteId: string;
  title: string;
  slots: MeetingPollSlotRow[];
  currentAvailability: Map<string, boolean>;
  error?: string;
}> = ({ inviteId, title, slots, currentAvailability, error }) => (
  <PublicLayout title={title}>
    <h1>{title}</h1>
    <p>Mark which of these times work for you. You can change your answers any time before the organizer finalizes the meeting.</p>
    {error && <p class="error">{error}</p>}
    {slots.length === 0 ? (
      <p>No candidate times on this poll.</p>
    ) : (
      <form method="post" action={`/meet/${inviteId}/vote`}>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Available?</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((slot) => {
              const current = currentAvailability.get(slot.id) ?? false;
              return (
                <tr>
                  <td data-start={slot.start_time}>{slot.start_time}</td>
                  <td>
                    <select name={`available:${slot.id}`}>
                      <option value="yes" selected={current}>
                        Available
                      </option>
                      <option value="no" selected={!current}>
                        Not available
                      </option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <script>
          {raw(
            "document.querySelectorAll('td[data-start]').forEach(function(td) { " +
              "td.textContent = new Date(td.dataset.start).toLocaleString(undefined, " +
              "{ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); });",
          )}
        </script>
        <button type="submit">Save my availability</button>
      </form>
    )}
  </PublicLayout>
);

export const PollFinalizedPage: FC<{ title: string; bookedStart: string | null; durationMinutes: number }> = ({
  title,
  bookedStart,
  durationMinutes,
}) => (
  <PublicLayout title={title}>
    <h1>{title}</h1>
    <p>
      This meeting has been scheduled for{" "}
      {bookedStart ? (
        <strong id="poll-final-start" data-start={bookedStart}>
          {bookedStart}
        </strong>
      ) : (
        "an unknown time"
      )}{" "}
      ({durationMinutes} minutes, your local time). You can close this page.
    </p>
    <script>
      {raw(
        "(function(){ var el = document.getElementById('poll-final-start'); " +
          "if (el) el.textContent = new Date(el.dataset.start).toLocaleString(); })();",
      )}
    </script>
  </PublicLayout>
);
