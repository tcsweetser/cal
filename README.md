# CAL — Calendar Replication & Anti-Double-Booking System

Open-source, edge-deployed system that keeps multiple Google Calendar accounts (a primary/day-job calendar plus any number of secondary accounts — business, side-hustle, personal) aware of each other's busy time, without leaking event details across contexts. Runs on Cloudflare Workers.

## Status

✅ **Feature-complete and deployed in production.** Skeleton, DB schema, Google OAuth + encrypted token storage + sessions, the sync engine and cron handler, and the dashboard are all built, verified, and running live against 5 real Google accounts (1 primary + 4 secondary), replicating real events end to end — including creates, deletes/cancellations, and recurring events. See `task_plan.md` for the full build and incident history, including two production issues found and fixed after the initial deploy (a Workers subrequest-limit overrun on first full sync, and an unbounded incremental-sync gap for indefinitely-recurring events).

Full implementation plan and progress tracking: [`task_plan.md`](task_plan.md).

## How it works

- **Roles**: exactly one `primary` account (your main calendar, also the dashboard login), and at least one `secondary` account. Every secondary account carries a required `tag` — `business`, `side_hustle`, or `personal` — used only as a dashboard label; it never changes sync behavior.
- **Sync topology** (single-hop fan-out, no intermediary hops):
  - Secondary → Primary: replicated as `"Busy"`
  - Primary → every Secondary: replicated as `"Personal Time"`
  - Secondary → every other Secondary: replicated as `"Busy"`
- Replicated events strip all identifying detail (no title, description, attendees, or location) — only free/busy status crosses calendars.
- A background sync runs on a 10-minute Cron Trigger; deletions and edits (including flipping an event from busy to free) propagate automatically.
- **Sync window**: only events within a rolling window from now to 42 days out are replicated — not yet-ended (still-ongoing or upcoming) on the near side, starting within 42 days on the far side. This keeps each sync run within Cloudflare Workers' external-subrequest limit regardless of calendar size — see `task_plan.md` for the incidents that made this necessary (an indefinitely-recurring event with no end date expanded to hundreds of occurrences in one sync; then, symmetrically, a newly-created series anchored months in the past arrived with all its already-elapsed occurrences intact). Cancellations are never subject to this window in either direction — a stale replica is always cleaned up regardless of how far out (or how far in the past) it would have been.
- **Daily recurring-series audit**: a recurring series that's never edited again would otherwise stop replicating new occurrences once they roll past the far edge of the sync window, since Google's incremental sync only reports *changes* and an untouched series never generates one. Once a day (piggybacked on whichever 10-minute cron tick is first after UTC midnight, gated by a KV timestamp rather than a second Cron Trigger — Cloudflare accounts have a small fixed budget of those), every recurring series the app has seen gets its `[covered_through, today+42d]` gap checked directly via Google's `events.instances()` endpoint and any new occurrence enqueued for the next normal sync to replicate. Only applies to series the app has seen *since this feature shipped* — a series fully synced before then is picked up once it's next touched (edited/cancelled) or a token-expiry forces a full re-sync.
- Full design detail, including the data model and the loop-prevention mechanism, is in [`plan.md`](plan.md); the original build spec is in [`claude_code_prompt.md`](claude_code_prompt.md).

## Dashboard

Once logged in as the primary account:

- **`/dashboard`** — connected accounts overview, plus a form to connect a new secondary account (pick a tag, redirects into the Google OAuth flow).
- **`/dashboard/mappings`** — read-only role/tag overview for every linked account. Tags are fixed at connect time (`accounts.tag` is required from the moment the row is created), so there's nothing to edit here.
- **`/dashboard/logs`** — sync run history, and a "Run sync now" button (`POST /api/trigger-sync`).
- **`/auth/logout`** — clears the session.

## Tech stack

Cloudflare Workers · Hono (+ Hono JSX for the dashboard) · Cloudflare D1 · Cloudflare KV · Cron Triggers · Google Calendar API v3 · Google OAuth 2.0 (PKCE) · Vitest + `@cloudflare/vitest-pool-workers`

## Setup

1. `npm install`, then `npm run cf-typegen` to generate `worker-configuration.d.ts` from `wrangler.jsonc` (gitignored, regenerate after any binding change).
2. Copy `.env.example` to `.dev.vars` for local development. `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` must each be real `openssl rand -base64 32` output (32 raw bytes, base64-encoded) — anything else will fail to import as an AES-256/HMAC-SHA256 key, including in the test suite below. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` can be any placeholder string for now; `PRIMARY_ACCOUNT_EMAIL` is the one Google account that will be allowed to log into the dashboard.
3. `npm test` — runs the sync engine's test suite against a real local D1 instance with a mocked Google Calendar API. Doesn't need real Google credentials (the placeholders from step 2 are enough); good first check that the toolchain itself works before touching Google Cloud Console.
4. Create a Google Cloud Console project, enable the Calendar API, and create OAuth 2.0 credentials (Web application type), then put the real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` into `.dev.vars`. Under **Authorized redirect URIs**, add both `http://localhost:8787/auth/callback` (local dev) and `https://<your-worker-domain>/auth/callback` (production) — the worker derives the callback URL from the incoming request's own origin, so it must match exactly or Google will reject the exchange with `redirect_uri_mismatch`.
5. Provision the KV namespace and D1 database. Either:
   - `npx wrangler kv namespace create TOKEN_STORE` and `npx wrangler d1 create cal-replication-db` (always creates new resources), or
   - `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run provision` (or `npm run provision -- --dry-run` to only list what exists and report what would happen, no changes made) — finds an existing KV namespace/D1 database by name first and reuses it, only creating new ones if nothing matches. Useful if you're consolidating onto resources you already have, or scripting deployment for multiple accounts. Override the names it looks for with `KV_NAMESPACE_NAME`/`D1_DATABASE_NAME` env vars (defaults match `wrangler.jsonc`). The token needs "Workers KV Storage: Edit" and "D1: Edit" permissions (Read-only suffices for `--dry-run`) — the "Edit Cloudflare Workers" dashboard template plus D1:Edit covers this and the rest of deployment below in one token. Instead of env vars, you can put `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` in a gitignored `.env` file in the repo root (loaded automatically) — kept separate from `.dev.vars`, since this is a provisioning-time credential the deployed Worker itself never needs to see.

   **Then put the resulting IDs in `wrangler.local.jsonc`, never `wrangler.jsonc`.** Copy `wrangler.jsonc` to `wrangler.local.jsonc` (gitignored) and fill in your real `database_id`/`id` there — `wrangler.jsonc` itself stays placeholder-only so it's always safe to commit, for you and for anyone else deploying this project with their own resources. Pass every subsequent `wrangler`/`npm run` command `-c wrangler.local.jsonc` (or `--config wrangler.local.jsonc`) to use it, e.g. `npx wrangler deploy -c wrangler.local.jsonc`. The provisioning script above only ever prints the resolved IDs — it doesn't edit either config file itself, since a naive JSONC parse/write would risk stripping comments.
6. Set production secrets: `npx wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `PRIMARY_ACCOUNT_EMAIL` (add `-c wrangler.local.jsonc` if using that file).
7. Apply the D1 migration: `npm run db:migrate:local` (local dev D1, unaffected by any of this) / `npx wrangler d1 migrations apply DB --remote -c wrangler.local.jsonc` (real remote D1).
8. `npm run dev` locally, or `npx wrangler deploy -c wrangler.local.jsonc` to publish. Visit `/auth/login` to sign in as the primary account, then use the dashboard to connect secondary accounts.

## Security

No secrets are ever committed to this repository. Local development secrets live in `.dev.vars` (gitignored); production secrets are Cloudflare Worker bindings set via `wrangler secret put`. See `.env.example` for the required variable names.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for noncommercial use. Commercial use is not licensed by these terms; contact the licensor (see [LICENSE](LICENSE)) to discuss commercial terms.

## Support

Built and maintained by [Terry Sweetser](https://github.com/tcsweetser). If this project is useful to you, consider [buying me a coffee](https://buymeacoffee.com/terrysweetser) — or [hire me](https://github.com/IEISI-ORG).
