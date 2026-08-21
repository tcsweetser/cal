import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { MeetingPollSlotRow } from "../db/schema";
import { PublicShell } from "./layout";

export const PollErrorPage: FC<{ message: string }> = ({ message }) => (
  <PublicShell title="Meeting poll">
    <h1>This link isn't available</h1>
    <p>{message}</p>
  </PublicShell>
);

export const PollEmailVerifyForm: FC<{ inviteId: string; error?: string }> = ({ inviteId, error }) => (
  <PublicShell title="Verify your email">
    <h1>Verify your email</h1>
    <p class="lede" style="max-width: none;">
      Enter your email address and we'll send you a 6-digit code to confirm it's really you.
    </p>
    {error && <p class="error">{error}</p>}
    <form class="stack" method="post" action={`/meet/${inviteId}/verify`}>
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

export const PollCodeEntryForm: FC<{ inviteId: string; email: string; error?: string }> = ({ inviteId, email, error }) => (
  <PublicShell title="Enter your code">
    <h1>Enter your code</h1>
    <p class="lede" style="max-width: none;">
      We sent a 6-digit code to <code>{email}</code>. It expires in 10 minutes.
    </p>
    {error && <p class="error">{error}</p>}
    <form class="stack" method="post" action={`/meet/${inviteId}/confirm-email`}>
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
    <form method="post" action={`/meet/${inviteId}/verify`} style="margin-top: 0.75rem;">
      <input type="hidden" name="email" value={email} />
      <p class="hint">
        Didn't get it? <button class="link" type="submit">Resend code</button> (once per minute)
      </p>
    </form>
  </PublicShell>
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
  <PublicShell title={title} wide>
    <h1>{title}</h1>
    <p class="lede" style="max-width: none;">
      Mark which of these times work for you. You can change your answers any time before the organizer finalizes
      the meeting.
    </p>
    {error && <p class="error">{error}</p>}
    {slots.length === 0 ? (
      <p>No candidate times on this poll.</p>
    ) : (
      <form method="post" action={`/meet/${inviteId}/vote`}>
        <div class="card card-flush" style="margin-bottom: 1.375rem;">
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
        </div>
        <script>
          {raw(
            "document.querySelectorAll('td[data-start]').forEach(function(td) { " +
              "td.textContent = new Date(td.dataset.start).toLocaleString(undefined, " +
              "{ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); });",
          )}
        </script>
        <button class="btn-primary" type="submit">
          Save my availability
        </button>
      </form>
    )}
  </PublicShell>
);

export const PollFinalizedPage: FC<{ title: string; bookedStart: string | null; durationMinutes: number }> = ({
  title,
  bookedStart,
  durationMinutes,
}) => (
  <PublicShell title={title}>
    <h1>{title}</h1>
    <p class="lede" style="max-width: none;">
      This meeting has been scheduled for{" "}
      {bookedStart ? (
        <strong id="poll-final-start" data-start={bookedStart} style="color: var(--text);">
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
  </PublicShell>
);
