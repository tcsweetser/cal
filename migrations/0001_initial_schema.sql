CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK(role IN ('primary', 'secondary')),
    tag TEXT CHECK(tag IN ('business', 'side_hustle', 'personal')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'error')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK(
        (role = 'primary' AND tag IS NULL) OR
        (role = 'secondary' AND tag IS NOT NULL)
    )
);
-- "At least one secondary account per user" and "exactly one primary account per user"
-- are cross-row invariants SQLite CHECK constraints cannot express — enforce at the
-- application layer (dashboard onboarding + API validation before allowing sync to run).

-- One Google account linked at most once per user (COLLATE NOCASE: Google emails are
-- effectively case-insensitive). Also serves lookups by user_id alone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_email ON accounts(user_id, email);

CREATE TABLE IF NOT EXISTS sync_tokens (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL DEFAULT 'primary',
    sync_token TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, account_id, calendar_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_tokens_account ON sync_tokens(account_id);

CREATE TRIGGER IF NOT EXISTS trg_sync_tokens_touch
AFTER UPDATE ON sync_tokens
BEGIN
    UPDATE sync_tokens
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = NEW.user_id AND account_id = NEW.account_id AND calendar_id = NEW.calendar_id;
END;

CREATE TABLE IF NOT EXISTS event_mappings (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    source_account_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    target_account_id TEXT NOT NULL,
    target_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(source_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(target_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    CHECK(source_account_id <> target_account_id)
);

-- One mapping per (source event, target account) pair: enforces the dedup the sync
-- engine relies on (plan.md §5.3 step 5: PATCH if a row already exists for this triple,
-- POST otherwise) and backs both that lookup and the deletion-cascade lookup in step 4,
-- which filters on the (source_account_id, source_event_id) prefix alone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_mappings_source_target
    ON event_mappings(source_account_id, source_event_id, target_account_id);

-- One mapping per replica: a target_event_id can be owned by exactly one source event,
-- otherwise two source events could race to "own" (and independently delete) the same
-- replica, orphaning whichever mapping row loses. Also backs lookup by target event
-- (e.g. reconciling a replica found directly on a target calendar).
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_mappings_target
    ON event_mappings(target_account_id, target_event_id);

CREATE INDEX IF NOT EXISTS idx_event_mappings_user ON event_mappings(user_id);

CREATE TRIGGER IF NOT EXISTS trg_event_mappings_touch
AFTER UPDATE ON event_mappings
BEGIN
    UPDATE event_mappings
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS sync_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('success', 'error', 'in_progress')),
    message TEXT,
    events_processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_user_time ON sync_logs(user_id, created_at DESC);
