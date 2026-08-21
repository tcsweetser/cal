import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { AccountRow, MeetingPollRow } from "../db/schema";
import type { PollTally } from "../services/trustedAccess";
import { Layout, type SidebarUser } from "./layout";

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
  user: SidebarUser;
  accounts: AccountRow[];
  polls: MeetingPollRow[];
  allowedDurations: number[];
  remoteAvailable: boolean;
  sent?: number;
  failed?: number;
}> = ({ user, accounts, polls, allowedDurations, remoteAvailable, sent, failed }) => {
  const activeAccounts = accounts.filter((a) => a.status === "active");
  const accountEmail = (accountId: string) => accounts.find((a) => a.id === accountId)?.email ?? accountId;

  return (
    <Layout title="Meeting polls" active="polls" user={user}>
      <h1>Meeting polls</h1>
      <p class="lede">
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
          <form class="card stack" method="post" action="/dashboard/meeting-polls">
            <label for="title">
              What's this meeting about?
              <input type="text" id="title" name="title" required />
            </label>
            <label for="emails">
              Participant emails (one per line, or comma-separated)
              <textarea id="emails" name="emails" rows={2} required />
            </label>
            <div class="row">
              <label>
                Calendar to book on
                <select name="accountId" required>
                  {activeAccounts.map((account) => (
                    <option value={account.id}>
                      {account.email} ({account.role === "primary" ? "primary" : account.tag})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Duration
                <select name="durationMinutes" required>
                  {allowedDurations.map((minutes) => (
                    <option value={minutes} selected={minutes === allowedDurations[0]}>
                      {minutes} minutes
                    </option>
                  ))}
                </select>
              </label>
              <div class="stack" style="gap: 0.375rem;">
                <span style="font-size: 0.8125rem; font-weight: 600; color: var(--text-muted);">Modality</span>
                <div class="row" style="gap: 0.875rem;">
                  <label class="inline">
                    <input type="radio" name="modality" value="in_person" checked />
                    In person
                  </label>
                  <label class="inline">
                    <input type="radio" name="modality" value="remote" disabled={!remoteAvailable} />
                    Remote{!remoteAvailable && " (configure a Meet account in Settings)"}
                  </label>
                </div>
              </div>
            </div>
            <label>
              Candidate times (fill in at least 2, in your own local time)
              <div class="stack" style="gap: 0.5rem;">
                {Array.from({ length: CANDIDATE_SLOT_ROWS }).map(() => (
                  <span class="slot-row">
                    <input type="datetime-local" class="slot-local" style="max-width: 16rem;" />
                    <input type="hidden" name="slotStarts" class="slot-utc" />
                  </span>
                ))}
              </div>
            </label>
            <script>
              {raw(
                "document.querySelectorAll('.slot-row').forEach(function(row) { " +
                  "var local = row.querySelector('.slot-local'); var hidden = row.querySelector('.slot-utc'); " +
                  "local.addEventListener('input', function() { hidden.value = local.value ? new Date(local.value).toISOString() : ''; }); });",
              )}
            </script>
            <div>
              <button class="btn-primary" type="submit">
                Create poll
              </button>
            </div>
          </form>
        )}
      </section>

      <section>
        <h2>Your polls</h2>
        {polls.length === 0 ? (
          <p class="empty">None created yet.</p>
        ) : (
          <div class="card card-flush">
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
                      <a class="text-link" href={`/dashboard/meeting-polls/${poll.id}`}>
                        {poll.title}
                      </a>
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
          </div>
        )}
      </section>
      <LocalTimeScript />
    </Layout>
  );
};

export const MeetingPollDetailPage: FC<{
  user: SidebarUser;
  poll: MeetingPollRow;
  tally: PollTally;
  accounts: AccountRow[];
  error?: string;
  sent?: number;
  failed?: number;
}> = ({ user, poll, tally, accounts, error, sent, failed }) => {
  const accountEmail = accounts.find((a) => a.id === poll.account_id)?.email ?? poll.account_id;

  return (
    <Layout title={poll.title} active="polls" user={user}>
      <p style="margin: 0 0 1rem;">
        <a class="text-link" href="/dashboard/meeting-polls">
          &larr; All polls
        </a>
      </p>
      <h1 style="display: flex; align-items: center; gap: 0.625rem; margin-bottom: 0.5rem;">
        {poll.title} {statusBadge(poll.status)}
      </h1>
      <p class="lede" style="margin-bottom: 1.75rem;">
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
          <div class="card card-flush" style="margin-bottom: 1.25rem;">
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
          </div>
        )}
        {poll.status === "open" && (
          <div class="row">
            <form method="post" action={`/dashboard/meeting-polls/${poll.id}/finalize`}>
              <button class="btn-primary" type="submit">
                Finalize (books first fully-available time)
              </button>
            </form>
            <form method="post" action={`/dashboard/meeting-polls/${poll.id}/cancel`}>
              <button type="submit">Cancel poll</button>
            </form>
          </div>
        )}
      </section>
      <LocalTimeScript />
    </Layout>
  );
};
