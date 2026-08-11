import { Hono } from "hono";
import type { AppBindings, Env } from "./types";
import authRoutes from "./routes/auth";
import { listUserIds } from "./db/schema";
import { runFullSync } from "./services/syncEngine";

const app = new Hono<AppBindings>();

app.get("/", (c) => c.json({ name: "cf-cal-replication", status: "skeleton" }));
app.route("/", authRoutes);

// Isolated per user: runFullSync already isolates per-account failures and
// records them in sync_logs, but a structural failure (e.g. listing that
// user's accounts itself throwing) shouldn't stop other users' syncs.
async function runScheduledSync(env: Env): Promise<void> {
  const userIds = await listUserIds(env.DB);
  for (const userId of userIds) {
    try {
      await runFullSync(env, userId);
    } catch (err) {
      console.error(`Sync failed for user ${userId}:`, err instanceof Error ? err.message : err);
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledSync(env));
  },
} satisfies ExportedHandler<Env>;
