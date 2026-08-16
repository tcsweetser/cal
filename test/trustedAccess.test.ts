import { env } from "cloudflare:workers";
import { it, expect, beforeEach } from "vitest";
import {
  createInvite,
  sendInviteEmail,
  requestEmailVerification,
  confirmEmailVerification,
  consumeInvite,
  getUsableInvite,
} from "../src/services/trustedAccess";
import { findTrustedInvite } from "../src/db/schema";
import { ResendMock } from "./helpers/emailMock";
import { createTestUser, createTestAccount } from "./helpers/fixtures";

let mock: ResendMock;

beforeEach(() => {
  mock = new ResendMock();
  mock.install();
});

function wrongCodeFor(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

async function setup() {
  const userId = await createTestUser();
  const account = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  return { userId, account };
}

it("issues an invite and emails it to the invitee, not any other address", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com" });
  await sendInviteEmail(env, { id, inviteeEmail: "invitee@example.com", kind: "appointment" }, "https://example.workers.dev");

  expect(mock.sends).toHaveLength(1);
  expect(mock.sends[0]!.to).toBe("invitee@example.com");
  expect(mock.sends[0]!.html).toContain(`/book/${id}`);
});

it("full verify-then-consume flow: wrong code fails without consuming an attempt budget it shouldn't, right code verifies, consume succeeds exactly once", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com" });

  await requestEmailVerification(env, id, "invitee@example.com");
  expect(mock.sends).toHaveLength(1);
  const sentCode = mock.sends[0]!.html.match(/(\d{6})/)![1]!;

  const wrong = await confirmEmailVerification(env, id, "invitee@example.com", wrongCodeFor(sentCode));
  expect(wrong).toEqual({ ok: false, reason: "wrong-code" });

  const right = await confirmEmailVerification(env, id, "invitee@example.com", sentCode);
  expect(right).toEqual({ ok: true });

  const invite = await findTrustedInvite(env.DB, id);
  expect(invite?.status).toBe("verified");
  expect(invite?.verified_email).toBe("invitee@example.com");

  expect(await consumeInvite(env, id)).toBe(true);
  expect(await consumeInvite(env, id)).toBe(false); // single-use: second consume rejected

  const used = await findTrustedInvite(env.DB, id);
  expect(used?.status).toBe("used");
});

it("verifying with a forwarded link's own email works — identity is proven per-verifier, not tied to the original invitee", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, {
    userId,
    accountId: account.id,
    kind: "appointment",
    inviteeEmail: "original-invitee@example.com",
  });

  await requestEmailVerification(env, id, "forwarded-to@example.com");
  const sentCode = mock.sends[0]!.html.match(/(\d{6})/)![1]!;

  const result = await confirmEmailVerification(env, id, "forwarded-to@example.com", sentCode);
  expect(result).toEqual({ ok: true });

  const invite = await findTrustedInvite(env.DB, id);
  expect(invite?.verified_email).toBe("forwarded-to@example.com");
  expect(invite?.invitee_email).toBe("original-invitee@example.com"); // unchanged
});

it("rejects a code after 5 wrong attempts, even if the 6th guess would have been correct", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com" });
  await requestEmailVerification(env, id, "invitee@example.com");
  const sentCode = mock.sends[0]!.html.match(/(\d{6})/)![1]!;
  const wrongCode = wrongCodeFor(sentCode);

  for (let i = 0; i < 5; i++) {
    const result = await confirmEmailVerification(env, id, "invitee@example.com", wrongCode);
    expect(result.ok).toBe(false);
  }

  const finalTry = await confirmEmailVerification(env, id, "invitee@example.com", sentCode);
  expect(finalTry).toEqual({ ok: false, reason: "too-many-attempts" });
});

it("consumeInvite fails on an invite that was never verified", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com" });
  expect(await consumeInvite(env, id)).toBe(false);
});

it("getUsableInvite reports a not-found invite distinctly from a real one", async () => {
  const result = await getUsableInvite(env, "does-not-exist");
  expect(result).toEqual({ invite: null, reason: "not-found" });
});
