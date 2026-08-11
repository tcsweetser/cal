# CAL — Calendar Replication & Anti-Double-Booking System

Open-source, edge-deployed system that keeps multiple Google Calendar accounts (a primary/day-job calendar plus any number of secondary accounts — business, side-hustle, personal) aware of each other's busy time, without leaking event details across contexts. Runs on Cloudflare Workers.

## Status

🚧 **Planning stage.** Architecture, data model, and sync algorithm are finalized and audited (see below). Implementation has not started — there is no `src/`, no `wrangler.jsonc`, and nothing runnable yet. Setup instructions below describe the *planned* deployment process and will not work until Phase 1–2 land.

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

## Setup (once implemented)

1. Create a Google Cloud Console project, enable the Calendar API, and create OAuth 2.0 credentials (Web application type).
2. `npx wrangler kv namespace create TOKEN_STORE` and `npx wrangler d1 create cal-replication-db`, then fill the resulting IDs into `wrangler.jsonc`.
3. Copy `.env.example` to `.dev.vars` for local development.
4. Set production secrets: `npx wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`.
5. Apply the D1 migration: `npx wrangler d1 migrations apply DB`.
6. `npx wrangler dev` locally, or `npx wrangler deploy` to publish.

## Security

No secrets are ever committed to this repository. Local development secrets live in `.dev.vars` (gitignored); production secrets are Cloudflare Worker bindings set via `wrangler secret put`. See `.env.example` for the required variable names.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for noncommercial use. Commercial use is not licensed by these terms; contact the licensor (see [LICENSE](LICENSE)) to discuss commercial terms.
