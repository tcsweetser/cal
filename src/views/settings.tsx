import type { FC } from "hono/jsx";
import type { AccountRow, SchedulingSettingsRow } from "../db/schema";
import { Layout } from "./layout";

function minutesToTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

export const SettingsPage: FC<{ settings: SchedulingSettingsRow; accounts: AccountRow[]; error?: string; saved?: boolean }> = ({
  settings,
  accounts,
  error,
  saved,
}) => {
  const activeAccounts = accounts.filter((a) => a.status === "active");

  return (
    <Layout title="Scheduling settings">
      <h1>Scheduling settings</h1>
      <p>
        These apply to every appointment invite you send (one policy for the whole app, not per calendar). Changing
        them here takes effect immediately for new invites and bookings — no redeploy needed.
      </p>

      {saved && <p>Saved.</p>}
      {error && (
        <p>
          <strong>{error}</strong>
        </p>
      )}

      <form method="post" action="/dashboard/settings">
        <section>
          <h2>Appointment length</h2>
          <p>
            <label>
              Minimum (minutes):{" "}
              <input type="number" name="minDurationMinutes" min={5} step={5} value={settings.min_duration_minutes} required />
            </label>
          </p>
          <p>
            <label>
              Maximum (minutes):{" "}
              <input type="number" name="maxDurationMinutes" min={5} step={5} value={settings.max_duration_minutes} required />
            </label>
          </p>
          <p>
            <label>
              Step between offered lengths (minutes):{" "}
              <input type="number" name="durationStepMinutes" min={5} step={5} value={settings.duration_step_minutes} required />
            </label>{" "}
            <span class="empty">must evenly divide (max − min)</span>
          </p>
        </section>

        <section>
          <h2>Spacing</h2>
          <p>
            <label>
              Buffer required between meetings (minutes):{" "}
              <input type="number" name="bufferMinutes" min={0} step={5} value={settings.buffer_minutes} required />
            </label>
          </p>
        </section>

        <section>
          <h2>Bookable hours</h2>
          <p>
            Applied every day, including weekends, in the target calendar's own timezone — e.g. an invite booking on
            a calendar set to <code>America/New_York</code> only offers slots within this window in New York time,
            regardless of the invitee's own timezone.
          </p>
          <p>
            <label>
              From:{" "}
              <input type="time" name="workdayStart" value={minutesToTimeString(settings.workday_start_minutes)} required />
            </label>{" "}
            <label>
              To: <input type="time" name="workdayEnd" value={minutesToTimeString(settings.workday_end_minutes)} required />
            </label>
          </p>
        </section>

        <section>
          <h2>Remote meetings</h2>
          <p>
            The one account used to generate a Google Meet link for every remote appointment, regardless of which
            calendar the appointment itself is booked on. Leave unset to disable remote appointments.
          </p>
          <p>
            <label>
              Meet account:{" "}
              <select name="meetAccountId">
                <option value="">— none (remote disabled) —</option>
                {activeAccounts.map((account) => (
                  <option value={account.id} selected={account.id === settings.meet_account_id}>
                    {account.email} ({account.role === "primary" ? "primary" : account.tag})
                  </option>
                ))}
              </select>
            </label>
          </p>
        </section>

        <button type="submit">Save</button>
      </form>
    </Layout>
  );
};
