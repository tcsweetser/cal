import { env } from "cloudflare:workers";
import { createUser, createAccount, type AccountTag } from "../../src/db/schema";
import { storeTokens } from "../../src/services/tokenManager";

export interface TestAccount {
  id: string;
  email: string;
  accessToken: string;
}

// D1 storage is not guaranteed reset between individual `it()` blocks in the
// same test file, so fixtures generate their own unique data (users.email is
// UNIQUE) rather than relying on any particular isolation behavior.
export async function createTestUser(emailPrefix = "terry"): Promise<string> {
  const userId = crypto.randomUUID();
  await createUser(env.DB, userId, `${emailPrefix}+${userId}@example.com`);
  return userId;
}

export async function createTestAccount(
  userId: string,
  role: "primary" | "secondary",
  opts: { email: string; tag?: AccountTag; accessToken: string },
): Promise<TestAccount> {
  const accountId = crypto.randomUUID();
  await createAccount(env.DB, {
    id: accountId,
    userId,
    email: opts.email,
    role,
    tag: role === "secondary" ? (opts.tag ?? "personal") : null,
  });
  // Far-future expiry so getValidAccessToken never triggers a real network refresh in tests.
  await storeTokens(env, accountId, {
    access_token: opts.accessToken,
    refresh_token: `refresh-${accountId}`,
    expires_at: Date.now() + 60 * 60 * 1000,
  });
  return { id: accountId, email: opts.email, accessToken: opts.accessToken };
}
