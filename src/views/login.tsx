import type { FC } from "hono/jsx";
import { PublicShell } from "./layout";

// Deliberately not gated behind requireAuth and not using Layout (which
// assumes an authenticated session) — this is the one page an anonymous
// visitor, crawler, or link-preview fetcher can land on without immediately
// kicking off a Google OAuth redirect and burning an authorization request.
export const LoginPage: FC = () => (
  <PublicShell title="Sign in" center>
    <div style="text-align: center;">
      <div
        style="width: 52px; height: 52px; border-radius: 14px; background: var(--accent); color: var(--accent-contrast);
          display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.25rem; margin: 0 auto 1.25rem;"
      >
        C
      </div>
      <h1 style="margin-bottom: 0.5rem;">CAL</h1>
      <p class="lede" style="margin: 0 auto 1.75rem; max-width: none;">
        Calendar Replication &amp; Anti-Double-Booking System
      </p>
      <a class="button" href="/auth/login" style="display: inline-flex;">
        <span
          style="width: 16px; height: 16px; border-radius: 3px;
            background: linear-gradient(135deg, oklch(60% 0.19 25), oklch(65% 0.16 90), oklch(58% 0.15 150), oklch(53% 0.16 262));"
        />
        Sign in with Google
      </a>
    </div>
  </PublicShell>
);
