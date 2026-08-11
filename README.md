# CAL — Calendar Replication & Anti-Double-Booking System

Open-source, edge-deployed system that keeps multiple Google Calendar accounts (a primary/day-job calendar plus any number of secondary accounts — business, side-hustle, personal) aware of each other's busy time, without leaking event details across contexts. Runs on Cloudflare Workers.

## Status

🚧 **Phase 3 of 6 complete** (skeleton, DB schema, Google OAuth + encrypted token storage + sessions). No sync engine yet — connecting accounts works, but nothing replicates between calendars until Phase 4. Google Cloud/KV/D1 resources have not been provisioned in any real environment, so the setup steps below are written but unexercised end-to-end (a real Google OAuth grant hasn't been tested — see `task_plan.md` Phase 3 for exactly what has and hasn't been verified).

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

## Tech stack (planned)

Cloudflare Workers · Hono · Cloudflare D1 · Cloudflare KV · Cron Triggers · Google Calendar API v3 · Google OAuth 2.0 (PKCE)

## Setup (partially implemented — see Status)

1. `npm install`, then `npm run cf-typegen` to generate `worker-configuration.d.ts` from `wrangler.jsonc` (gitignored, regenerate after any binding change).
2. Create a Google Cloud Console project, enable the Calendar API, and create OAuth 2.0 credentials (Web application type). Under **Authorized redirect URIs**, add both `http://localhost:8787/auth/callback` (local dev) and `https://<your-worker-domain>/auth/callback` (production) — the worker derives the callback URL from the incoming request's own origin, so it must match exactly or Google will reject the exchange with `redirect_uri_mismatch`.
3. `npx wrangler kv namespace create TOKEN_STORE` and `npx wrangler d1 create cal-replication-db`, then fill the resulting IDs into `wrangler.jsonc`.
4. Copy `.env.example` to `.dev.vars` for local development. `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` must each be real `openssl rand -base64 32` output (32 raw bytes, base64-encoded) — anything else will fail to import as an AES-256/HMAC-SHA256 key.
5. Set production secrets: `npx wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `PRIMARY_ACCOUNT_EMAIL`.
6. Apply the D1 migration: `npm run db:migrate:local` / `npm run db:migrate:remote`.
7. `npm run dev` locally, or `npm run deploy` to publish. Visit `/auth/login` to sign in as the primary account.

## Security

No secrets are ever committed to this repository. Local development secrets live in `.dev.vars` (gitignored); production secrets are Cloudflare Worker bindings set via `wrangler secret put`. See `.env.example` for the required variable names.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for noncommercial use. Commercial use is not licensed by these terms; contact the licensor (see [LICENSE](LICENSE)) to discuss commercial terms.
