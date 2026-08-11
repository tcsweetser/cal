import type { FC } from "hono/jsx";
import { raw } from "hono/html";

const css = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 420px;
    margin: 4rem auto;
    padding: 0 1.5rem;
    text-align: center;
    line-height: 1.5;
  }
  .button {
    display: inline-block; margin-top: 1.5rem; padding: 0.6rem 1.4rem; border-radius: 6px;
    border: 1px solid light-dark(#ccc, #444); background: light-dark(#f5f5f5, #222);
    color: inherit; text-decoration: none; font-weight: 600;
  }
  .button:hover { background: light-dark(#eaeaea, #2c2c2c); }
`;

// Deliberately not gated behind requireAuth and not using Layout (which
// assumes an authenticated session) — this is the one page an anonymous
// visitor, crawler, or link-preview fetcher can land on without immediately
// kicking off a Google OAuth redirect and burning an authorization request.
export const LoginPage: FC = () => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Sign in — CAL</title>
      <style>{raw(css)}</style>
    </head>
    <body>
      <h1>CAL</h1>
      <p>Calendar Replication &amp; Anti-Double-Booking System</p>
      <a class="button" href="/auth/login">
        Sign in with Google
      </a>
    </body>
  </html>
);
