-- Phase 7.3 (multi-party meeting planner, see task_plan.md): a poll is a
-- single meeting the owner wants to schedule against a set of candidate
-- slots, with one trusted_invites row per participant (kind='meeting_poll',
-- meeting_poll_id -> this table) reusing Phase 7.1's email-verification
-- machinery unchanged. Voting is keyed off the participant's *verified*
-- email, same "proven control of this inbox, not tied to the original
-- recipient" identity model as the appointment flow (a forwarded poll link
-- verified by a different address still works).
CREATE TABLE IF NOT EXISTS meeting_polls (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    -- Shown to participants so they know what they're voting on — the one
    -- piece of owner-supplied content in this whole feature that *is* shown
    -- to invitees (unlike the appointment flow's generic-placeholder-only
    -- rule, which is about not leaking *invitee*-supplied content onto the
    -- real calendar, not about the owner's own poll subject).
    title TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
    modality TEXT NOT NULL CHECK(modality IN ('in_person', 'remote')),
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'finalized', 'cancelled')),
    -- chosen_slot_id is set in two stages, not one: finalizePoll
    -- (trustedAccess.ts) first atomically *claims* a slot (tryClaimPollSlot:
    -- WHERE status='open' AND chosen_slot_id IS NULL — same compare-and-swap
    -- shape as tryConsumeInvite/tryStartSyncLog) while status is still
    -- 'open', so two concurrent finalize attempts can't both proceed to
    -- write a real Meet room / calendar event for the same poll. Only after
    -- that write succeeds does a second update (finalizeMeetingPollBooking)
    -- set status='finalized' together with booked_start/booked_end/
    -- google_event_id. An accepted, rare failure mode mirrors
    -- confirmAppointmentBooking's own accepted tradeoff: if the Google write
    -- fails after claiming, the poll is left 'open' with chosen_slot_id set
    -- and can't be claimed again — recoverable by hand, not by an
    -- automatic saga/rollback, consistent with this codebase's existing risk
    -- bar. chosen_slot_id is an application-level FK only (same reasoning as
    -- trusted_invites.meeting_poll_id in migration 0005): meeting_poll_slots
    -- is defined below and can't be forward-referenced.
    -- booked_start/booked_end are copied off the winning slot at finalize
    -- time (not re-derived by joining meeting_poll_slots on every read) so
    -- the poll-invite expiry check (isPollLinkExpired, trustedAccess.ts)
    -- needs no join to answer "has this meeting already happened?".
    chosen_slot_id TEXT,
    booked_start TEXT,
    booked_end TEXT,
    google_event_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    CHECK(
        (status = 'finalized' AND chosen_slot_id IS NOT NULL AND booked_start IS NOT NULL AND booked_end IS NOT NULL AND google_event_id IS NOT NULL) OR
        (status != 'finalized' AND booked_start IS NULL AND booked_end IS NULL AND google_event_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_meeting_polls_user ON meeting_polls(user_id);

-- Candidate times the owner proposed at creation time — UTC instants, same
-- "no wall-clock guessing anywhere" convention as the appointment flow's
-- offered slots (computeAvailableSlots, trustedAccess.ts); this codebase has
-- no free/busy-driven candidate generation for polls (out of scope per
-- task_plan.md Phase 7.3 — the owner picks candidates by hand), so start/end
-- are stored directly rather than derived.
CREATE TABLE IF NOT EXISTS meeting_poll_slots (
    id TEXT PRIMARY KEY NOT NULL,
    poll_id TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(poll_id) REFERENCES meeting_polls(id) ON DELETE CASCADE,
    CHECK(end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_meeting_poll_slots_poll ON meeting_poll_slots(poll_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_poll_slots_poll_start ON meeting_poll_slots(poll_id, start_time);

-- One row per (slot, participant): a participant's vote is resubmittable
-- (available now, unavailable later, or vice versa) up until the poll is
-- finalized — see castVote/UPSERT in schema.ts, deliberately not an
-- append-only log, so "does everyone agree on this slot" is always a plain
-- COUNT over current rows, not a most-recent-per-participant scan.
-- participant_email is the *verified* email (post email-verification), not
-- trusted_invites.invitee_email — same identity model as
-- trusted_invites.verified_email.
CREATE TABLE IF NOT EXISTS meeting_poll_votes (
    id TEXT PRIMARY KEY NOT NULL,
    poll_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    participant_email TEXT NOT NULL COLLATE NOCASE,
    available INTEGER NOT NULL CHECK(available IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(poll_id) REFERENCES meeting_polls(id) ON DELETE CASCADE,
    FOREIGN KEY(slot_id) REFERENCES meeting_poll_slots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meeting_poll_votes_poll ON meeting_poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_meeting_poll_votes_slot ON meeting_poll_votes(slot_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_poll_votes_slot_participant ON meeting_poll_votes(slot_id, participant_email);

CREATE TRIGGER IF NOT EXISTS trg_meeting_poll_votes_touch
AFTER UPDATE ON meeting_poll_votes
BEGIN
    UPDATE meeting_poll_votes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
