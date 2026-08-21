import type { FC } from "hono/jsx";
import type { AccountRow, SchedulingSettingsRow } from "../db/schema";
import { Layout, type SidebarUser } from "./layout";

function minutesToTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

export const SettingsPage: FC<{
  user: SidebarUser;
  settings: SchedulingSettingsRow;
  accounts: AccountRow[];
  error?: string;
  saved?: boolean;
}> = ({ user, settings, accounts, error, saved }) => {
  const activeAccounts = accounts.filter((a) => a.status === "active");

  return (
    <Layout title="Scheduling settings" active="settings" user={user}>
      <h1>Scheduling settings</h1>
      <p class="lede">
        These apply to every appointment invite you send (one policy for the whole app, not per calendar). Changing
        them here takes effect immediately for new invites and bookings — no redeploy needed.
      </p>

      {saved && <p>Saved.</p>}
      {error && (
        <p class="error">
          <strong>{error}</strong>
        </p>
      )}

      <form class="card stack" method="post" action="/dashboard/settings">
        <section style="margin-bottom: 0;">
          <h2>Appointment length</h2>
          <div class="row">
            <label>
              Minimum (min)
              <input
                type="number"
                name="minDurationMinutes"
                min={5}
                step={5}
                value={settings.min_duration_minutes}
                style="width: 6.5rem;"
                required
              />
            </label>
            <label>
              Maximum (min)
              <input
                type="number"
                name="maxDurationMinutes"
                min={5}
                step={5}
                value={settings.max_duration_minutes}
                style="width: 6.5rem;"
                required
              />
            </label>
            <label>
              Step (min)
              <input
                type="number"
                name="durationStepMinutes"
                min={5}
                step={5}
                value={settings.duration_step_minutes}
                style="width: 6.5rem;"
                required
              />
            </label>
          </div>
          <p class="hint" style="margin-bottom: 0;">
            Step must evenly divide (max − min).
          </p>
        </section>

        <section style="margin-bottom: 0;">
          <h2>Spacing</h2>
          <label style="max-width: 14rem;">
            Buffer between meetings (min)
            <input type="number" name="bufferMinutes" min={0} step={5} value={settings.buffer_minutes} required />
          </label>
        </section>

        <section style="margin-bottom: 0;">
          <h2>Bookable hours</h2>
          <p class="hint" style="margin: 0 0 0.75rem;">
            Applied every day, in the target calendar's own timezone.
          </p>
          <div class="row">
            <label>
              From
              <input type="time" name="workdayStart" value={minutesToTimeString(settings.workday_start_minutes)} required />
            </label>
            <label>
              To
              <input type="time" name="workdayEnd" value={minutesToTimeString(settings.workday_end_minutes)} required />
            </label>
          </div>
        </section>

        <section style="margin-bottom: 0;">
          <h2>Remote meetings</h2>
          <label style="max-width: 22rem;">
            Meet account
            <select name="meetAccountId">
              <option value="">— none (remote disabled) —</option>
              {activeAccounts.map((account) => (
                <option value={account.id} selected={account.id === settings.meet_account_id}>
                  {account.email} ({account.role === "primary" ? "primary" : account.tag})
                </option>
              ))}
            </select>
          </label>
        </section>

        <div>
          <button class="btn-primary" type="submit">
            Save
          </button>
        </div>
      </form>
    </Layout>
  );
};
