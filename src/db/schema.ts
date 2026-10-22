// D1 query helpers — only what Phases 3 (auth) and 4 (sync engine) actually
// call. Extend as later phases need more (dashboard), not speculatively now.

export type AccountRole = "primary" | "secondary";
export type AccountTag = "business" | "side_hustle" | "personal";
export type AccountStatus = "active" | "revoked" | "error";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  picture_url: string | null;
  created_at: string;
}

export interface AccountRow {
  id: string;
  user_id: string;
  email: string;
  role: AccountRole;
  tag: AccountTag | null;
  status: AccountStatus;
  created_at: string;
}

export function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function createUser(db: D1Database, id: string, email: string): Promise<void> {
  await db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind(id, email).run();
}

// Re-run on every login (not just first), so a changed Google display
// name/photo is picked up here too — see migrations/0008_user_profile.sql.
export async function updateUserProfile(
  db: D1Database,
  id: string,
  profile: { name: string | null; picture_url: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE users SET name = ?, picture_url = ? WHERE id = ?")
    .bind(profile.name, profile.picture_url, id)
    .run();
}

export function findAccountByUserAndEmail(
  db: D1Database,
  userId: string,
  email: string,
): Promise<AccountRow | null> {
  return db
    .prepare("SELECT * FROM accounts WHERE user_id = ? AND email = ?")
    .bind(userId, email)
    .first<AccountRow>();
}

// Scoped by both id and user_id in one query, rather than fetching by id
// alone and comparing user_id in application code — the query itself can
// only ever answer "yes, this account belongs to this user," so a caller
// can't accidentally skip the ownership check by only looking at part of
// the result (see trustedAccess.ts's createInvite for why this matters:
// task_plan.md Phase 7's security model).
export function findAccountForUser(db: D1Database, userId: string, accountId: string): Promise<AccountRow | null> {
  return db
    .prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, userId)
    .first<AccountRow>();
}

export function findPrimaryAccountForUser(db: D1Database, userId: string): Promise<AccountRow | null> {
  return db
    .prepare("SELECT * FROM accounts WHERE user_id = ? AND role = 'primary'")
    .bind(userId)
    .first<AccountRow>();
}

export interface CreateAccountInput {
  id: string;
  userId: string;
  email: string;
  role: AccountRole;
  tag: AccountTag | null;
}

export async function createAccount(db: D1Database, input: CreateAccountInput): Promise<void> {
  await db
    .prepare("INSERT INTO accounts (id, user_id, email, role, tag) VALUES (?, ?, ?, ?, ?)")
    .bind(input.id, input.userId, input.email, input.role, input.tag)
    .run();
}

export async function markAccountStatus(db: D1Database, accountId: string, status: AccountStatus): Promise<void> {
  await db.prepare("UPDATE accounts SET status = ? WHERE id = ?").bind(status, accountId).run();
}

// --- Sync engine (Phase 4) ---

export async function listUserIds(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT id FROM users").all<{ id: string }>();
  return results.map((row) => row.id);
}

export async function listActiveAccountsForUser(db: D1Database, userId: string): Promise<AccountRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM accounts WHERE user_id = ? AND status = 'active'")
    .bind(userId)
    .all<AccountRow>();
  return results;
}

export function getSyncToken(
  db: D1Database,
  userId: string,
  accountId: string,
  calendarId = "primary",
): Promise<string | null> {
  return db
    .prepare("SELECT sync_token FROM sync_tokens WHERE user_id = ? AND account_id = ? AND calendar_id = ?")
    .bind(userId, accountId, calendarId)
    .first<{ sync_token: string }>()
    .then((row) => row?.sync_token ?? null);
}

export async function setSyncToken(
  db: D1Database,
  userId: string,
  accountId: string,
  token: string,
  calendarId = "primary",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_tokens (user_id, account_id, calendar_id, sync_token) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, account_id, calendar_id) DO UPDATE SET sync_token = excluded.sync_token`,
    )
    .bind(userId, accountId, calendarId, token)
    .run();
}

export async function clearSyncToken(
  db: D1Database,
  userId: string,
  accountId: string,
  calendarId = "primary",
): Promise<void> {
  await db
    .prepare("DELETE FROM sync_tokens WHERE user_id = ? AND account_id = ? AND calendar_id = ?")
    .bind(userId, accountId, calendarId)
    .run();
}

export interface EventMappingRow {
  id: string;
  user_id: string;
  source_account_id: string;
  source_event_id: string;
  target_account_id: string;
  target_event_id: string;
  created_at: string;
  updated_at: string;
}

export async function findEventMappingsBySource(
  db: D1Database,
  sourceAccountId: string,
  sourceEventId: string,
): Promise<EventMappingRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM event_mappings WHERE source_account_id = ? AND source_event_id = ?")
    .bind(sourceAccountId, sourceEventId)
    .all<EventMappingRow>();
  return results;
}

// Used only for 410-recovery reconciliation (syncEngine.ts) — every mapping
// sourced from one account, regardless of which event, so each can be
// existence-checked against Google after a forced full re-sync.
export async function findEventMappingsBySourceAccount(
  db: D1Database,
  sourceAccountId: string,
): Promise<EventMappingRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM event_mappings WHERE source_account_id = ?")
    .bind(sourceAccountId)
    .all<EventMappingRow>();
  return results;
}

export function findEventMapping(
  db: D1Database,
  sourceAccountId: string,
  sourceEventId: string,
  targetAccountId: string,
): Promise<EventMappingRow | null> {
  return db
    .prepare(
      "SELECT * FROM event_mappings WHERE source_account_id = ? AND source_event_id = ? AND target_account_id = ?",
    )
    .bind(sourceAccountId, sourceEventId, targetAccountId)
    .first<EventMappingRow>();
}

export interface CreateEventMappingInput {
  id: string;
  userId: string;
  sourceAccountId: string;
  sourceEventId: string;
  targetAccountId: string;
  targetEventId: string;
}

export async function createEventMapping(db: D1Database, input: CreateEventMappingInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event_mappings
       (id, user_id, source_account_id, source_event_id, target_account_id, target_event_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.sourceAccountId,
      input.sourceEventId,
      input.targetAccountId,
      input.targetEventId,
    )
    .run();
}

export async function deleteEventMapping(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM event_mappings WHERE id = ?").bind(id).run();
}

// --- Sync queue (staged/incremental sync, see task_plan.md) ---

export interface SyncQueueItemRow {
  id: string;
  user_id: string;
  account_id: string;
  event_id: string;
  event_json: string;
  created_at: string;
}

// REPLACE not IGNORE: if the same event is somehow enqueued twice (shouldn't
// happen given syncAccount only fetches when the queue is empty, but a
// second copy would mean stale event data if left as INSERT OR IGNORE).
export async function enqueueEvents(
  db: D1Database,
  userId: string,
  accountId: string,
  events: Array<{ id: string; json: string }>,
): Promise<void> {
  if (events.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO sync_queue (id, user_id, account_id, event_id, event_json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, event_id) DO UPDATE SET event_json = excluded.event_json`,
  );
  await db.batch(events.map((e) => stmt.bind(crypto.randomUUID(), userId, accountId, e.id, e.json)));
}

export async function countQueuedEvents(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// FIFO: oldest-enqueued first, so a large backlog drains roughly in the
// order Google originally returned it rather than an arbitrary order.
export async function dequeuePendingEvents(
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<SyncQueueItemRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM sync_queue WHERE account_id = ? ORDER BY created_at ASC LIMIT ?")
    .bind(accountId, limit)
    .all<SyncQueueItemRow>();
  return results;
}

export async function deleteQueuedEvent(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM sync_queue WHERE id = ?").bind(id).run();
}

// Held separately from sync_tokens until the queue a fetch produced is fully
// drained — see the pending_sync_tokens table comment in the migration for why.
export async function setPendingSyncToken(
  db: D1Database,
  userId: string,
  accountId: string,
  token: string,
  calendarId = "primary",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_sync_tokens (user_id, account_id, calendar_id, sync_token) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, account_id, calendar_id) DO UPDATE SET sync_token = excluded.sync_token`,
    )
    .bind(userId, accountId, calendarId, token)
    .run();
}

// Once the queue for this account is empty, promotes the pending token (the
// one the fetch that produced that queue would have advanced to) into the
// real sync_tokens row, and clears the pending one. A no-op, not an error,
// if there's nothing pending (e.g. an incremental sync whose delta was empty
// enough to finish inline without ever touching the queue).
export async function promotePendingSyncToken(
  db: D1Database,
  userId: string,
  accountId: string,
  calendarId = "primary",
): Promise<void> {
  const pending = await db
    .prepare("SELECT sync_token FROM pending_sync_tokens WHERE user_id = ? AND account_id = ? AND calendar_id = ?")
    .bind(userId, accountId, calendarId)
    .first<{ sync_token: string }>();
  if (!pending) return;
  await setSyncToken(db, userId, accountId, pending.sync_token, calendarId);
  await db
    .prepare("DELETE FROM pending_sync_tokens WHERE user_id = ? AND account_id = ? AND calendar_id = ?")
    .bind(userId, accountId, calendarId)
    .run();
}

// --- Recurring series tracking (daily window-gap audit, see task_plan.md) ---

export interface TrackedRecurringSeriesRow {
  user_id: string;
  account_id: string;
  recurring_event_id: string;
  covered_through: string;
  created_at: string;
}

// Only records the FIRST time a series is seen — covered_through is meant to
// advance solely via advanceCoveredThrough (the daily audit), never here, so
// this deliberately does nothing on conflict rather than overwriting it.
export async function trackRecurringSeriesIfNew(
  db: D1Database,
  userId: string,
  accountId: string,
  recurringEventId: string,
  coveredThrough: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tracked_recurring_series (user_id, account_id, recurring_event_id, covered_through)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, recurring_event_id) DO NOTHING`,
    )
    .bind(userId, accountId, recurringEventId, coveredThrough)
    .run();
}

export async function listRecurringSeriesNeedingAudit(
  db: D1Database,
  windowEndIso: string,
): Promise<TrackedRecurringSeriesRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM tracked_recurring_series WHERE covered_through < ?")
    .bind(windowEndIso)
    .all<TrackedRecurringSeriesRow>();
  return results;
}

export async function advanceCoveredThrough(
  db: D1Database,
  accountId: string,
  recurringEventId: string,
  newCoveredThrough: string,
): Promise<void> {
  await db
    .prepare("UPDATE tracked_recurring_series SET covered_through = ? WHERE account_id = ? AND recurring_event_id = ?")
    .bind(newCoveredThrough, accountId, recurringEventId)
    .run();
}

export type SyncLogStatus = "in_progress" | "success" | "error";

export interface SyncLogRow {
  id: string;
  user_id: string;
  status: SyncLogStatus;
  message: string | null;
  events_processed: number;
  created_at: string;
}

// Atomic compare-and-insert: returns false if another run's in_progress row
// already exists (a manual trigger racing a scheduled tick, or vice versa), rather
// than the caller doing a separate SELECT-then-INSERT that both racers could
// pass. Genuinely-stale lock recovery (see runFullSync) still needs its own
// read first — that narrower window is accepted, see plan.md §5.3.
export async function tryStartSyncLog(db: D1Database, id: string, userId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO sync_logs (id, user_id, status)
       SELECT ?, ?, 'in_progress'
       WHERE NOT EXISTS (SELECT 1 FROM sync_logs WHERE user_id = ? AND status = 'in_progress')`,
    )
    .bind(id, userId, userId)
    .run();
  return result.meta.changes === 1;
}

export async function completeSyncLog(
  db: D1Database,
  id: string,
  status: "success" | "error",
  message: string | null,
  eventsProcessed: number,
): Promise<void> {
  await db
    .prepare("UPDATE sync_logs SET status = ?, message = ?, events_processed = ? WHERE id = ?")
    .bind(status, message, eventsProcessed, id)
    .run();
}

export function findActiveSyncLog(db: D1Database, userId: string): Promise<SyncLogRow | null> {
  return db
    .prepare("SELECT * FROM sync_logs WHERE user_id = ? AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1")
    .bind(userId)
    .first<SyncLogRow>();
}

// --- Dashboard (Phase 5) ---

// Unlike listActiveAccountsForUser (sync engine, active-only), the dashboard
// shows every linked account regardless of status so a revoked/errored
// account doesn't just silently vanish from view.
export async function listAccountsForUser(db: D1Database, userId: string): Promise<AccountRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY role ASC, created_at ASC")
    .bind(userId)
    .all<AccountRow>();
  return results;
}

export async function listRecentSyncLogs(db: D1Database, userId: string, limit = 20): Promise<SyncLogRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM sync_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(userId, limit)
    .all<SyncLogRow>();
  return results;
}

// --- Trusted invites (Phase 7: appointment dialog + meeting planner, see task_plan.md) ---

export type TrustedInviteKind = "appointment" | "meeting_poll";
export type TrustedInviteStatus = "pending" | "verified" | "used" | "expired" | "revoked";
export type AppointmentModality = "in_person" | "remote";

export interface TrustedInviteRow {
  id: string;
  user_id: string;
  account_id: string;
  kind: TrustedInviteKind;
  invitee_email: string;
  status: TrustedInviteStatus;
  meeting_poll_id: string | null;
  duration_minutes: number | null;
  modality: AppointmentModality | null;
  booked_start: string | null;
  booked_end: string | null;
  google_event_id: string | null;
  verified_email: string | null;
  verified_at: string | null;
  used_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface CreateTrustedInviteInput {
  id: string;
  userId: string;
  accountId: string;
  kind: TrustedInviteKind;
  inviteeEmail: string;
  meetingPollId: string | null;
  durationMinutes: number | null;
  modality: AppointmentModality | null;
  expiresAt: string;
}

export async function createTrustedInvite(db: D1Database, input: CreateTrustedInviteInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trusted_invites (id, user_id, account_id, kind, invitee_email, meeting_poll_id, duration_minutes, modality, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.accountId,
      input.kind,
      input.inviteeEmail,
      input.meetingPollId,
      input.durationMinutes,
      input.modality,
      input.expiresAt,
    )
    .run();
}

export function findTrustedInvite(db: D1Database, id: string): Promise<TrustedInviteRow | null> {
  return db.prepare("SELECT * FROM trusted_invites WHERE id = ?").bind(id).first<TrustedInviteRow>();
}

export async function listInvitesForUser(db: D1Database, userId: string): Promise<TrustedInviteRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM trusted_invites WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<TrustedInviteRow>();
  return results;
}

// Only transitions a 'pending', not-yet-expired invite. Returns whether it
// actually did, same compare-and-swap shape as tryConsumeInvite below — the
// caller (trustedAccess.ts) checks this rather than assuming success, after
// an earlier version silently no-op'd against an already-used/revoked invite
// while still reporting "verified" to the caller (state drift, caught in
// this project's post-commit security review, see task_plan.md Phase 7.1).
// The `expires_at` check was added slightly later in that same review's
// follow-up (Phase 7.2): without it, an invite past its TTL but still
// sitting in 'pending' status (expiry here is lazy/read-time, not a
// background job — see isInviteExpired) could still be verified.
export async function markInviteVerified(db: D1Database, id: string, verifiedEmail: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE trusted_invites
       SET status = 'verified', verified_email = ?, verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(verifiedEmail, id)
    .run();
  return result.meta.changes === 1;
}

// Atomic compare-and-swap, same pattern as tryStartSyncLog above: only
// succeeds if the invite is currently 'verified' and not past its expiry
// (same lazy-expiry gap as markInviteVerified above, closed the same way),
// closing the race where the same link is submitted twice at once (e.g. a
// double form submit, or two browser tabs). Returns false for anything else
// (already used, expired, revoked, or never verified) — the caller treats
// all of those as "can't book".
export async function tryConsumeInvite(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE trusted_invites SET status = 'used', used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'verified' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(id)
    .run();
  return result.meta.changes === 1;
}

export async function recordAppointmentBooking(
  db: D1Database,
  id: string,
  bookedStart: string,
  bookedEnd: string,
  googleEventId: string,
): Promise<void> {
  await db
    .prepare("UPDATE trusted_invites SET booked_start = ?, booked_end = ?, google_event_id = ? WHERE id = ?")
    .bind(bookedStart, bookedEnd, googleEventId, id)
    .run();
}

export interface EmailVerificationRow {
  id: string;
  invite_id: string;
  email: string;
  code_hash: string;
  attempts: number;
  sends: number;
  expires_at: string;
  created_at: string;
}

export interface UpsertEmailVerificationInput {
  id: string;
  inviteId: string;
  email: string;
  codeHash: string;
  expiresAt: string;
}

// UPSERT, not INSERT: at most one row per (invite_id, email) — see the
// unique index added to migration 0005 and its comment for why. Deliberately
// leaves `attempts` untouched on conflict (no `attempts = 0` in the DO
// UPDATE) — a resend must not reset the lockout counter, only the
// code/expiry, otherwise the 5-attempt cap becomes bypassable by just
// requesting a new code (the actual bug this fixes). `sends` is incremented
// on every call (initial INSERT starts at 1, not 0) — a second, independent
// lifetime cap (MAX_VERIFICATION_SENDS_PER_TARGET, trustedAccess.ts) on top
// of the per-resend cooldown, since the cooldown alone never actually
// terminates (see migration 0005's comment on this table).
export async function upsertEmailVerification(db: D1Database, input: UpsertEmailVerificationInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_verifications (id, invite_id, email, code_hash, expires_at, sends)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(invite_id, email) DO UPDATE SET
         code_hash = excluded.code_hash,
         expires_at = excluded.expires_at,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         sends = sends + 1`,
    )
    .bind(input.id, input.inviteId, input.email, input.codeHash, input.expiresAt)
    .run();
}

// At most one row per (invite, email) now (see the unique index above), so
// this is "the" verification for the pair, not "the latest of several".
export function findEmailVerification(
  db: D1Database,
  inviteId: string,
  email: string,
): Promise<EmailVerificationRow | null> {
  return db
    .prepare("SELECT * FROM email_verifications WHERE invite_id = ? AND email = ?")
    .bind(inviteId, email)
    .first<EmailVerificationRow>();
}

// How many distinct email addresses have ever requested a code against this
// invite — bounds how many different people one invite link can be used to
// email (see MAX_VERIFICATION_TARGETS_PER_INVITE, trustedAccess.ts). Without
// this, a single valid invite id could be used to send an unlimited number
// of "verification code" emails to arbitrary third-party addresses (an open
// mail-relay / spam-amplification path, caught in this project's post-commit
// security review — see task_plan.md Phase 7.1).
export async function countVerificationTargets(db: D1Database, inviteId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(DISTINCT email) AS n FROM email_verifications WHERE invite_id = ?")
    .bind(inviteId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function incrementVerificationAttempts(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?").bind(id).run();
}

// --- Scheduling settings (Phase 7.2 requirements revision, see task_plan.md) ---

export interface SchedulingSettingsRow {
  user_id: string;
  min_duration_minutes: number;
  max_duration_minutes: number;
  duration_step_minutes: number;
  buffer_minutes: number;
  workday_start_minutes: number;
  workday_end_minutes: number;
  meet_account_id: string | null;
  updated_at: string;
}

// Every user has exactly one row, created lazily with defaults on first
// access (INSERT ... ON CONFLICT DO NOTHING then SELECT) rather than
// requiring a separate onboarding step — callers never need to handle "no
// settings yet" as a distinct case.
export async function getOrCreateSchedulingSettings(db: D1Database, userId: string): Promise<SchedulingSettingsRow> {
  await db
    .prepare("INSERT INTO scheduling_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING")
    .bind(userId)
    .run();
  const row = await db
    .prepare("SELECT * FROM scheduling_settings WHERE user_id = ?")
    .bind(userId)
    .first<SchedulingSettingsRow>();
  if (!row) throw new Error(`getOrCreateSchedulingSettings: row missing immediately after upsert for user ${userId}`);
  return row;
}

export interface UpdateSchedulingSettingsInput {
  minDurationMinutes: number;
  maxDurationMinutes: number;
  durationStepMinutes: number;
  bufferMinutes: number;
  workdayStartMinutes: number;
  workdayEndMinutes: number;
  meetAccountId: string | null;
}

// UPSERT, not a plain UPDATE: a caller that hasn't already seeded defaults
// via getOrCreateSchedulingSettings (every route in this codebase does, but
// nothing forces that) would otherwise have this silently affect zero rows
// with no error at all. Relies on the table's own CHECK constraints
// (migration 0006) to reject an inconsistent combination (e.g. a step that
// doesn't evenly divide the range) — the route layer (routes/settings.tsx)
// still validates early for a friendlier error message, but this is the
// real enforcement point.
export async function updateSchedulingSettings(
  db: D1Database,
  userId: string,
  input: UpdateSchedulingSettingsInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO scheduling_settings
         (user_id, min_duration_minutes, max_duration_minutes, duration_step_minutes, buffer_minutes,
          workday_start_minutes, workday_end_minutes, meet_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         min_duration_minutes = excluded.min_duration_minutes,
         max_duration_minutes = excluded.max_duration_minutes,
         duration_step_minutes = excluded.duration_step_minutes,
         buffer_minutes = excluded.buffer_minutes,
         workday_start_minutes = excluded.workday_start_minutes,
         workday_end_minutes = excluded.workday_end_minutes,
         meet_account_id = excluded.meet_account_id`,
    )
    .bind(
      userId,
      input.minDurationMinutes,
      input.maxDurationMinutes,
      input.durationStepMinutes,
      input.bufferMinutes,
      input.workdayStartMinutes,
      input.workdayEndMinutes,
      input.meetAccountId,
    )
    .run();
}

// --- Meeting polls (Phase 7.3, see task_plan.md) ---

export type MeetingPollStatus = "open" | "finalized" | "cancelled";

export interface MeetingPollRow {
  id: string;
  user_id: string;
  account_id: string;
  title: string;
  duration_minutes: number;
  modality: AppointmentModality;
  status: MeetingPollStatus;
  chosen_slot_id: string | null;
  booked_start: string | null;
  booked_end: string | null;
  google_event_id: string | null;
  created_at: string;
}

export interface CreateMeetingPollInput {
  id: string;
  userId: string;
  accountId: string;
  title: string;
  durationMinutes: number;
  modality: AppointmentModality;
}

export async function createMeetingPoll(db: D1Database, input: CreateMeetingPollInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meeting_polls (id, user_id, account_id, title, duration_minutes, modality)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.userId, input.accountId, input.title, input.durationMinutes, input.modality)
    .run();
}

export function findMeetingPoll(db: D1Database, id: string): Promise<MeetingPollRow | null> {
  return db.prepare("SELECT * FROM meeting_polls WHERE id = ?").bind(id).first<MeetingPollRow>();
}

// Scoped by both id and user_id, same reasoning as findAccountForUser above —
// the dashboard poll-detail/finalize routes (requireAuth-gated) must never be
// able to act on another user's poll just because they guessed/enumerated an id.
export function findMeetingPollForUser(db: D1Database, userId: string, id: string): Promise<MeetingPollRow | null> {
  return db
    .prepare("SELECT * FROM meeting_polls WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<MeetingPollRow>();
}

export async function listMeetingPollsForUser(db: D1Database, userId: string): Promise<MeetingPollRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM meeting_polls WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<MeetingPollRow>();
  return results;
}

// Atomic compare-and-swap, same shape as tryConsumeInvite/tryStartSyncLog:
// only succeeds if the poll is 'open' and no slot has been claimed yet,
// closing the race where two near-simultaneous finalize calls (e.g. a double
// form submit) could both proceed to write a real Meet room / calendar
// event. Deliberately a separate step from finalizeMeetingPollBooking below
// — see migration 0007's CHECK comment for why the two are split rather than
// one atomic UPDATE that also sets status='finalized'.
export async function tryClaimPollSlot(db: D1Database, pollId: string, slotId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE meeting_polls SET chosen_slot_id = ? WHERE id = ? AND status = 'open' AND chosen_slot_id IS NULL")
    .bind(slotId, pollId)
    .run();
  return result.meta.changes === 1;
}

// Called only after tryClaimPollSlot succeeded and the real Meet room /
// calendar event write (finalizePoll, trustedAccess.ts) has itself
// succeeded — see that function for the full ordering rationale. Guarded on
// `status = 'open' AND chosen_slot_id = ?`, not just `id = ?` — the claim
// deliberately leaves status 'open' (see tryClaimPollSlot's comment), which
// means cancelOpenPoll's own `WHERE status = 'open'` can still succeed
// *during* the real Google writes between the claim and this call. Without
// this guard, this UPDATE would silently overwrite a cancellation that
// landed in that window back to 'finalized' — found in an independent
// security review of Phase 7.3, reproduced by cancelling from inside a
// mocked Google call and observing the poll end up 'finalized' anyway with
// a real google_event_id. Returns whether the write actually took, so
// finalizePoll can tell a genuine finalize apart from one that lost this
// race.
export async function finalizeMeetingPollBooking(
  db: D1Database,
  pollId: string,
  slotId: string,
  bookedStart: string,
  bookedEnd: string,
  googleEventId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE meeting_polls SET status = 'finalized', booked_start = ?, booked_end = ?, google_event_id = ? WHERE id = ? AND status = 'open' AND chosen_slot_id = ?",
    )
    .bind(bookedStart, bookedEnd, googleEventId, pollId, slotId)
    .run();
  return result.meta.changes === 1;
}

// Releases a claimed-but-not-yet-finalized slot back to 'open' — called only
// when the real Google writes between tryClaimPollSlot and
// finalizeMeetingPollBooking fail (finalizePoll, trustedAccess.ts), so a
// transient Calendar API error doesn't permanently brick the poll (chosen_
// slot_id would otherwise stay set forever, and tryClaimPollSlot's CAS
// requires it NULL to claim again). Guarded the same way tryClaimPollSlot
// claims — only touches a still-'open' poll, so it can't un-cancel a poll
// that was cancelled in the same window this is racing to recover from.
export async function releasePollSlotClaim(db: D1Database, pollId: string): Promise<void> {
  await db.prepare("UPDATE meeting_polls SET chosen_slot_id = NULL WHERE id = ? AND status = 'open'").bind(pollId).run();
}

// Owner-only (route layer requireAuth-gates this, findMeetingPollForUser
// re-verifies ownership). Only a still-'open' poll can be cancelled — a
// finalized poll already has a real calendar event and cancelling *that*
// would need to also delete the event, out of scope for this feature (the
// owner can just delete the event directly on their calendar, same as any
// other event this codebase creates).
export async function cancelOpenPoll(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("UPDATE meeting_polls SET status = 'cancelled' WHERE id = ? AND status = 'open'").bind(id).run();
  return result.meta.changes === 1;
}

export interface MeetingPollSlotRow {
  id: string;
  poll_id: string;
  start_time: string;
  end_time: string;
  created_at: string;
}

export interface CreateMeetingPollSlotInput {
  id: string;
  pollId: string;
  startTime: string;
  endTime: string;
}

export async function createMeetingPollSlots(db: D1Database, inputs: CreateMeetingPollSlotInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const stmt = db.prepare("INSERT INTO meeting_poll_slots (id, poll_id, start_time, end_time) VALUES (?, ?, ?, ?)");
  await db.batch(inputs.map((s) => stmt.bind(s.id, s.pollId, s.startTime, s.endTime)));
}

export async function listMeetingPollSlots(db: D1Database, pollId: string): Promise<MeetingPollSlotRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM meeting_poll_slots WHERE poll_id = ? ORDER BY start_time ASC")
    .bind(pollId)
    .all<MeetingPollSlotRow>();
  return results;
}

export interface MeetingPollVoteRow {
  id: string;
  poll_id: string;
  slot_id: string;
  participant_email: string;
  available: number;
  created_at: string;
  updated_at: string;
}

// UPSERT, not INSERT: a participant's vote is resubmittable up until the
// poll is finalized (task_plan.md Phase 7.3) — at most one row per (slot,
// participant), per the unique index in migration 0007, so a changed vote
// overwrites in place rather than accumulating a history this codebase has
// no use for.
export async function castVote(
  db: D1Database,
  pollId: string,
  slotId: string,
  participantEmail: string,
  available: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meeting_poll_votes (id, poll_id, slot_id, participant_email, available)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slot_id, participant_email) DO UPDATE SET available = excluded.available`,
    )
    .bind(crypto.randomUUID(), pollId, slotId, participantEmail, available ? 1 : 0)
    .run();
}

export async function listVotesForPoll(db: D1Database, pollId: string): Promise<MeetingPollVoteRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM meeting_poll_votes WHERE poll_id = ?")
    .bind(pollId)
    .all<MeetingPollVoteRow>();
  return results;
}

export async function listVotesForParticipant(
  db: D1Database,
  pollId: string,
  participantEmail: string,
): Promise<MeetingPollVoteRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM meeting_poll_votes WHERE poll_id = ? AND participant_email = ?")
    .bind(pollId, participantEmail)
    .all<MeetingPollVoteRow>();
  return results;
}

// Distinct participants who have voted on *any* slot in this poll — the
// denominator for "is every participant available on this slot" (a slot
// needs an `available=1` vote from each of these, not just a majority; see
// findFullyAvailableSlot, trustedAccess.ts). Deliberately not derived from
// trusted_invites (kind='meeting_poll', meeting_poll_id=this poll) — a sent
// invite that was never verified/voted shouldn't block finalization forever.
export async function countDistinctParticipants(db: D1Database, pollId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(DISTINCT participant_email) AS n FROM meeting_poll_votes WHERE poll_id = ?")
    .bind(pollId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
