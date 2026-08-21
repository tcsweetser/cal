import { Hono } from "hono";
import type { AppBindings } from "../types";
import { requireAuth } from "../middleware/auth";
import { listAccountsForUser, listRecentSyncLogs, findUserById } from "../db/schema";
import { DashboardPage } from "../views/dashboard";
import { MappingsPage } from "../views/mappings";
import { LogsPage } from "../views/logs";
import { toSidebarUser } from "./sidebarUser";

const dashboard = new Hono<AppBindings>();
dashboard.use("/dashboard", requireAuth);
dashboard.use("/dashboard/*", requireAuth);

dashboard.get("/dashboard", async (c) => {
  const session = c.get("session");
  const [user, accounts] = await Promise.all([
    findUserById(c.env.DB, session.userId),
    listAccountsForUser(c.env.DB, session.userId),
  ]);
  return c.html(
    <DashboardPage
      user={toSidebarUser(user!)}
      primaryAccount={accounts.find((a) => a.role === "primary") ?? null}
      secondaryAccounts={accounts.filter((a) => a.role === "secondary")}
    />,
  );
});

dashboard.get("/dashboard/mappings", async (c) => {
  const session = c.get("session");
  const [user, accounts] = await Promise.all([
    findUserById(c.env.DB, session.userId),
    listAccountsForUser(c.env.DB, session.userId),
  ]);
  return c.html(<MappingsPage user={toSidebarUser(user!)} accounts={accounts} />);
});

dashboard.get("/dashboard/logs", async (c) => {
  const session = c.get("session");
  const [user, logs] = await Promise.all([
    findUserById(c.env.DB, session.userId),
    listRecentSyncLogs(c.env.DB, session.userId),
  ]);
  return c.html(<LogsPage user={toSidebarUser(user!)} logs={logs} />);
});

export default dashboard;
