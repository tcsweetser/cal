import { importAesKey, encryptJSON, decryptJSON } from "../lib/crypto";
import type { Env } from "../types";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch millis
}

const EXPIRY_BUFFER_MS = 2 * 60 * 1000;
const kvKey = (accountId: string) => `tokens:${accountId}`;

export async function storeTokens(env: Env, accountId: string, tokens: StoredTokens): Promise<void> {
  const key = await importAesKey(env.TOKEN_ENCRYPTION_KEY);
  const blob = await encryptJSON(key, tokens);
  await env.TOKEN_STORE.put(kvKey(accountId), blob);
}

async function readTokens(env: Env, accountId: string): Promise<StoredTokens | null> {
  const blob = await env.TOKEN_STORE.get(kvKey(accountId));
  if (!blob) return null;
  const key = await importAesKey(env.TOKEN_ENCRYPTION_KEY);
  return decryptJSON<StoredTokens>(key, blob);
}

function isExpired(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.expires_at - EXPIRY_BUFFER_MS;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function refreshTokens(env: Env, accountId: string, refreshToken: string): Promise<StoredTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json<GoogleTokenResponse>();
  if (!res.ok || !data.access_token || !data.expires_in) {
    throw new Error(
      `Token refresh failed for account ${accountId}: ${data.error ?? res.status} ${data.error_description ?? ""}`,
    );
  }

  const refreshed: StoredTokens = {
    access_token: data.access_token,
    // Google does not issue a new refresh_token on every refresh call under
    // standard (non-rotating) OAuth client config — see plan.md §5.2 decision 3.
    refresh_token: refreshToken,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  await storeTokens(env, accountId, refreshed);
  return refreshed;
}

// Re-reads KV immediately before refreshing to narrow (not eliminate) the race
// window documented in plan.md §5.2 decision 3: if a concurrent caller already
// refreshed between our first read and now, we use its result instead of
// hitting Google again.
export async function getValidAccessToken(env: Env, accountId: string): Promise<string> {
  const tokens = await readTokens(env, accountId);
  if (!tokens) throw new Error(`No stored tokens for account: ${accountId}`);
  if (!isExpired(tokens)) return tokens.access_token;

  const recheck = await readTokens(env, accountId);
  if (recheck && !isExpired(recheck)) return recheck.access_token;

  const refreshed = await refreshTokens(env, accountId, (recheck ?? tokens).refresh_token);
  return refreshed.access_token;
}
