-- Replicate a recurring series as one series on each target calendar, instead
-- of one event per expanded instance. A source series maps to one target
-- series per target account; per-instance changes (exceptions) are tracked
-- by their original start time under the series mapping.
CREATE TABLE IF NOT EXISTS series_mappings (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    source_account_id TEXT NOT NULL,
    source_series_id TEXT NOT NULL,
    target_account_id TEXT NOT NULL,
    target_series_id TEXT NOT NULL,
    -- Hash of the replicated fields; an unchanged series costs no Google write.
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(source_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- One mapping per (source series, target account); also serves lookups by the
-- (source_account_id, source_series_id) prefix.
CREATE UNIQUE INDEX IF NOT EXISTS idx_series_mappings_source_target
    ON series_mappings(source_account_id, source_series_id, target_account_id);

-- "Is this event on the target calendar one of our replica series?"
CREATE INDEX IF NOT EXISTS idx_series_mappings_target
    ON series_mappings(target_account_id, target_series_id);

CREATE INDEX IF NOT EXISTS idx_series_mappings_user ON series_mappings(user_id);

-- Fingerprint of each replicated exception, keyed by the instance's original
-- start time, so an unchanged exception is not written again.
CREATE TABLE IF NOT EXISTS exception_mappings (
    series_mapping_id TEXT NOT NULL REFERENCES series_mappings(id) ON DELETE CASCADE,
    original_start TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (series_mapping_id, original_start)
);

-- Per-account cutover from instance replication to series replication.
-- reset_at: the account's sync position was cleared and its old instance
-- mappings were queued for cleanup. completed_at: the first series-based
-- full sync finished.
CREATE TABLE IF NOT EXISTS series_cutover (
    account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    reset_at TEXT,
    completed_at TEXT
);

-- Old per-instance replicas still to be deleted from target calendars. Filled
-- per account by the cutover reset, not by this migration. instance_date is
-- YYYYMMDD. Deleting the event_mappings row removes its cleanup row.
CREATE TABLE IF NOT EXISTS legacy_instance_cleanup (
    mapping_id TEXT PRIMARY KEY NOT NULL REFERENCES event_mappings(id) ON DELETE CASCADE,
    source_account_id TEXT NOT NULL,
    source_series_id TEXT NOT NULL,
    target_account_id TEXT NOT NULL,
    target_event_id TEXT NOT NULL,
    instance_date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_legacy_cleanup_source_date
    ON legacy_instance_cleanup(source_account_id, instance_date);
