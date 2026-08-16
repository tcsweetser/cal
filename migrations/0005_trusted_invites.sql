-- Shared infrastructure for TODO.md's two trusted-party features (appointment
-- dialog, multi-party meeting planner — see task_plan.md Phase 7): an
-- unguessable, revocable invite link plus an email-verification step, so an
-- invitee needs no account here but must still prove control of the inbox
-- they're using, even if the link itself was forwarded on to them.
CREATE TABLE IF NOT EXISTS trusted_invites (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('appointment', 'meeting_poll')),
    invitee_email TEXT NOT NULL COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'used', 'expired', 'revoked')),
    -- kind='meeting_poll' only; the poll row itself lands in migration 0006,
    -- once Phase 7.1/7.2 (this table) has shipped and proven out.
    meeting_poll_id TEXT,
    -- kind='appointment' only, set on confirm.
    booked_start TEXT,
    booked_end TEXT,
    google_event_id TEXT,
    -- The email that actually completed verification — may differ from
    -- invitee_email if the link was forwarded; that's allowed, since identity
    -- is proven by verifying this address, not by matching the original one.
    verified_email TEXT COLLATE NOCASE,
    verified_at TEXT,
    used_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    -- meeting_poll_id -> meeting_polls(id) is an application-level FK only:
    -- meeting_polls doesn't exist until migration 0006, and SQLite can't add
    -- a FOREIGN KEY referencing a not-yet-created table.
    CHECK(
        (kind = 'appointment' AND meeting_poll_id IS NULL) OR
        (kind = 'meeting_poll' AND meeting_poll_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_trusted_invites_user ON trusted_invites(user_id);
CREATE INDEX IF NOT EXISTS idx_trusted_invites_poll ON trusted_invites(meeting_poll_id);

-- Short-lived, rate-limited numeric codes proving control of one email
-- address. Deliberately its own table rather than columns on trusted_invites:
-- a code can be requested again (e.g. the first one expired before use)
-- without losing the invite's own state, and code_hash means a leaked D1 row
-- doesn't hand out a live code (same reasoning as never storing OAuth tokens
-- unencrypted, see tokenManager.ts / plan.md §5.2).
CREATE TABLE IF NOT EXISTS email_verifications (
    id TEXT PRIMARY KEY NOT NULL,
    invite_id TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(invite_id) REFERENCES trusted_invites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_invite ON email_verifications(invite_id);
