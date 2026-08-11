import { Hono } from "hono";
import type { AppBindings } from "../types";
import { requireAuth } from "../middleware/auth";
import { listAccountsForUser, listRecentSyncLogs } from "../db/schema";
import { DashboardPage } from "../views/dashboard";
import { MappingsPage } from "../views/mappings";
import { LogsPage } from "../views/logs";

const dashboard = new Hono<AppBindings>();
dashboard.use("/dashboard", requireAuth);
dashboard.use("/dashboard/*", requireAuth);

dashboard.get("/dashboard", async (c) => {
  const session = c.get("session");
  const accounts = await listAccountsForUser(c.env.DB, session.userId);
  return c.html(
    <DashboardPage
      primaryAccount={accounts.find((a) => a.role === "primary") ?? null}
      secondaryAccounts={accounts.filter((a) => a.role === "secondary")}
    />,
  );
});

dashboard.get("/dashboard/mappings", async (c) => {
  const session = c.get("session");
  const accounts = await listAccountsForUser(c.env.DB, session.userId);
  return c.html(<MappingsPage accounts={accounts} />);
});

dashboard.get("/dashboard/logs", async (c) => {
  const session = c.get("session");
  const logs = await listRecentSyncLogs(c.env.DB, session.userId);
  return c.html(<LogsPage logs={logs} />);
});

export default dashboard;
