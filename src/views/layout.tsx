import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";

// Design tokens + shared component primitives (badges, cards, tables, form
// controls, buttons) — one definition reused by both the authenticated
// sidebar shell (Layout, below) and the public centered-card shell
// (PublicShell, below), so views/booking.tsx, views/pollVoting.tsx, and
// views/login.tsx render from the same system instead of each keeping its
// own drifting copy. Every color is wrapped in light-dark() so the existing
// `color-scheme: light dark` OS-preference behavior (already relied on
// elsewhere in this app) keeps working — this redesign adds new tokens, not
// a new mechanism.
const SHARED_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    --bg: light-dark(oklch(97.3% 0.004 75), oklch(16% 0.008 75));
    --surface: light-dark(oklch(100% 0 0), oklch(21% 0.008 75));
    --surface-alt: light-dark(oklch(97.8% 0.004 75), oklch(25% 0.008 75));
    --border: light-dark(oklch(89% 0.005 75), oklch(32% 0.008 75));
    --text: light-dark(oklch(22% 0.01 75), oklch(93% 0.004 75));
    --text-muted: light-dark(oklch(45% 0.01 75), oklch(68% 0.008 75));
    --text-faint: light-dark(oklch(52% 0.01 75), oklch(58% 0.008 75));
    --accent: light-dark(oklch(53% 0.16 262), oklch(72% 0.15 262));
    --accent-contrast: light-dark(oklch(100% 0 0), oklch(15% 0.02 262));
    --accent-soft: light-dark(oklch(94% 0.03 262), oklch(30% 0.06 262));
    --accent-soft-text: light-dark(oklch(40% 0.14 262), oklch(85% 0.08 262));
    --success-bg: light-dark(oklch(94% 0.05 152), oklch(28% 0.05 152));
    --success-fg: light-dark(oklch(32% 0.11 152), oklch(78% 0.13 152));
    --danger-bg: light-dark(oklch(95% 0.045 23), oklch(30% 0.06 23));
    --danger-fg: light-dark(oklch(45% 0.17 23), oklch(80% 0.13 23));
    --warning-bg: light-dark(oklch(95% 0.05 85), oklch(30% 0.05 85));
    --warning-fg: light-dark(oklch(42% 0.1 70), oklch(80% 0.1 80));
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }
  h1 { font-size: 1.375rem; font-weight: 700; margin: 0 0 1.75rem; }
  h2 {
    font-size: 0.8125rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--text-faint); margin: 0 0 0.75rem;
  }
  p { color: var(--text); }
  p.lede { color: var(--text-muted); max-width: 40rem; margin: 0 0 1.75rem; }
  section { margin-bottom: 2.25rem; }
  code { font-size: 0.85em; }
  .empty { color: var(--text-muted); font-style: italic; }
  .hint { color: var(--text-muted); font-size: 0.9em; }
  .error { color: var(--danger-fg); }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
  }
  .card-flush { padding: 0; overflow: hidden; }
  .stack { display: flex; flex-direction: column; gap: 1rem; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: center; }

  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  thead tr { background: var(--surface-alt); }
  th {
    text-align: left; padding: 0.6rem 1rem; font-size: 0.69rem; text-transform: uppercase;
    letter-spacing: 0.03em; color: var(--text-faint); font-weight: 700;
  }
  td { padding: 0.65rem 1rem; border-top: 1px solid var(--border); }

  .badge {
    display: inline-flex; align-items: center; padding: 0.15rem 0.6rem; border-radius: 999px;
    font-size: 0.75rem; font-weight: 600; white-space: nowrap;
  }
  .badge-active, .badge-success, .badge-finalized, .badge-used { background: var(--success-bg); color: var(--success-fg); }
  .badge-revoked, .badge-error, .badge-expired, .badge-cancelled { background: var(--danger-bg); color: var(--danger-fg); }
  .badge-in_progress, .badge-open, .badge-pending, .badge-verified { background: var(--warning-bg); color: var(--warning-fg); }

  label { display: flex; flex-direction: column; gap: 0.375rem; font-size: 0.8125rem; font-weight: 600; color: var(--text-muted); }
  label.inline { flex-direction: row; align-items: center; gap: 0.5rem; font-weight: 500; color: var(--text); }
  input, select, textarea {
    font: inherit; font-size: 0.85rem; padding: 0.5rem 0.65rem; border-radius: 7px;
    border: 1px solid var(--border); background: var(--surface); color: var(--text);
  }
  textarea { resize: vertical; }

  button, .button {
    font: inherit; font-size: 0.85rem; font-weight: 600; padding: 0.55rem 1rem; border-radius: 7px;
    border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer;
    text-decoration: none; display: inline-flex; align-items: center; gap: 0.5rem;
  }
  button:hover, .button:hover { background: var(--surface-alt); }
  button.btn-primary, .button.btn-primary {
    border: none; background: var(--accent); color: var(--accent-contrast);
  }
  button.btn-primary:hover, .button.btn-primary:hover { filter: brightness(1.08); }
  button.link {
    border: none; background: none; padding: 0; color: var(--accent); font-weight: 600; text-decoration: none;
  }
  button.link:hover { text-decoration: underline; }
  a.text-link { color: var(--accent); font-weight: 600; text-decoration: none; font-size: 0.85rem; }
  a.text-link:hover { text-decoration: underline; }
`;

const NAV_ITEMS = [
  { id: "accounts", label: "Accounts", href: "/dashboard" },
  { id: "roles", label: "Roles & Tags", href: "/dashboard/mappings" },
  { id: "logs", label: "Sync Logs", href: "/dashboard/logs" },
  { id: "invites", label: "Invites", href: "/dashboard/invites" },
  { id: "polls", label: "Meeting Polls", href: "/dashboard/meeting-polls" },
  { id: "settings", label: "Settings", href: "/dashboard/settings" },
] as const;

export type NavId = (typeof NAV_ITEMS)[number]["id"];

export interface SidebarUser {
  email: string;
  name: string | null;
  picture_url: string | null;
}

function initials(user: SidebarUser): string {
  const source = user.name?.trim() || user.email;
  const [first, second] = source.split(/\s+/).filter(Boolean);
  if (first && second) return (first.charAt(0) + second.charAt(0)).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

const LAYOUT_CSS = `
  .app-shell { min-height: 100vh; display: flex; }
  .sidebar {
    width: 230px; flex: 0 0 230px; background: var(--surface); border-right: 1px solid var(--border);
    padding: 1.5rem 1rem; display: flex; flex-direction: column; gap: 0.15rem; min-height: 100vh;
  }
  .identity { display: flex; align-items: center; gap: 0.625rem; padding: 0.375rem 0.625rem 1.25rem; }
  .identity-avatar {
    width: 30px; height: 30px; border-radius: 8px; background: var(--accent); color: var(--accent-contrast);
    display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.8125rem;
    flex: none; object-fit: cover;
  }
  .identity-text { min-width: 0; }
  .identity-name {
    font-size: 0.8125rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .identity-sub { font-size: 0.6875rem; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nav-item {
    display: flex; align-items: center; gap: 0.625rem; padding: 0.5625rem 0.75rem; border: none; background: none;
    text-align: left; font: inherit; font-size: 0.84rem; color: var(--text-muted); border-radius: 8px; cursor: pointer;
    text-decoration: none;
  }
  .nav-item:hover { background: var(--surface-alt); }
  .nav-item.active { background: var(--accent-soft); color: var(--accent-soft-text); font-weight: 700; }
  .nav-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--text-faint); flex: none; }
  .nav-item.active .nav-dot { background: var(--accent); }
  .sidebar-spacer { flex: 1; }
  .logout-form { margin: 0; }
  .logout-form button {
    width: 100%; display: flex; align-items: center; gap: 0.625rem; padding: 0.5625rem 0.75rem; border: none;
    background: none; text-align: left; font: inherit; font-size: 0.84rem; color: var(--text-faint); border-radius: 8px;
  }
  .logout-form button:hover { background: var(--surface-alt); }
  .main { flex: 1; min-width: 0; padding: 2.75rem 3rem 5rem; }
  .main-inner { max-width: 820px; }
`;

export const Layout: FC<PropsWithChildren<{ title: string; active: NavId; user: SidebarUser }>> = ({
  title,
  active,
  user,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — CAL</title>
      <style>{raw(SHARED_CSS + LAYOUT_CSS)}</style>
    </head>
    <body>
      <div class="app-shell">
        <div class="sidebar">
          <div class="identity">
            {user.picture_url ? (
              <img class="identity-avatar" src={user.picture_url} alt="" referrerpolicy="no-referrer" />
            ) : (
              <div class="identity-avatar">{initials(user)}</div>
            )}
            <div class="identity-text">
              <div class="identity-name">{user.name || user.email}</div>
              <div class="identity-sub">{user.email}</div>
            </div>
          </div>
          {NAV_ITEMS.map((item) => (
            <a class={`nav-item${item.id === active ? " active" : ""}`} href={item.href}>
              <span class="nav-dot" />
              {item.label}
            </a>
          ))}
          <div class="sidebar-spacer" />
          {/* POST, not a GET link — link prefetchers/crawlers/preview-fetchers
              following a GET /auth/logout would silently log the user out. */}
          <form class="logout-form" method="post" action="/auth/logout">
            <button type="submit">Log out</button>
          </form>
        </div>
        <div class="main">
          <div class="main-inner">{children}</div>
        </div>
      </div>
    </body>
  </html>
);

const PUBLIC_CSS = `
  .public-shell { min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 4rem 1.5rem; }
  .public-shell.center { align-items: center; }
  .public-card { max-width: 420px; width: 100%; }
  .public-card.wide { max-width: 460px; }
`;

// Shared shell for the app's public, unauthenticated surfaces (login,
// trusted-party booking, poll voting) — same design tokens/components as
// Layout, deliberately without its sidebar/session assumptions. Each caller
// keeps its own route logic and form markup untouched; this only replaces
// the bespoke <html>/<style> wrapper each view previously duplicated.
export const PublicShell: FC<PropsWithChildren<{ title: string; wide?: boolean; center?: boolean }>> = ({
  title,
  wide,
  center,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — CAL</title>
      <style>{raw(SHARED_CSS + PUBLIC_CSS)}</style>
    </head>
    <body>
      <div class={`public-shell${center ? " center" : ""}`}>
        <div class={`public-card${wide ? " wide" : ""}`}>{children}</div>
      </div>
    </body>
  </html>
);
