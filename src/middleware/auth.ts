import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings, Env, SessionData } from "../types";

const SESSION_COOKIE = "session_id";
const sessionKvKey = (sessionId: string) => `session:${sessionId}`;

export async function createSession(
  env: Env,
  userId: string,
  email: string,
  ttlSeconds = 60 * 60 * 24 * 7,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const session: SessionData = { userId, email, createdAt: now, expiresAt: now + ttlSeconds * 1000 };
  await env.TOKEN_STORE.put(sessionKvKey(sessionId), JSON.stringify(session), {
    expirationTtl: ttlSeconds,
  });
  return sessionId;
}

export async function destroySession(env: Env, sessionId: string): Promise<void> {
  await env.TOKEN_STORE.delete(sessionKvKey(sessionId));
}

// The session cookie itself is an opaque, unguessable, server-revocable random
// ID with no embedded claims — unlike the OAuth-flow cookie (crypto.ts), it
// doesn't need HMAC signing; its security comes from unguessability plus
// HttpOnly/Secure and the KV lookup being the actual source of truth.
export async function getSession(c: Context<AppBindings>): Promise<SessionData | null> {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return null;

  const raw = await c.env.TOKEN_STORE.get(sessionKvKey(sessionId));
  if (!raw) return null;

  let session: SessionData;
  try {
    session = JSON.parse(raw) as SessionData;
  } catch {
    // Corrupt KV value (shouldn't happen, but a 500 on every request with
    // this cookie — with no way for the user to recover except manually
    // clearing cookies — is worse than just treating it as logged out).
    await destroySession(c.env, sessionId);
    return null;
  }

  if (Date.now() >= session.expiresAt) {
    await destroySession(c.env, sessionId);
    return null;
  }
  return session;
}

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const session = await getSession(c);
  if (!session) {
    if (c.req.header("Accept")?.includes("application/json")) {
      return c.json({ error: "authentication required" }, 401);
    }
    return c.redirect("/login");
  }
  c.set("session", session);
  await next();
};

export { SESSION_COOKIE };
