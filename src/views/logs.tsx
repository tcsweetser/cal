import type { FC } from "hono/jsx";
import type { SyncLogRow } from "../db/schema";
import { Layout, type SidebarUser } from "./layout";

export const LogsPage: FC<{ user: SidebarUser; logs: SyncLogRow[] }> = ({ user, logs }) => (
  <Layout title="Sync Logs" active="logs" user={user}>
    <div class="row" style="justify-content: space-between; margin-bottom: 1.5rem;">
      <h1 style="margin: 0;">Sync Logs</h1>
      <form method="post" action="/api/trigger-sync">
        <button type="submit">Run sync now</button>
      </form>
    </div>

    {logs.length === 0 ? (
      <p class="empty">No sync runs yet.</p>
    ) : (
      <div class="card card-flush">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Status</th>
              <th>Events</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr>
                <td>{log.created_at}</td>
                <td>
                  <span class={`badge badge-${log.status}`}>{log.status}</span>
                </td>
                <td>{log.events_processed}</td>
                <td>{log.message ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Layout>
);
