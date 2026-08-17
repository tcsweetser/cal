import { Hono } from "hono";
import type { AppBindings } from "../types";
import { requireAuth } from "../middleware/auth";
import { listAccountsForUser, getOrCreateSchedulingSettings, updateSchedulingSettings, findAccountForUser } from "../db/schema";
import { SettingsPage } from "../views/settings";

const settings = new Hono<AppBindings>();
settings.use("/dashboard/settings", requireAuth);

function timeStringToMinutes(raw: unknown): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(String(raw ?? ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

settings.get("/dashboard/settings", async (c) => {
  const session = c.get("session");
  const [current, accounts] = await Promise.all([
    getOrCreateSchedulingSettings(c.env.DB, session.userId),
    listAccountsForUser(c.env.DB, session.userId),
  ]);
  return c.html(<SettingsPage settings={current} accounts={accounts} saved={c.req.query("saved") === "1"} />);
});

settings.post("/dashboard/settings", async (c) => {
  const session = c.get("session");
  const body = await c.req.parseBody();

  const [current, accounts] = await Promise.all([
    getOrCreateSchedulingSettings(c.env.DB, session.userId),
    listAccountsForUser(c.env.DB, session.userId),
  ]);

  const minDurationMinutes = Number(body.minDurationMinutes);
  const maxDurationMinutes = Number(body.maxDurationMinutes);
  const durationStepMinutes = Number(body.durationStepMinutes);
  const bufferMinutes = Number(body.bufferMinutes);
  const workdayStartMinutes = timeStringToMinutes(body.workdayStart);
  const workdayEndMinutes = timeStringToMinutes(body.workdayEnd);
  const meetAccountIdRaw = String(body.meetAccountId ?? "");
  const meetAccountId = meetAccountIdRaw === "" ? null : meetAccountIdRaw;

  // Mirrors the CHECK constraints in migration 0006 so a bad submission gets
  // a real error message instead of a bare D1 constraint-violation — the
  // table's own CHECKs remain the actual enforcement point, this is just a
  // friendlier first pass.
  const errors: string[] = [];
  if (!(minDurationMinutes > 0)) errors.push("Minimum duration must be greater than 0.");
  if (!(maxDurationMinutes >= minDurationMinutes)) errors.push("Maximum duration must be at least the minimum.");
  if (!(durationStepMinutes > 0)) errors.push("Step must be greater than 0.");
  if (durationStepMinutes > 0 && (maxDurationMinutes - minDurationMinutes) % durationStepMinutes !== 0) {
    errors.push("Step must evenly divide (maximum − minimum).");
  }
  if (!(bufferMinutes >= 0)) errors.push("Buffer must be zero or greater.");
  if (workdayStartMinutes === null || workdayEndMinutes === null) errors.push("Bookable hours must be valid times.");
  else if (!(workdayEndMinutes > workdayStartMinutes)) errors.push("Bookable hours' end must be after its start.");
  if (meetAccountId) {
    const meetAccount = await findAccountForUser(c.env.DB, session.userId, meetAccountId);
    if (!meetAccount || meetAccount.status !== "active") errors.push("Meet account must be one of your own active accounts.");
  }

  if (errors.length > 0 || workdayStartMinutes === null || workdayEndMinutes === null) {
    return c.html(
      <SettingsPage settings={current} accounts={accounts} error={errors.join(" ")} />,
      errors.length > 0 ? 400 : 200,
    );
  }

  await updateSchedulingSettings(c.env.DB, session.userId, {
    minDurationMinutes,
    maxDurationMinutes,
    durationStepMinutes,
    bufferMinutes,
    workdayStartMinutes,
    workdayEndMinutes,
    meetAccountId,
  });

  return c.redirect("/dashboard/settings?saved=1", 303);
});

export default settings;
