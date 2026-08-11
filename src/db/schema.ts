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
  calendarId: string,
  token: string,
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

export type SyncLogStatus = "in_progress" | "success" | "error";

export interface SyncLogRow {
  id: string;
  user_id: string;
  status: SyncLogStatus;
  message: string | null;
  events_processed: number;
  created_at: string;
}

export async function startSyncLog(db: D1Database, id: string, userId: string): Promise<void> {
  await db.prepare("INSERT INTO sync_logs (id, user_id, status) VALUES (?, ?, 'in_progress')").bind(id, userId).run();
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
