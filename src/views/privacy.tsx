import type { FC } from "hono/jsx";
import { raw } from "hono/html";

// Required by Google's OAuth consent screen to move the app out of
// "Testing" publishing status (Branding page rejects "Publish app" without
// a homepage + privacy policy URL) — see DEPLOYMENT.md's note on the 7-day
// Testing-status refresh-token cap. CAL is a single-operator personal tool,
// not a multi-tenant product, so this describes the one real deployment,
// not a generic SaaS privacy policy.
//
// Deliberately self-contained (own inline styles, no shared Layout/
// PublicShell import) rather than reusing the Phase 9 redesign's layout.tsx
// — this page needs to ship and go live independently of that larger,
// not-yet-reviewed UI change, per explicit direction this session.
const css = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 640px;
    margin: 3rem auto;
    padding: 0 1.5rem;
    line-height: 1.6;
  }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  a { color: light-dark(#2952cc, #8ab4ff); }
`;

export const PrivacyPage: FC = () => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Privacy policy — CAL</title>
      <style>{raw(css)}</style>
    </head>
    <body>
      <h1>Privacy policy</h1>
      <p>
        CAL (Calendar Replication &amp; Anti-Double-Booking System) is a personal tool operated by its owner for
        their own use, not a public service or product. This page exists to satisfy Google's OAuth consent screen
        requirements for the Google accounts connected to it.
      </p>

      <h2>What data this app processes</h2>
      <ul>
        <li>
          <strong>Connected Google accounts</strong> — email address, display name, and profile photo (from Google's
          basic profile info), plus Calendar event data (times, and only the metadata needed to detect and prevent
          double-bookings) for whichever accounts the owner explicitly connects.
        </li>
        <li>
          <strong>OAuth tokens</strong> — stored encrypted, used only to call the Google Calendar API on the owner's
          behalf.
        </li>
        <li>
          <strong>Trusted-party booking / meeting-poll participants</strong> — an invitee's email address and a
          short-lived verification code, used only to confirm they control that inbox before letting them book a
          time. Nothing they submit is ever written to the real calendar — only a generic placeholder event.
        </li>
      </ul>

      <h2>How it's used</h2>
      <p>
        Solely to replicate calendar events across the owner's own connected accounts and to run the appointment/
        meeting-poll booking flows described above. There is no advertising, analytics, or tracking, and no data is
        sold or shared with third parties beyond the Google Calendar API (to sync events) and an email delivery
        provider (to send verification codes).
      </p>

      <h2>Retention</h2>
      <p>
        Data for a connected account is kept only while that account remains connected; disconnecting it stops
        further processing. A booking invite's verification code and email are retained only long enough to resolve
        that invite.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this app or its data handling: <a href="mailto:tcsweetser@gmail.com">tcsweetser@gmail.com</a>.
      </p>
    </body>
  </html>
);
