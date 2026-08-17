import type { FC } from "hono/jsx";
import type { AccountRow, TrustedInviteRow } from "../db/schema";
import { Layout } from "./layout";

const statusBadge = (status: TrustedInviteRow["status"]) => <span class={`badge badge-${status}`}>{status}</span>;

export const InvitesPage: FC<{
  accounts: AccountRow[];
  invites: TrustedInviteRow[];
  allowedDurations: number[];
  remoteAvailable: boolean;
  sent?: number;
  failed?: number;
}> = ({ accounts, invites, allowedDurations, remoteAvailable, sent, failed }) => {
  const activeAccounts = accounts.filter((a) => a.status === "active");
  const accountEmail = (accountId: string) => accounts.find((a) => a.id === accountId)?.email ?? accountId;

  return (
    <Layout title="Appointment invites">
      <h1>Appointment invites</h1>
      <p>
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
          <form method="post" action="/dashboard/invites">
            <p>
              <label for="emails">Invitee emails (one per line, or comma-separated):</label>
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
                Appointment length:{" "}
                <select name="durationMinutes" required>
                  {allowedDurations.map((minutes) => (
                    <option value={minutes} selected={minutes === allowedDurations[0]}>
                      {minutes} minutes
                    </option>
                  ))}
                </select>
              </label>{" "}
              <span class="empty">(configurable on the Settings page)</span>
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
            <button type="submit">Send invites</button>
          </form>
        )}
      </section>

      <section>
        <h2>Sent invites</h2>
        {invites.length === 0 ? (
          <p class="empty">None sent yet.</p>
        ) : (
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
        )}
      </section>
    </Layout>
  );
};
