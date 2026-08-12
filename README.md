# CAL — Calendar Replication & Anti-Double-Booking System

Open-source, edge-deployed system that keeps multiple Google Calendar accounts (a primary/day-job calendar plus any number of secondary accounts — business, side-hustle, personal) aware of each other's busy time, without leaking event details across contexts. Runs on Cloudflare Workers.

## Status

✅ **Feature-complete (Phase 6 of 6).** Skeleton, DB schema, Google OAuth + encrypted token storage + sessions, the sync engine and cron handler, and the dashboard are all built and verified. A fresh `git clone` of this repo (`npm install` → apply the migration → `npm test` → `wrangler dev`) has been confirmed to work end to end, including the full redirect chain from `/` through to Google's real OAuth consent screen. The one thing not exercised in this development environment is an actual Google OAuth consent-screen *grant* (no real Google Cloud Console credentials available here) — everything before and after that one step is verified against real local infrastructure. See `task_plan.md` for exactly what's been tested at each phase.

Full implementation plan and progress tracking: [`task_plan.md`](task_plan.md).

## How it works

- **Roles**: exactly one `primary` account (your main calendar, also the dashboard login), and at least one `secondary` account. Every secondary account carries a required `tag` — `business`, `side_hustle`, or `personal` — used only as a dashboard label; it never changes sync behavior.
- **Sync topology** (single-hop fan-out, no intermediary hops):
  - Secondary → Primary: replicated as `"Busy"`
  - Primary → every Secondary: replicated as `"Personal Time"`
  - Secondary → every other Secondary: replicated as `"Busy"`
- Replicated events strip all identifying detail (no title, description, attendees, or location) — only free/busy status crosses calendars.
- A background sync runs on a 10-minute Cron Trigger; deletions and edits (including flipping an event from busy to free) propagate automatically.
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
5. Provision the KV namespace and D1 database, then fill the resulting IDs into `wrangler.jsonc`. Either:
   - `npx wrangler kv namespace create TOKEN_STORE` and `npx wrangler d1 create cal-replication-db` (always creates new resources), or
   - `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run provision` — finds an existing KV namespace/D1 database by name first and reuses it, only creating new ones if nothing matches. Useful if you're consolidating onto resources you already have, or scripting deployment for multiple accounts. Override the names it looks for with `KV_NAMESPACE_NAME`/`D1_DATABASE_NAME` env vars (defaults match `wrangler.jsonc`). The token needs "Workers KV Storage: Edit" and "D1: Edit" permissions. It only ever prints the resolved IDs — it doesn't edit `wrangler.jsonc` itself, since that would risk stripping the file's comments.
6. Set production secrets: `npx wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `PRIMARY_ACCOUNT_EMAIL`.
7. Apply the D1 migration: `npm run db:migrate:local` / `npm run db:migrate:remote`.
8. `npm run dev` locally, or `npm run deploy` to publish. Visit `/auth/login` to sign in as the primary account, then use the dashboard to connect secondary accounts.

## Security

No secrets are ever committed to this repository. Local development secrets live in `.dev.vars` (gitignored); production secrets are Cloudflare Worker bindings set via `wrangler secret put`. See `.env.example` for the required variable names.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for noncommercial use. Commercial use is not licensed by these terms; contact the licensor (see [LICENSE](LICENSE)) to discuss commercial terms.
