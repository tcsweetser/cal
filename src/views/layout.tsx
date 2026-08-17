import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";

const css = `
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 860px;
    margin: 0 auto;
    padding: 1.5rem;
    line-height: 1.5;
  }
  nav { display: flex; align-items: center; gap: 1.25rem; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid light-dark(#ddd, #333); }
  nav a { text-decoration: none; color: inherit; font-weight: 600; }
  nav a:hover { text-decoration: underline; }
  nav form { margin-left: auto; }
  nav button.link {
    font: inherit; font-weight: 600; padding: 0; border: none; background: none; color: inherit;
    cursor: pointer; text-decoration: none;
  }
  nav button.link:hover { text-decoration: underline; }
  h1 { font-size: 1.4rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid light-dark(#e5e5e5, #2a2a2a); }
  th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.7; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
  .badge-active, .badge-success, .badge-finalized { background: light-dark(#e6f4ea, #1c3324); color: light-dark(#1e7e34, #6fcf97); }
  .badge-revoked, .badge-error, .badge-cancelled { background: light-dark(#fdecea, #3a1f1f); color: light-dark(#c0392b, #ff6b5f); }
  .badge-in_progress, .badge-open { background: light-dark(#fff8e1, #3a3320); color: light-dark(#b8860b, #e0c060); }
  form.inline { display: inline; }
  button, .button {
    font: inherit; padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid light-dark(#ccc, #444);
    background: light-dark(#f5f5f5, #222); color: inherit; cursor: pointer; text-decoration: none;
  }
  button:hover, .button:hover { background: light-dark(#eaeaea, #2c2c2c); }
  .empty { opacity: 0.7; font-style: italic; }
  code { font-size: 0.85em; }
`;

export const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — CAL</title>
      <style>{raw(css)}</style>
    </head>
    <body>
      <nav>
        <a href="/dashboard">Accounts</a>
        <a href="/dashboard/mappings">Roles &amp; Tags</a>
        <a href="/dashboard/logs">Sync Logs</a>
        <a href="/dashboard/invites">Invites</a>
        <a href="/dashboard/meeting-polls">Meeting Polls</a>
        <a href="/dashboard/settings">Settings</a>
        {/* POST, not a GET link — link prefetchers/crawlers/preview-fetchers
            following a GET /auth/logout would silently log the user out. */}
        <form method="post" action="/auth/logout">
          <button type="submit" class="link">
            Log out
          </button>
        </form>
      </nav>
      <main>{children}</main>
    </body>
  </html>
);
