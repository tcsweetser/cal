import type { FC } from "hono/jsx";
import type { AccountRow, TrustedInviteRow } from "../db/schema";
import { Layout, type SidebarUser } from "./layout";

const statusBadge = (status: TrustedInviteRow["status"]) => <span class={`badge badge-${status}`}>{status}</span>;

export const InvitesPage: FC<{
  user: SidebarUser;
  accounts: AccountRow[];
  invites: TrustedInviteRow[];
  allowedDurations: number[];
  remoteAvailable: boolean;
  sent?: number;
  failed?: number;
}> = ({ user, accounts, invites, allowedDurations, remoteAvailable, sent, failed }) => {
  const activeAccounts = accounts.filter((a) => a.status === "active");
  const accountEmail = (accountId: string) => accounts.find((a) => a.id === accountId)?.email ?? accountId;

  return (
    <Layout title="Appointment invites" active="invites" user={user}>
      <h1>Appointment invites</h1>
      <p class="lede">
        Send a one-time booking link to a trusted party who doesn't have an account here. They verify their email,
        then pick a time — a generic placeholder event is added to the calendar you choose below. No title,
        description, or other detail they enter is ever written to the real calendar.
      </p>

      {sent !== undefined && (
        <p>
          Sent {sent} invite{sent === 1 ? "" : "s"}
          {failed ? `, ${failed} failed (see server logs)` : ""}.
        </p>
      )}

      <section>
        <h2>Send invites</h2>
        {activeAccounts.length === 0 ? (
          <p class="empty">Connect an active account on the Accounts page before sending invites.</p>
        ) : (
          <form class="card stack" method="post" action="/dashboard/invites">
            <label for="emails">
              Invitee emails (one per line, or comma-separated)
              <textarea id="emails" name="emails" rows={3} required />
            </label>
            <div class="row">
              <label>
                Calendar
                <select name="accountId" required>
                  {activeAccounts.map((account) => (
                    <option value={account.id}>
                      {account.email} ({account.role === "primary" ? "primary" : account.tag})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Length
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
            <div>
              <button class="btn-primary" type="submit">
                Send invites
              </button>
            </div>
          </form>
        )}
      </section>

      <section>
        <h2>Sent invites</h2>
        {invites.length === 0 ? (
          <p class="empty">None sent yet.</p>
        ) : (
          <div class="card card-flush">
            <table>
              <thead>
                <tr>
                  <th>Invitee</th>
                  <th>Calendar</th>
                  <th>Status</th>
                  <th>Booked</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr>
                    <td>
                      <code>{invite.invitee_email}</code>
                    </td>
                    <td>
                      <code>{accountEmail(invite.account_id)}</code>
                    </td>
                    <td>{statusBadge(invite.status)}</td>
                    <td>{invite.booked_start ? new Date(invite.booked_start).toLocaleString() : "—"}</td>
                    <td>{new Date(invite.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Layout>
  );
};
