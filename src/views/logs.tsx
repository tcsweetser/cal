import type { FC } from "hono/jsx";
import type { SyncLogRow } from "../db/schema";
import { Layout } from "./layout";

export const LogsPage: FC<{ logs: SyncLogRow[] }> = ({ logs }) => (
  <Layout title="Sync Logs">
    <h1>Sync Logs</h1>

    <form class="inline" method="post" action="/api/trigger-sync">
      <button type="submit">Run sync now</button>
    </form>

    {logs.length === 0 ? (
      <p class="empty">No sync runs yet.</p>
    ) : (
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
    )}
  </Layout>
);
