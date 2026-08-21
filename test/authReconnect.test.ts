// Regression coverage for a real production incident (task_plan.md,
// "Production incident (2026-08-21)"): all 4 secondary accounts went
// `revoked` after Google's Testing-status 7-day refresh-token cap expired
// them. Reconnecting via /auth/connect-account (the app's only recovery
// path) unconditionally rejected with 409 "already linked" for *any*
// existing row, including a revoked one — there was no way back in short of
// hand-editing D1. Drives the real Hono app end-to-end (session cookie via
// createSession, oauth_flow cookie captured from the real /auth/connect-
// account redirect, Google's token/userinfo endpoints mocked) rather than
// calling the route handler directly, since the bug lives in how those two
// cookies and D1 state interact.
import { env } from "cloudflare:workers";
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { createSession, SESSION_COOKIE } from "../src/middleware/auth";
import { findAccountByUserAndEmail, markAccountStatus } from "../src/db/schema";
import { createTestUser, createTestAccount } from "./helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

function cookieHeaderFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header in the response");
  return setCookie.split(";")[0]!;
}

// Stubs only the two Google endpoints the OAuth callback itself hits (token
// exchange + userinfo) — distinct from GoogleCalendarMock/ResendMock, which
// cover the Calendar API and Resend respectively, not this flow.
function installGoogleAuthMock(email: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "new-access-token", refresh_token: "new-refresh-token", expires_in: 3600 });
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
        return Response.json({ email, name: "Reconnect Test", picture: "https://example.com/pic.jpg" });
      }
      throw new Error(`installGoogleAuthMock: unexpected fetch to ${url}`);
    }),
  );
}

it("reconnecting a revoked secondary account reactivates it instead of 409ing", async () => {
  const reconnectEmail = "reconnect@example.com";
  const userId = await createTestUser();
  const existing = await createTestAccount(userId, "secondary", { email: reconnectEmail, tag: "business", accessToken: "old-token" });
  await markAccountStatus(env.DB, existing.id, "revoked");

  const sessionId = await createSession(env, userId, "primary@example.com");
  const sessionCookie = `${SESSION_COOKIE}=${sessionId}`;

  // Real /auth/connect-account sets the signed oauth_flow cookie and redirects to Google.
  const beginRes = await worker.fetch(
    new Request("https://cal.test/auth/connect-account?tag=business", { headers: { cookie: sessionCookie } }),
    env,
  );
  expect(beginRes.status).toBe(302);
  const flowCookie = cookieHeaderFrom(beginRes);
  const state = new URL(beginRes.headers.get("location")!).searchParams.get("state");
  expect(state).toBeTruthy();

  installGoogleAuthMock(reconnectEmail);

  const callbackRes = await worker.fetch(
    new Request(`https://cal.test/auth/callback?code=fake-code&state=${state}`, {
      headers: { cookie: `${sessionCookie}; ${flowCookie}` },
    }),
    env,
  );

  expect(callbackRes.status).toBe(302);
  expect(callbackRes.headers.get("location")).toBe("/dashboard");

  const reactivated = await findAccountByUserAndEmail(env.DB, userId, reconnectEmail);
  expect(reactivated?.id).toBe(existing.id); // same row reused, not a duplicate
  expect(reactivated?.status).toBe("active");
});

it("reconnecting an already-active account still rejects with 409", async () => {
  const email = "already-active@example.com";
  const userId = await createTestUser();
  await createTestAccount(userId, "secondary", { email, tag: "personal", accessToken: "tok" });

  const sessionId = await createSession(env, userId, "primary@example.com");
  const sessionCookie = `${SESSION_COOKIE}=${sessionId}`;

  const beginRes = await worker.fetch(
    new Request("https://cal.test/auth/connect-account?tag=personal", { headers: { cookie: sessionCookie } }),
    env,
  );
  const flowCookie = cookieHeaderFrom(beginRes);
  const state = new URL(beginRes.headers.get("location")!).searchParams.get("state");

  installGoogleAuthMock(email);

  const callbackRes = await worker.fetch(
    new Request(`https://cal.test/auth/callback?code=fake-code&state=${state}`, {
      headers: { cookie: `${sessionCookie}; ${flowCookie}` },
    }),
    env,
  );

  expect(callbackRes.status).toBe(409);
});
