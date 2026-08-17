import { vi } from "vitest";

const RESEND_URL = "https://api.resend.com/emails";

export interface MockSend {
  to: string;
  subject: string;
  html: string;
}

export class ResendMock {
  sends: MockSend[] = [];
  // Set true to make the next send fail once (simulates a transient 5xx) —
  // consumed on use, same pattern as googleMock.ts's goneOnPatch.
  private failNext = false;

  makeNextSendFail() {
    this.failNext = true;
  }

  // Delegates anything it doesn't recognize to whatever fetch was installed
  // before it, rather than throwing outright — so this composes with another
  // mock (e.g. GoogleCalendarMock) installed in either order in the same
  // test, instead of one silently clobbering the other via vi.stubGlobal.
  install() {
    const previousFetch = globalThis.fetch;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== RESEND_URL) return previousFetch(input, init);

      if (this.failNext) {
        this.failNext = false;
        return new Response("Internal Server Error", { status: 500 });
      }

      const body = JSON.parse(String(init?.body)) as MockSend;
      this.sends.push({ to: body.to, subject: body.subject, html: body.html });
      return new Response(JSON.stringify({ id: `mock-email-${this.sends.length}` }), { status: 200 });
    });

    vi.stubGlobal("fetch", fn);
    return fn;
  }
}
