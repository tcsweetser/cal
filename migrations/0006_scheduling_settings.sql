-- Owner-configurable scheduling policy for the appointment dialog (Phase 7.2,
-- see task_plan.md's "Phase 7.2 requirements revision") — deliberately a real
-- table, not hardcoded constants, so the owner can change these from the
-- dashboard without a redeploy. One row per user (global scope — a single
-- policy for every linked calendar, not per-account; user decision).
CREATE TABLE IF NOT EXISTS scheduling_settings (
    user_id TEXT PRIMARY KEY NOT NULL,
    min_duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK(min_duration_minutes > 0),
    max_duration_minutes INTEGER NOT NULL DEFAULT 90 CHECK(max_duration_minutes >= min_duration_minutes),
    duration_step_minutes INTEGER NOT NULL DEFAULT 15 CHECK(duration_step_minutes > 0),
    -- Minimum gap required between this appointment and any other event on
    -- the target calendar, enforced on both sides (see computeAvailableSlots
    -- / confirmAppointmentBooking, trustedAccess.ts).
    buffer_minutes INTEGER NOT NULL DEFAULT 15 CHECK(buffer_minutes >= 0),
    -- Single daily window (minutes since midnight, e.g. 540/1020 = 9:00 AM-
    -- 5:00 PM), applied every day including weekends, interpreted in the
    -- *target account's* Google Calendar timezone — not UTC, not the
    -- invitee's browser zone (owner's calendar timezone is authoritative;
    -- user decision). Per-day-of-week is a natural later extension, out of
    -- scope for v1.
    workday_start_minutes INTEGER NOT NULL DEFAULT 540 CHECK(workday_start_minutes >= 0 AND workday_start_minutes < 1440),
    workday_end_minutes INTEGER NOT NULL DEFAULT 1020 CHECK(workday_end_minutes > workday_start_minutes AND workday_end_minutes <= 1440),
    -- The one designated account used for every remote appointment's Google
    -- Meet link, regardless of which calendar the appointment itself is
    -- booked on (user decision — not every linked account necessarily has
    -- Meet available). NULL = remote appointments aren't offered yet.
    -- ON DELETE SET NULL, not CASCADE: disconnecting the Meet account should
    -- silently disable remote booking, not take out the owner's whole
    -- scheduling policy.
    meet_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    -- The step must evenly divide the min..max range, otherwise max itself
    -- would never be a reachable duration option.
    CHECK((max_duration_minutes - min_duration_minutes) % duration_step_minutes = 0)
);

CREATE TRIGGER IF NOT EXISTS trg_scheduling_settings_touch
AFTER UPDATE ON scheduling_settings
BEGIN
    UPDATE scheduling_settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = NEW.user_id;
END;
