// D1 query helpers — only what Phases 3 (auth) and 4 (sync engine) actually
// call. Extend as later phases need more (dashboard), not speculatively now.

export type AccountRole = "primary" | "secondary";
export type AccountTag = "business" | "side_hustle" | "personal";
export type AccountStatus = "active" | "revoked" | "error";

export interface UserRow {
  id: string;
  email: string;
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

export async function createUser(db: D1Database, id: string, email: string): Promise<void> {
  await db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind(id, email).run();
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
// already exists (a manual trigger racing the cron, or vice versa), rather
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

export interface TrustedInviteRow {
  id: string;
  user_id: string;
  account_id: string;
  kind: TrustedInviteKind;
  invitee_email: string;
  status: TrustedInviteStatus;
  meeting_poll_id: string | null;
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
  expiresAt: string;
}

export async function createTrustedInvite(db: D1Database, input: CreateTrustedInviteInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trusted_invites (id, user_id, account_id, kind, invitee_email, meeting_poll_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.accountId,
      input.kind,
      input.inviteeEmail,
      input.meetingPollId,
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

// Only transitions a 'pending' invite — a re-verify attempt against an
// already-verified/used/revoked invite is silently a no-op here, since the
// caller (trustedAccess.ts) checks status before ever getting this far.
export async function markInviteVerified(db: D1Database, id: string, verifiedEmail: string): Promise<void> {
  await db
    .prepare(
      `UPDATE trusted_invites
       SET status = 'verified', verified_email = ?, verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(verifiedEmail, id)
    .run();
}

// Atomic compare-and-swap, same pattern as tryStartSyncLog above: only
// succeeds if the invite is currently 'verified', closing the race where the
// same link is submitted twice at once (e.g. a double form submit, or two
// browser tabs). Returns false for anything else (already used, expired,
// revoked, or never verified) — the caller treats all of those as "can't book".
export async function tryConsumeInvite(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE trusted_invites SET status = 'used', used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'verified'`,
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
  expires_at: string;
  created_at: string;
}

export interface CreateEmailVerificationInput {
  id: string;
  inviteId: string;
  email: string;
  codeHash: string;
  expiresAt: string;
}

export async function createEmailVerification(db: D1Database, input: CreateEmailVerificationInput): Promise<void> {
  await db
    .prepare("INSERT INTO email_verifications (id, invite_id, email, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(input.id, input.inviteId, input.email, input.codeHash, input.expiresAt)
    .run();
}

// Most recent request for this (invite, email) pair — a re-request (e.g. the
// first code expired before use) should be checked against, not an older one.
export function findLatestEmailVerification(
  db: D1Database,
  inviteId: string,
  email: string,
): Promise<EmailVerificationRow | null> {
  return db
    .prepare("SELECT * FROM email_verifications WHERE invite_id = ? AND email = ? ORDER BY created_at DESC LIMIT 1")
    .bind(inviteId, email)
    .first<EmailVerificationRow>();
}

export async function incrementVerificationAttempts(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?").bind(id).run();
}
