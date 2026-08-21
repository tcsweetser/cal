import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppBindings } from "../types";
import type { AccountTag } from "../db/schema";
import {
  findUserByEmail,
  createUser,
  updateUserProfile,
  findAccountByUserAndEmail,
  findPrimaryAccountForUser,
  createAccount,
  markAccountStatus,
} from "../db/schema";
import { storeTokens } from "../services/tokenManager";
import { createSession, destroySession, getSession, requireAuth, SESSION_COOKIE } from "../middleware/auth";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  importHmacKey,
  signJSON,
  verifyJSON,
} from "../lib/crypto";

const OAUTH_FLOW_COOKIE = "oauth_flow";
const OAUTH_FLOW_TTL_SECONDS = 600; // 10 minutes — just long enough for the Google consent screen
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
// `profile` (in addition to the openid/email/calendar scopes already needed)
// buys the sidebar's real name + Google photo — see migrations/0008_user_profile.sql.
const SCOPES = "openid email profile https://www.googleapis.com/auth/calendar";
const VALID_TAGS: readonly AccountTag[] = ["business", "side_hustle", "personal"];

interface OAuthFlowData {
  state: string;
  codeVerifier: string;
  purpose: "login" | "connect";
  tag?: AccountTag;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const auth = new Hono<AppBindings>();

function callbackUrl(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/auth/callback`;
}

function setFlowCookie(c: Context<AppBindings>, value: string) {
  setCookie(c, OAUTH_FLOW_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: OAUTH_FLOW_TTL_SECONDS,
    path: "/",
  });
}

function setSessionCookie(c: Context<AppBindings>, sessionId: string) {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
}

async function beginOAuthFlow(c: Context<AppBindings>, purpose: "login" | "connect", tag?: AccountTag) {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const flowData: OAuthFlowData = { state, codeVerifier, purpose, tag };
  const hmacKey = await importHmacKey(c.env.SESSION_SECRET);
  setFlowCookie(c, await signJSON(hmacKey, flowData));

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(c.req.url),
    response_type: "code",
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent", // guarantees a refresh_token even when re-connecting an account
  });

  return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
}

auth.get("/auth/login", (c) => beginOAuthFlow(c, "login"));

auth.get("/auth/connect-account", requireAuth, (c) => {
  const tag = c.req.query("tag");
  if (!VALID_TAGS.includes(tag as AccountTag)) {
    return c.text(`Invalid or missing tag. Must be one of: ${VALID_TAGS.join(", ")}`, 400);
  }
  return beginOAuthFlow(c, "connect", tag as AccountTag);
});

auth.post("/auth/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await destroySession(c.env, sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login");
});

async function handleLoginCallback(
  c: Context<AppBindings>,
  email: string,
  profile: { name: string | null; picture_url: string | null },
  tokens: { access_token: string; refresh_token?: string; expires_at: number },
) {
  if (email !== c.env.PRIMARY_ACCOUNT_EMAIL.toLowerCase()) {
    return c.text("This dashboard is restricted to the primary account owner.", 403);
  }
  if (!tokens.refresh_token) {
    return c.text("Google did not return a refresh_token for the primary account.", 502);
  }

  let user = await findUserByEmail(c.env.DB, email);
  if (!user) {
    const userId = crypto.randomUUID();
    await createUser(c.env.DB, userId, email);
    user = { id: userId, email, name: null, picture_url: null, created_at: new Date().toISOString() };
  }
  await updateUserProfile(c.env.DB, user.id, profile);

  let primaryAccount = await findPrimaryAccountForUser(c.env.DB, user.id);
  if (!primaryAccount) {
    const accountId = crypto.randomUUID();
    await createAccount(c.env.DB, { id: accountId, userId: user.id, email, role: "primary", tag: null });
    primaryAccount = {
      id: accountId,
      user_id: user.id,
      email,
      role: "primary",
      tag: null,
      status: "active",
      created_at: new Date().toISOString(),
    };
  }

  await storeTokens(c.env, primaryAccount.id, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
  });

  setSessionCookie(c, await createSession(c.env, user.id, email, SESSION_TTL_SECONDS));
  return c.redirect("/dashboard");
}

async function handleConnectCallback(
  c: Context<AppBindings>,
  email: string,
  tokens: { access_token: string; refresh_token?: string; expires_at: number },
  tag: AccountTag,
) {
  const session = await getSession(c);
  if (!session) {
    return c.text("Session expired during the connect flow — please log in and try again.", 401);
  }
  if (!tokens.refresh_token) {
    return c.text(
      "Google did not return a refresh_token for this account. Remove CAL's access under " +
        "https://myaccount.google.com/permissions and try connecting again.",
      502,
    );
  }

  // A `revoked`/`error` row means this exact account was linked before and
  // needs fresh tokens (e.g. Google's refresh token expired — see
  // DEPLOYMENT.md's Testing-status note) — reuse its id and reactivate it,
  // rather than the pre-existing behavior of unconditionally rejecting any
  // already-linked email. Only a still-`active` row blocks reconnecting,
  // since that indicates a genuine duplicate-link attempt, not a recovery.
  const existing = await findAccountByUserAndEmail(c.env.DB, session.userId, email);
  if (existing && existing.status === "active") {
    return c.text(`${email} is already linked to this user.`, 409);
  }

  const accountId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await markAccountStatus(c.env.DB, accountId, "active");
  } else {
    await createAccount(c.env.DB, { id: accountId, userId: session.userId, email, role: "secondary", tag });
  }
  await storeTokens(c.env, accountId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
  });

  return c.redirect("/dashboard");
}

auth.get("/auth/callback", async (c) => {
  const error = c.req.query("error");
  if (error) return c.text(`Google OAuth error: ${error}`, 400);

  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  if (!code || !returnedState) return c.text("Missing code or state", 400);

  const signedFlow = getCookie(c, OAUTH_FLOW_COOKIE);
  deleteCookie(c, OAUTH_FLOW_COOKIE, { path: "/" });
  if (!signedFlow) return c.text("Missing OAuth flow cookie — restart the login flow", 400);

  const hmacKey = await importHmacKey(c.env.SESSION_SECRET);
  const flow = await verifyJSON<OAuthFlowData>(hmacKey, signedFlow);
  if (!flow || flow.state !== returnedState) {
    return c.text("Invalid or tampered OAuth state — restart the login flow", 400);
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: flow.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(c.req.url),
    }),
  });

  const tokenData = await tokenRes.json<GoogleTokenResponse>();
  if (!tokenRes.ok || !tokenData.access_token || !tokenData.expires_in) {
    return c.text(
      `Token exchange failed: ${tokenData.error ?? tokenRes.status} ${tokenData.error_description ?? ""}`,
      502,
    );
  }
  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
  };

  const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userinfo = await userinfoRes.json<{ email?: string; name?: string; picture?: string }>();
  const email = userinfo.email?.toLowerCase();
  if (!userinfoRes.ok || !email) {
    return c.text("Failed to fetch account email from Google", 502);
  }
  const profile = { name: userinfo.name ?? null, picture_url: userinfo.picture ?? null };

  if (flow.purpose === "login") {
    return handleLoginCallback(c, email, profile, tokens);
  }
  if (!flow.tag) {
    return c.text("Missing tag for connect-account flow", 400);
  }
  return handleConnectCallback(c, email, tokens, flow.tag);
});

export default auth;
