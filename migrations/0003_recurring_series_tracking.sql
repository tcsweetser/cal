-- Closes the last known sync-window gap (see task_plan.md): an occurrence of
-- a recurring series more than 30 days out is correctly excluded when first
-- seen, but if the series is never edited again, Google's incremental
-- (syncToken) delta never re-reports it — so nothing ever notices when that
-- occurrence rolls into the 30-day window as "now" advances. A long-running
-- unedited recurring meeting would silently stop replicating past its first
-- ~30 days forever.
--
-- Fix: track every recurring series the normal 10-minute sync happens to see
-- (via each instance's recurringEventId field), and once a day (gated by a
-- KV timestamp checked inside the existing cron handler, not a second cron
-- trigger — see index.ts) look ahead just the newly-exposed slice of the
-- window for each tracked series via Google's events.instances() endpoint,
-- which is timeMin/timeMax-bounded natively and has no syncToken involved,
-- so none of the incremental-sync restrictions that caused this apply to it.
CREATE TABLE IF NOT EXISTS tracked_recurring_series (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    recurring_event_id TEXT NOT NULL,
    -- Window end (ISO timestamp) already verified complete for this series —
    -- the daily audit only ever needs to check [covered_through, today+30d],
    -- normally a single day wide, not the whole window every time.
    covered_through TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (account_id, recurring_event_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Daily audit's query pattern: "which tracked series still need extending".
CREATE INDEX IF NOT EXISTS idx_tracked_recurring_series_covered ON tracked_recurring_series(covered_through);
