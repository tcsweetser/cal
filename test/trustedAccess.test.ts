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
import { findTrustedInvite, markAccountStatus } from "../src/db/schema";
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

// --- Regressions for the post-commit security review (see task_plan.md Phase 7.1) ---

it("refuses to send a verification code against a nonexistent invite id (was an open mail relay)", async () => {
  const result = await requestEmailVerification(env, "does-not-exist", "victim@example.com");
  expect(result).toEqual({ ok: false, reason: "invite-not-available" });
  expect(mock.sends).toHaveLength(0);
});

it("refuses a resend to the same address before the cooldown elapses", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com" });

  const first = await requestEmailVerification(env, id, "invitee@example.com");
  expect(first).toEqual({ ok: true });
  const second = await requestEmailVerification(env, id, "invitee@example.com");
  expect(second).toEqual({ ok: false, reason: "cooldown" });
  expect(mock.sends).toHaveLength(1); // second attempt never sent
});

it("caps how many distinct addresses one invite can request codes for", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com" });

  for (let i = 0; i < 5; i++) {
    const result = await requestEmailVerification(env, id, `target-${i}@example.com`);
    expect(result).toEqual({ ok: true });
  }
  const sixth = await requestEmailVerification(env, id, "target-5@example.com");
  expect(sixth).toEqual({ ok: false, reason: "too-many-targets" });
  expect(mock.sends).toHaveLength(5);
});

it("a resend does not reset the attempt lockout (was a full rate-limit bypass)", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com" });
  await requestEmailVerification(env, id, "invitee@example.com");
  const firstCode = mock.sends[0]!.html.match(/(\d{6})/)![1]!;
  const wrongCode = wrongCodeFor(firstCode);

  for (let i = 0; i < 5; i++) {
    await confirmEmailVerification(env, id, "invitee@example.com", wrongCode);
  }
  expect((await confirmEmailVerification(env, id, "invitee@example.com", firstCode))).toEqual({
    ok: false,
    reason: "too-many-attempts",
  });

  // Simulate the cooldown having elapsed (backdating directly, rather than a
  // real 60s wait) and request a fresh code for the same address.
  await env.DB.prepare(
    "UPDATE email_verifications SET created_at = '2000-01-01T00:00:00.000Z' WHERE invite_id = ? AND email = ?",
  )
    .bind(id, "invitee@example.com")
    .run();
  const resend = await requestEmailVerification(env, id, "invitee@example.com");
  expect(resend).toEqual({ ok: true });
  const secondCode = mock.sends[1]!.html.match(/(\d{6})/)![1]!;

  // The lockout must still be in effect — even the brand-new, correct code
  // is rejected, because `attempts` was never reset by the resend.
  const stillLocked = await confirmEmailVerification(env, id, "invitee@example.com", secondCode);
  expect(stillLocked).toEqual({ ok: false, reason: "too-many-attempts" });
});

it("refuses to create an invite against another user's account (security model: invite creation is the one place trust originates)", async () => {
  const { userId } = await setup();
  const otherUserId = await createTestUser("other");
  const otherAccount = await createTestAccount(otherUserId, "primary", { email: "other-owner@example.com", accessToken: "tok-other" });

  await expect(
    createInvite(env, { userId, accountId: otherAccount.id, kind: "appointment", inviteeEmail: "invitee@example.com" }),
  ).rejects.toThrow(/does not belong to user/);
});

it("refuses to create an invite against a non-active account", async () => {
  const { userId, account } = await setup();
  await markAccountStatus(env.DB, account.id, "revoked");

  await expect(
    createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com" }),
  ).rejects.toThrow(/is not active/);
});

it("never reports verification success against an invite that's already used (was state drift)", async () => {
  const { userId, account } = await setup();
  const id = await createInvite(env, { userId, accountId: account.id, kind: "appointment", inviteeEmail: "invitee@example.com" });
  await requestEmailVerification(env, id, "invitee@example.com");
  const code = mock.sends[0]!.html.match(/(\d{6})/)![1]!;
  expect(await confirmEmailVerification(env, id, "invitee@example.com", code)).toEqual({ ok: true });
  expect(await consumeInvite(env, id)).toBe(true); // status now 'used'

  const replay = await confirmEmailVerification(env, id, "invitee@example.com", code);
  expect(replay).toEqual({ ok: false, reason: "invite-not-available" });

  const invite = await findTrustedInvite(env.DB, id);
  expect(invite?.status).toBe("used"); // unchanged, not silently re-flipped
});
