// Thin Resend HTTP client. Cloudflare Workers has no built-in email-sending
// binding, so outbound mail (invite links, verification codes — see
// trustedAccess.ts / task_plan.md Phase 7) goes through Resend's plain HTTP
// API via fetch, mirroring googleCalendar.ts's googleFetch (no SDK, no new
// npm dependency).

import type { Env } from "../types";

const RESEND_URL = "https://api.resend.com/emails";
const MAX_RETRY_ATTEMPTS = 3;

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export class EmailSendError extends Error {
  constructor(status: number, body: string) {
    super(`Resend send failed: ${status} ${body}`);
    this.name = "EmailSendError";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries 429/5xx with exponential backoff (honoring Retry-After when Resend
// sends one) — same shape as googleFetch (googleCalendar.ts). Other statuses
// are returned as-is immediately for the caller to interpret.
async function resendFetch(apiKey: string, body: unknown): Promise<Response> {
  let res: Response;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_RETRY_ATTEMPTS) return res;
    const retryAfterHeader = res.headers.get("Retry-After");
    const delayMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2 ** attempt * 250;
    await sleep(delayMs);
  }
  return res!;
}

export async function sendEmail(env: Env, input: SendEmailInput): Promise<void> {
  const res = await resendFetch(env.RESEND_API_TOKEN, {
    from: env.CAL_FROM_ADDRESS,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });
  if (!res.ok) throw new EmailSendError(res.status, await res.text());
}
