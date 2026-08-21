import { Hono } from "hono";
import type { AppBindings } from "../types";
import { requireAuth } from "../middleware/auth";
import {
  listAccountsForUser,
  listInvitesForUser,
  getOrCreateSchedulingSettings,
  findUserById,
  type AppointmentModality,
} from "../db/schema";
import { createInvite, sendInviteEmail, allowedAppointmentDurations } from "../services/trustedAccess";
import { InvitesPage } from "../views/invites";
import { toSidebarUser } from "./sidebarUser";

const invites = new Hono<AppBindings>();
invites.use("/dashboard/invites", requireAuth);

// Splits on newlines or commas, trims, lowercases, drops blanks, and
// de-dupes — a pasted list realistically has all three kinds of noise
// (blank trailing lines, someone using commas instead of newlines, the same
// address pasted twice).
function parseEmailList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  );
}

function parseModality(raw: unknown): AppointmentModality | null {
  return raw === "in_person" || raw === "remote" ? raw : null;
}

invites.get("/dashboard/invites", async (c) => {
  const session = c.get("session");
  const [user, accounts, existingInvites, settings] = await Promise.all([
    findUserById(c.env.DB, session.userId),
    listAccountsForUser(c.env.DB, session.userId),
    listInvitesForUser(c.env.DB, session.userId),
    getOrCreateSchedulingSettings(c.env.DB, session.userId),
  ]);
  const sentParam = c.req.query("sent");
  const failedParam = c.req.query("failed");
  return c.html(
    <InvitesPage
      user={toSidebarUser(user!)}
      accounts={accounts}
      invites={existingInvites}
      allowedDurations={allowedAppointmentDurations(settings)}
      remoteAvailable={settings.meet_account_id != null}
      sent={sentParam ? Number(sentParam) : undefined}
      failed={failedParam ? Number(failedParam) : undefined}
    />,
  );
});

// HTML-only per the security model (task_plan.md Phase 7) — this is the one
// place invites get created, so it's requireAuth-gated like every other
// /dashboard/* route, with createInvite itself independently re-checking
// account ownership (and duration/modality against current settings) as a
// second layer (see trustedAccess.ts).
invites.post("/dashboard/invites", async (c) => {
  const session = c.get("session");
  const body = await c.req.parseBody();

  const settings = await getOrCreateSchedulingSettings(c.env.DB, session.userId);
  const allowed = allowedAppointmentDurations(settings);
  const duration = Number(body.durationMinutes);
  if (!allowed.includes(duration)) {
    return c.text(`Invalid appointment length. Must be one of: ${allowed.join(", ")}`, 400);
  }
  const modality = parseModality(body.modality);
  if (!modality) {
    return c.text("Invalid meeting type. Must be 'in_person' or 'remote'.", 400);
  }
  if (modality === "remote" && !settings.meet_account_id) {
    return c.text("Remote appointments aren't available yet — configure a Meet account in Settings first.", 400);
  }
  const accountId = String(body.accountId ?? "");
  const emails = parseEmailList(String(body.emails ?? ""));
  const baseUrl = new URL(c.req.url).origin;

  // Per-email isolation, not all-or-nothing — one bad address (typo,
  // already-invited-too-many-times, etc.) in a pasted batch shouldn't stop
  // the rest from going out, mirroring this codebase's existing per-event
  // isolation in the sync engine.
  let sent = 0;
  let failed = 0;
  for (const email of emails) {
    try {
      const id = await createInvite(c.env, {
        userId: session.userId,
        accountId,
        kind: "appointment",
        inviteeEmail: email,
        durationMinutes: duration,
        modality,
      });
      await sendInviteEmail(c.env, { id, inviteeEmail: email, kind: "appointment" }, baseUrl);
      sent++;
    } catch (err) {
      console.error(`Failed to create/send invite to ${email}:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  return c.redirect(`/dashboard/invites?sent=${sent}&failed=${failed}`, 303);
});

export default invites;
