import type { FC } from "hono/jsx";
import type { AccountRow } from "../db/schema";
import { Layout } from "./layout";

// Read-only: for `secondary` accounts, the tag is fixed at connect time (see
// /dashboard's connect form and plan.md §5.4 — the schema requires
// `accounts.tag` to be set the moment a secondary row is created, never
// NULL). `primary` accounts always have `tag = NULL` — there's only one, so
// nothing to label. Either way, there's nothing to edit here yet.
export const MappingsPage: FC<{ accounts: AccountRow[] }> = ({ accounts }) => (
  <Layout title="Roles & Tags">
    <h1>Roles &amp; Tags</h1>
    <p>
      Exactly one <code>primary</code> account (your main calendar) and any number of <code>secondary</code>{" "}
      accounts, each tagged <code>business</code>, <code>side_hustle</code>, or <code>personal</code> — a label
      only, it never changes how events replicate. See <code>plan.md</code> §1 for the full topology.
    </p>
    <table>
      <thead>
        <tr>
          <th>Email</th>
          <th>Role</th>
          <th>Tag</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((account) => (
          <tr>
            <td>
              <code>{account.email}</code>
            </td>
            <td>{account.role}</td>
            <td>{account.tag ?? "—"}</td>
            <td>
              <span class={`badge badge-${account.status}`}>{account.status}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </Layout>
);
