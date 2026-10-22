import { Hono } from "hono";
import type { AppBindings, Env } from "./types";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import apiRoutes from "./routes/api";
import publicRoutes from "./routes/public";
import invitesRoutes from "./routes/invites";
import bookingRoutes from "./routes/booking";
import settingsRoutes from "./routes/settings";
import meetingPollsRoutes from "./routes/meetingPolls";
import pollVotingRoutes from "./routes/pollVoting";
import { ensureSyncScheduler } from "./services/syncScheduler";

// The Durable Object class must be exported from the Worker's main module.
export { SyncScheduler } from "./services/syncScheduler";

const app = new Hono<AppBindings>();

app.get("/", (c) => c.redirect("/dashboard"));
app.route("/", authRoutes);
app.route("/", dashboardRoutes);
app.route("/", apiRoutes);
app.route("/", publicRoutes);
app.route("/", invitesRoutes);
app.route("/", bookingRoutes);
app.route("/", settingsRoutes);
app.route("/", meetingPollsRoutes);
app.route("/", pollVotingRoutes);

// Without this, an uncaught error is Hono's bare default 500 with nothing
// logged — with `observability` enabled (wrangler.jsonc), a console.error
// here is the difference between a debuggable production incident and not.
app.onError((err, c) => {
  console.error(`Unhandled error on ${c.req.method} ${c.req.path}:`, err);
  return c.text("Internal Server Error", 500);
});

// Once per isolate, make sure the scheduler's alarm exists. This is what
// starts the 10-minute cadence after the first deploy, and restarts it if the
// alarm is ever lost. ctx is absent only when tests call worker.fetch(req, env)
// directly.
let alarmChecked = false;

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContext) {
    if (!alarmChecked && ctx) {
      alarmChecked = true;
      ctx.waitUntil(
        ensureSyncScheduler(env).catch((err) => {
          alarmChecked = false; // let the next request in this isolate retry
          console.error("Sync scheduler ensure failed:", err instanceof Error ? err.message : err);
        }),
      );
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
