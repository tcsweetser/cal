import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { AccountRow, MeetingPollRow } from "../db/schema";
import type { PollTally } from "../services/trustedAccess";
import { Layout } from "./layout";

const statusBadge = (status: MeetingPollRow["status"]) => <span class={`badge badge-${status}`}>{status}</span>;

// These pages render server-side in the Workers runtime, where Intl's
// resolved timezone is UTC, not the owner's — new Date(...).toLocaleString()
// called directly in JSX (the original Phase 7.3 implementation) silently
// rendered every booked/candidate time in UTC with no zone label, while
// views/pollVoting.tsx (the participant-facing page) already converted
// client-side correctly. Found in an independent security review of Phase
// 7.3: a UTC "12:00:00 pm" rendered for a slot the owner entered as 8pm
// local is exactly the kind of mistake that leads to finalizing the wrong
// meeting. Same data-start + client-side-conversion pattern as
// views/pollVoting.tsx — every element needing this carries
// class="local-time" and a data-start ISO instant; this one script (per
// page) converts all of them in one pass.
const LocalTimeScript = () => (
  <script>
    {raw(
      "document.querySelectorAll('.local-time[data-start]').forEach(function(el) { " +
        "el.textContent = new Date(el.dataset.start).toLocaleString(); });",
    )}
  </script>
);

// Fixed set of candidate-time rows rather than a dynamically growable list
// (no precedent for cloning form rows elsewhere in this codebase, and this
// covers the common case) — blank rows are simply ignored server-side
// (parseSlotList, routes/meetingPolls.tsx). Between MIN_POLL_SLOTS (2) and
// MAX_POLL_SLOTS (20) from trustedAccess.ts, chosen as a reasonable default
// for a typical small poll.
const CANDIDATE_SLOT_ROWS = 6;

export const MeetingPollsPage: FC<{
  accounts: AccountRow[];
  polls: MeetingPollRow[];
  allowedDurations: number[];
  remoteAvailable: boolean;
  sent?: number;
  failed?: number;
}> = ({ accounts, polls, allowedDurations, remoteAvailable, sent, failed }) => {
  const activeAccounts = accounts.filter((a) => a.status === "active");
  const accountEmail = (accountId: string) => accounts.find((a) => a.id === accountId)?.email ?? accountId;

  return (
    <Layout title="Meeting polls">
      <h1>Meeting polls</h1>
      <p>
        Propose a few candidate times to a group and let them vote on which ones work. Once everyone agrees on a
        time, finalize the poll to book it — a generic placeholder event is added to the calendar you choose below.
      </p>

      {sent !== undefined && (
        <p>
          Sent {sent} invite{sent === 1 ? "" : "s"}
          {failed ? `, ${failed} failed (see server logs)` : ""}.
        </p>
      )}

      <section>
        <h2>Create a poll</h2>
        {activeAccounts.length === 0 ? (
          <p class="empty">Connect an active account on the Accounts page before creating a poll.</p>
        ) : (
          <form method="post" action="/dashboard/meeting-polls">
            <p>
              <label for="title">What's this meeting about?</label>
              <br />
              <input type="text" id="title" name="title" required />
            </p>
            <p>
              <label for="emails">Participant emails (one per line, or comma-separated):</label>
              <br />
              <textarea id="emails" name="emails" rows={4} cols={50} required />
            </p>
            <p>
              <label>
                Calendar to book on:{" "}
                <select name="accountId" required>
                  {activeAccounts.map((account) => (
                    <option value={account.id}>
                      {account.email} ({account.role === "primary" ? "primary" : account.tag})
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                Duration:{" "}
                <select name="durationMinutes" required>
                  {allowedDurations.map((minutes) => (
                    <option value={minutes} selected={minutes === allowedDurations[0]}>
                      {minutes} minutes
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                <input type="radio" name="modality" value="in_person" checked />
                In person
              </label>{" "}
              <label>
                <input type="radio" name="modality" value="remote" disabled={!remoteAvailable} />
                Remote{!remoteAvailable && " (configure a Meet account in Settings to enable)"}
              </label>
            </p>
            <p>
              <label>Candidate times (fill in at least 2, in your own local time):</label>
              {Array.from({ length: CANDIDATE_SLOT_ROWS }).map(() => (
                <span class="slot-row">
                  <input type="datetime-local" class="slot-local" />
                  <input type="hidden" name="slotStarts" class="slot-utc" />
                </span>
              ))}
            </p>
            <script>
              {raw(
                "document.querySelectorAll('.slot-row').forEach(function(row) { " +
                  "var local = row.querySelector('.slot-local'); var hidden = row.querySelector('.slot-utc'); " +
                  "local.addEventListener('input', function() { hidden.value = local.value ? new Date(local.value).toISOString() : ''; }); });",
              )}
            </script>
            <p>
              <button type="submit">Create poll</button>
            </p>
          </form>
        )}
      </section>

      <section>
        <h2>Your polls</h2>
        {polls.length === 0 ? (
          <p class="empty">None created yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Calendar</th>
                <th>Status</th>
                <th>Booked</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {polls.map((poll) => (
                <tr>
                  <td>
                    <a href={`/dashboard/meeting-polls/${poll.id}`}>{poll.title}</a>
                  </td>
                  <td>
                    <code>{accountEmail(poll.account_id)}</code>
                  </td>
                  <td>{statusBadge(poll.status)}</td>
                  <td>
                    {poll.booked_start ? (
                      <span class="local-time" data-start={poll.booked_start}>
                        {poll.booked_start}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{new Date(poll.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <LocalTimeScript />
    </Layout>
  );
};

export const MeetingPollDetailPage: FC<{
  poll: MeetingPollRow;
  tally: PollTally;
  accounts: AccountRow[];
  error?: string;
  sent?: number;
  failed?: number;
}> = ({ poll, tally, accounts, error, sent, failed }) => {
  const accountEmail = accounts.find((a) => a.id === poll.account_id)?.email ?? poll.account_id;

  return (
    <Layout title={poll.title}>
      <p>
        <a href="/dashboard/meeting-polls">&larr; All polls</a>
      </p>
      <h1>
        {poll.title} {statusBadge(poll.status)}
      </h1>
      <p>
        <code>{accountEmail}</code> &middot; {poll.duration_minutes} minutes &middot;{" "}
        {poll.modality === "remote" ? "Remote" : "In person"}
      </p>

      {sent !== undefined && (
        <p>
          Sent {sent} invite{sent === 1 ? "" : "s"}
          {failed ? `, ${failed} failed (see server logs)` : ""}.
        </p>
      )}
      {error && (
        <p class="error">
          <strong>{error}</strong>
        </p>
      )}

      {poll.status === "finalized" && poll.booked_start && (
        <p>
          Booked for{" "}
          <strong class="local-time" data-start={poll.booked_start}>
            {poll.booked_start}
          </strong>
          .
        </p>
      )}

      <section>
        <h2>Votes ({tally.totalParticipants} participant{tally.totalParticipants === 1 ? "" : "s"} so far)</h2>
        {tally.slots.length === 0 ? (
          <p class="empty">No candidate times.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Available</th>
              </tr>
            </thead>
            <tbody>
              {tally.slots.map((s) => (
                <tr>
                  <td>
                    <span class="local-time" data-start={s.slot.start_time}>
                      {s.slot.start_time}
                    </span>
                    {s.slot.id === poll.chosen_slot_id && " (chosen)"}
                  </td>
                  <td>
                    {s.availableCount} / {tally.totalParticipants}
                    {s.fullyAvailable && tally.totalParticipants > 0 && " ✓ everyone available"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {poll.status === "open" && (
        <section>
          <form method="post" action={`/dashboard/meeting-polls/${poll.id}/finalize`} class="inline">
            <button type="submit">Finalize (books the first fully-available time)</button>
          </form>{" "}
          <form method="post" action={`/dashboard/meeting-polls/${poll.id}/cancel`} class="inline">
            <button type="submit">Cancel poll</button>
          </form>
        </section>
      )}
      <LocalTimeScript />
    </Layout>
  );
};
