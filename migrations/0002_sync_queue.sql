-- Staged/incremental sync support (see task_plan.md): the Workers Free plan
-- caps external subrequests at 50 per invocation, and a full backlog of
-- events for even a modest calendar can need far more than that once you
-- count one Calendar API write per (event, target account) pair. Rather than
-- doing all replication in one invocation, fetched-but-not-yet-replicated
-- events are queued here and drained a budget-limited batch at a time across
-- as many cron ticks as needed — nothing already-replicated is ever re-sent,
-- and Google's syncToken only advances once the whole batch this queue came
-- from is fully drained (see pending_sync_token below).
CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- One queued copy per (account, source event): a second fetch landing before
-- the first is drained (shouldn't happen — see the "queue non-empty, skip
-- fetching" guard — but defence in depth) replaces rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_queue_account_event ON sync_queue(account_id, event_id);

-- FIFO draining, oldest-enqueued first, scoped to one account.
CREATE INDEX IF NOT EXISTS idx_sync_queue_account_created ON sync_queue(account_id, created_at);

-- The syncToken a completed fetch would advance to, held here until the
-- queue rows it produced are fully drained (see promotePendingSyncToken in
-- schema.ts) — advancing sync_tokens.sync_token immediately would mean a
-- budget-limited partial run permanently loses whatever it didn't get to
-- this invocation. A separate table rather than a nullable column on
-- sync_tokens: sync_tokens.sync_token is NOT NULL and there's no existing
-- row to attach a pending value to on a first-ever (no prior token) sync.
CREATE TABLE IF NOT EXISTS pending_sync_tokens (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL DEFAULT 'primary',
    sync_token TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, account_id, calendar_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
