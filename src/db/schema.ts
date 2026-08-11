// Minimal D1 query helpers — only what Phase 3 (auth) actually calls. Extend as
// later phases need more (sync engine, dashboard), not speculatively now.

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
