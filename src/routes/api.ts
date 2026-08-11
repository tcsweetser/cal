import { Hono } from "hono";
import type { AppBindings } from "../types";
import { requireAuth } from "../middleware/auth";
import { runFullSync } from "../services/syncEngine";

const api = new Hono<AppBindings>();

api.post("/api/trigger-sync", requireAuth, async (c) => {
  const session = c.get("session");
  // runFullSync's outer catch rethrows on structural failures (plan.md
  // §5.3) — runScheduledSync (index.ts) already guards against that turning
  // into an unhandled rejection inside waitUntil; this call site needs the
  // same guard.
  c.executionCtx.waitUntil(
    runFullSync(c.env, session.userId).catch((err) => {
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

export default api;
