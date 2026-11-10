import { Hono } from "hono";
import type { AppBindings } from "../types";
import { requireAuth } from "../middleware/auth";
import { runFullSync } from "../services/syncEngine";
import { countSeriesMappingsForUser } from "../db/seriesSchema";
import {
  isSeriesRollbackActive,
  runSeriesRollbackBatch,
  SERIES_ROLLBACK_KV_KEY,
} from "../services/seriesRollback";

const api = new Hono<AppBindings>();

api.post("/api/trigger-sync", requireAuth, async (c) => {
  const session = c.get("session");
  // runFullSync's outer catch rethrows on structural failures (plan.md
  // §5.3) — runScheduledSync (services/syncScheduler.ts) already guards against that
  // turning into an unhandled rejection; this call site needs the
  // same guard.
  // While the rollback flag is set a manual sync removes replica series like
  // a tick does; a full sync would re-create what is being removed.
  const rollback = await isSeriesRollbackActive(c.env);
  c.executionCtx.waitUntil(
    (rollback ? runSeriesRollbackBatch(c.env, session.userId) : runFullSync(c.env, session.userId)).catch((err) => {
      console.error(`Manual sync failed for user ${session.userId}:`, err instanceof Error ? err.message : err);
    }),
  );

  // Plain HTML form submit (the dashboard's "Run sync now" button) gets a
  // redirect back to the logs page; any other caller gets JSON.
  if (c.req.header("Accept")?.includes("text/html")) {
    return c.redirect("/dashboard/logs", 303);
  }
  return c.json({ status: "queued" });
});

// Only the owner can sign in (routes/auth.ts), so requireAuth is the owner check.
api.post("/api/admin/series-rollback", requireAuth, async (c) => {
  await c.env.TOKEN_STORE.put(SERIES_ROLLBACK_KV_KEY, new Date().toISOString());
  return c.json({ status: "rollback started" });
});

api.get("/api/admin/series-rollback", requireAuth, async (c) => {
  const session = c.get("session");
  return c.json({
    active: await isSeriesRollbackActive(c.env),
    remaining: await countSeriesMappingsForUser(c.env.DB, session.userId),
  });
});

export default api;
