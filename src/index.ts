import { Hono } from "hono";
import type { AppBindings, Env } from "./types";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import apiRoutes from "./routes/api";
import publicRoutes from "./routes/public";
import invitesRoutes from "./routes/invites";
import bookingRoutes from "./routes/booking";
import settingsRoutes from "./routes/settings";
import { listUserIds } from "./db/schema";
import { runFullSync, runDailyRecurringAudit } from "./services/syncEngine";

// KV key gating the once-a-day recurring-series audit (see syncEngine.ts's
// runDailyRecurringAudit) — deliberately not a second Cron Trigger, since
// Cloudflare accounts have a small fixed budget of those. Piggybacks on the
// existing 10-minute trigger instead: whichever tick is the first to land
// after this key's date falls behind today's (UTC) date runs the audit once,
// then updates the key so the rest of the day's ticks skip it.
const DAILY_AUDIT_KV_KEY = "daily-recurring-audit:last-run-date";

const app = new Hono<AppBindings>();

app.get("/", (c) => c.redirect("/dashboard"));
app.route("/", authRoutes);
app.route("/", dashboardRoutes);
app.route("/", apiRoutes);
app.route("/", publicRoutes);
app.route("/", invitesRoutes);
app.route("/", bookingRoutes);
app.route("/", settingsRoutes);

// Without this, an uncaught error is Hono's bare default 500 with nothing
// logged — with `observability` enabled (wrangler.jsonc), a console.error
// here is the difference between a debuggable production incident and not.
app.onError((err, c) => {
  console.error(`Unhandled error on ${c.req.method} ${c.req.path}:`, err);
  return c.text("Internal Server Error", 500);
});

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

// Runs at most once per UTC calendar day, piggybacked on whichever 10-minute
// tick happens to be first after midnight — see DAILY_AUDIT_KV_KEY above for
// why this isn't its own Cron Trigger. The KV write happens before the audit
// runs, not after: if the audit itself fails partway, it shouldn't retry
// every 10 minutes for the rest of the day (each tracked series already
// tolerates a stale covered_through and just retries on the next real daily
// run — see runDailyRecurringAudit).
async function maybeRunDailyAudit(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const lastRun = await env.TOKEN_STORE.get(DAILY_AUDIT_KV_KEY);
  if (lastRun === today) return;
  await env.TOKEN_STORE.put(DAILY_AUDIT_KV_KEY, today);
  try {
    await runDailyRecurringAudit(env);
  } catch (err) {
    console.error("Daily recurring audit failed:", err instanceof Error ? err.message : err);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await runScheduledSync(env);
        await maybeRunDailyAudit(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
