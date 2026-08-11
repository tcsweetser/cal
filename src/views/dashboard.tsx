import type { FC } from "hono/jsx";
import type { AccountRow } from "../db/schema";
import { Layout } from "./layout";

const statusBadge = (status: AccountRow["status"]) => <span class={`badge badge-${status}`}>{status}</span>;

export const DashboardPage: FC<{ primaryAccount: AccountRow | null; secondaryAccounts: AccountRow[] }> = ({
  primaryAccount,
  secondaryAccounts,
}) => (
  <Layout title="Accounts">
    <h1>Accounts</h1>

    <section>
      <h2>Primary</h2>
      {primaryAccount ? (
        <p>
          <code>{primaryAccount.email}</code> {statusBadge(primaryAccount.status)}
        </p>
      ) : (
        <p class="empty">No primary account found.</p>
      )}
    </section>

    <section>
      <h2>Secondary accounts</h2>
      {secondaryAccounts.length === 0 ? (
        <p class="empty">None connected yet — add one below.</p>
      ) : (
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
      )}
    </section>

    <section>
      <h2>Connect a secondary account</h2>
      <form method="get" action="/auth/connect-account">
        <label>
          Tag:{" "}
          <select name="tag" required>
            <option value="business">business</option>
            <option value="side_hustle">side_hustle</option>
            <option value="personal">personal</option>
          </select>
        </label>{" "}
        <button type="submit">Connect with Google</button>
      </form>
    </section>
  </Layout>
);
