import type { FC } from "hono/jsx";
import type { AccountRow } from "../db/schema";
import { Layout, type SidebarUser } from "./layout";

const statusBadge = (status: AccountRow["status"]) => <span class={`badge badge-${status}`}>{status}</span>;

export const DashboardPage: FC<{
  user: SidebarUser;
  primaryAccount: AccountRow | null;
  secondaryAccounts: AccountRow[];
}> = ({ user, primaryAccount, secondaryAccounts }) => (
  <Layout title="Accounts" active="accounts" user={user}>
    <h1>Accounts</h1>

    <section>
      <h2>Primary</h2>
      {primaryAccount ? (
        <div class="card row">
          <code>{primaryAccount.email}</code> {statusBadge(primaryAccount.status)}
        </div>
      ) : (
        <p class="empty">No primary account found.</p>
      )}
    </section>

    <section>
      <h2>Secondary accounts</h2>
      {secondaryAccounts.length === 0 ? (
        <p class="empty">None connected yet — add one below.</p>
      ) : (
        <div class="card card-flush">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Tag</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {secondaryAccounts.map((account) => (
                <tr>
                  <td>
                    <code>{account.email}</code>
                  </td>
                  <td>{account.tag}</td>
                  <td>{statusBadge(account.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <section>
      <h2>Connect a secondary account</h2>
      <form class="card row" method="get" action="/auth/connect-account">
        <label class="inline">
          Tag:
          <select name="tag" required>
            <option value="business">business</option>
            <option value="side_hustle">side_hustle</option>
            <option value="personal">personal</option>
          </select>
        </label>
        <button class="btn-primary" type="submit">
          Connect with Google
        </button>
      </form>
    </section>
  </Layout>
);
