import { Hono } from "hono";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ name: "cf-cal-replication", status: "skeleton" }));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Sync engine wiring lands in Phase 4 (plan.md §5.3).
    console.log("scheduled trigger fired");
  },
} satisfies ExportedHandler<Env>;
