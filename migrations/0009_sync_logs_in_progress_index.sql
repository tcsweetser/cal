-- The sync lock checks (tryStartSyncLog, findActiveSyncLog) run on every
-- 10-minute tick and filter on status = 'in_progress'. With only
-- idx_sync_logs_user_time, SQLite walked the user's whole sync_logs history
-- checking status row by row, and since no run is normally in progress, LIMIT 1
-- never stopped it early: 3.6M rows_read/day by Nov 2026, against the account's
-- 5M/day limit. This index holds only in-progress rows, at most one per user,
-- however large sync_logs gets.
--
-- Keep 'in_progress' as a literal in those queries: the planner can then match
-- this index at prepare time rather than depending on a re-prepare after binding.
CREATE INDEX IF NOT EXISTS idx_sync_logs_in_progress
  ON sync_logs(user_id, created_at DESC) WHERE status = 'in_progress';
