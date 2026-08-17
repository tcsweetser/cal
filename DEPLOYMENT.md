# Deployment Guide

End-to-end walkthrough from a fresh clone to a live production Worker. This expands on the [Setup](README.md#setup) section in the README with full detail on the Google Cloud Console side, verification checkpoints at each stage, and troubleshooting for the failure modes this project has actually hit.

Follow the steps in order — each one is a prerequisite for the next; skipping ahead (e.g. deploying before the D1 migration is applied) produces confusing errors downstream rather than a clean failure.

## 0. Prerequisites

- Node.js and npm installed.
- A Cloudflare account (free tier is enough — D1, KV, and Cron Triggers are all available on it).
- A Google account you're willing to designate as the app's `PRIMARY_ACCOUNT_EMAIL` (the one that can log into the dashboard).
- `git clone` this repo and `cd` into it.

## 1. Install and generate types

```bash
npm install
npm run cf-typegen
```

`cf-typegen` reads `wrangler.jsonc` and generates `worker-configuration.d.ts` (gitignored — regenerate this any time you add or rename a binding in `wrangler.jsonc`/`wrangler.local.jsonc`).

**Checkpoint**: `worker-configuration.d.ts` exists and `npx tsc --noEmit` runs without missing-type errors.

## 2. Local secrets

Copy `.env.example` to `.dev.vars`:

```bash
cp .env.example .dev.vars
```

Fill in:

- `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` — each must be real `openssl rand -base64 32` output (32 raw bytes, base64-encoded). Anything else fails to import as an AES-256-GCM / HMAC-SHA256 key, including inside the test suite.
  ```bash
  openssl rand -base64 32   # run twice, once per variable
  ```
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — placeholders are fine for now (step 4 below fills in the real values once they exist).
- `PRIMARY_ACCOUNT_EMAIL` — the Google account from step 0.
- `RESEND_API_TOKEN` / `CAL_FROM_ADDRESS` — only needed once the trusted-invite / booking features are exercised for real; a placeholder is fine until then (see the [Resend section](#6-email-resend-trusted-invite-emails) below).

**Checkpoint** (do this before touching Google Cloud Console — it isolates toolchain problems from OAuth problems):

```bash
npm test
```

This runs the full suite against a real local D1 instance with a mocked Google Calendar API and mocked Resend — no real Google or Resend credentials needed, the placeholders from above are enough. Should pass in full before proceeding.

## 3. Provision Cloudflare resources (KV + D1)

Two ways to do this — pick one:

**Option A — always create new:**
```bash
npx wrangler kv namespace create TOKEN_STORE
npx wrangler d1 create cal-replication-db
```

**Option B — reuse existing resources by name, only creating what's missing:**
```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run provision
# or, to preview with no changes made:
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run provision -- --dry-run
```
Override the names it searches for with `KV_NAMESPACE_NAME` / `D1_DATABASE_NAME` (defaults match `wrangler.jsonc`). Instead of exporting the two Cloudflare env vars inline, you can put them in a gitignored `.env` in the repo root — loaded automatically, kept separate from `.dev.vars` since this is a provisioning-time credential the deployed Worker itself never needs.

The token needs **Workers KV Storage: Edit** and **D1: Edit** (Read-only is enough for `--dry-run`). Cloudflare's built-in "Edit Cloudflare Workers" dashboard template plus D1:Edit covers this and every other step below with one token.

### Wire the IDs in — `wrangler.local.jsonc`, never `wrangler.jsonc`

```bash
cp wrangler.jsonc wrangler.local.jsonc
```

Put the real `database_id` (from D1) and `id` (from the KV namespace) into `wrangler.local.jsonc`. This file is gitignored — `wrangler.jsonc` itself stays placeholder-only so it's always safe to commit, for you and for anyone else deploying their own copy. Pass every subsequent `wrangler` / `npm run` command `-c wrangler.local.jsonc` (or `--config wrangler.local.jsonc`).

The provisioning script only ever *prints* the resolved IDs — it never edits either config file itself, to avoid a naive JSONC parse/write stripping comments.

**Checkpoint**: `npx wrangler deploy --dry-run -c wrangler.local.jsonc` succeeds and shows both bindings resolved to real (non-placeholder) IDs.

## 4. Google Cloud Console — OAuth setup

This is the step most worth doing carefully; a mismatched redirect URI is the single most common failure mode (`redirect_uri_mismatch` at the callback).

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (or select an existing one).
2. **APIs & Services → Library** — search for "Google Calendar API" and enable it.
3. **APIs & Services → OAuth consent screen**:
   - User Type: **External** (unless you have a Google Workspace org and want **Internal**).
   - App name, support email, developer contact — any values, this app is never published/verified since only `PRIMARY_ACCOUNT_EMAIL` and accounts you explicitly connect ever authenticate against it.
   - Scopes: none need adding here manually — the app requests the Calendar scope at runtime via the OAuth flow itself.
   - Test users: while the app is in "Testing" publishing status (the default, and fine indefinitely for personal use), add every Google account you intend to connect (primary + every secondary) as a test user here, or Google will reject their login attempt before it reaches this app at all.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs** — add both:
     - `http://localhost:8787/auth/callback` (local dev)
     - `https://<your-worker-domain>/auth/callback` (production — the actual `*.workers.dev` or custom domain your Worker will run on)
   - The app derives the callback URL from the incoming request's own origin, so these must match exactly — scheme, host, and path — or the token exchange fails with `redirect_uri_mismatch`.
5. Copy the generated **Client ID** and **Client Secret** into `.dev.vars` (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`), replacing the placeholders from step 2.

### Using Claude's browser automation for this step

If you're driving this setup through Claude Code with the `claude-in-chrome` extension connected, you can ask Claude to navigate the Cloud Console UI with you and click through consent-screen/credential creation live in your own logged-in browser session — useful for keeping the exact-match redirect URI correct on the first try, or for a screen-reader-style narration of a UI that changes fairly often. Two things worth knowing:

- It operates on **your** authenticated Google session, in a visible browser tab — it isn't a way to provision Google Cloud resources unattended or without your Google credentials in the loop. You stay present and can stop it any time (see the "Alerts and dialogs" caution — Claude is instructed not to trigger consent/confirm dialogs itself).
- It's meant for the click-path in this section only — the actual Client ID/Secret values still need to be copied by hand into `.dev.vars` / `wrangler secret put`, exactly as this doc describes; Claude's browser tool has no privileged way to read or write your secrets store.

In an unattended context (a scheduled loop, a background agent run with no one watching the browser), this step should stay manual — treat it the same as any other action with a real external side effect on a live account.

**Checkpoint**: `npm run dev`, visit `http://localhost:8787/auth/login`, and confirm you land on Google's real consent screen with the correct app name and no `redirect_uri_mismatch` error. You don't need to complete the grant yet if the real client secret isn't finalized — reaching a clean consent screen (not an error page) is the checkpoint.

## 5. Apply the D1 migration and set production secrets

```bash
# Local dev D1 (separate from remote, always safe to re-run):
npm run db:migrate:local

# Production secrets — one prompt per command:
npx wrangler secret put GOOGLE_CLIENT_ID -c wrangler.local.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.local.jsonc
npx wrangler secret put SESSION_SECRET -c wrangler.local.jsonc
npx wrangler secret put TOKEN_ENCRYPTION_KEY -c wrangler.local.jsonc
npx wrangler secret put PRIMARY_ACCOUNT_EMAIL -c wrangler.local.jsonc
npx wrangler secret put RESEND_API_TOKEN -c wrangler.local.jsonc
npx wrangler secret put CAL_FROM_ADDRESS -c wrangler.local.jsonc

# Real remote D1:
npx wrangler d1 migrations apply DB --remote -c wrangler.local.jsonc
```

`SESSION_SECRET` / `TOKEN_ENCRYPTION_KEY` for production should be **freshly generated**, not copied from `.dev.vars` — reusing a local dev key in production means anything encrypted under it in one environment could theoretically be decrypted in the other.

**Checkpoint**: `npx wrangler d1 migrations list DB --remote -c wrangler.local.jsonc` shows every migration file in `migrations/` as applied, none pending.

## 6. Email (Resend) — trusted-invite emails

The trusted-invite/booking features (appointment dialog, multi-party meeting planner) send verification-code emails via [Resend](https://resend.com).

1. Create a Resend account, verify a sending domain (or use their shared test domain while trying this out).
2. Generate an API token (Resend dashboard → API Keys).
3. Set `RESEND_API_TOKEN` and `CAL_FROM_ADDRESS` (an address on your verified domain) in both `.dev.vars` (for local testing) and as production secrets (step 5 above).

If you don't plan to use trusted-invite booking yet, placeholders are fine — those code paths simply won't be exercised until a real invite is created.

## 7. Deploy

```bash
npx wrangler deploy -c wrangler.local.jsonc
```

**Checkpoint**: visit `https://<your-worker-domain>/auth/login`, log in as `PRIMARY_ACCOUNT_EMAIL`, and confirm you land on `/dashboard`. From there, use **"Connect a new account"** to link your secondary calendars, each picking a `tag` (business / side_hustle / personal).

The Cron Trigger (10-minute sync) starts firing automatically once deployed — no separate step needed. Use `/dashboard/logs` and its **"Run sync now"** button to trigger a sync manually and confirm it completes without errors before waiting for the first scheduled tick.

## Continuous deployment (Workers Builds)

Once the manual deploy above works, you can connect this repo to [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) (Cloudflare's native Git integration) so pushes to `master` deploy automatically — no GitHub Actions needed. This mirrors the setup already used on this account's other Workers-with-bindings projects (`hitpacific-admin-worker`, `hitpacific-email-worker`, `hitpacific-workers`, `newsletter-worker`), with one difference: those live in **private** repos and commit their real D1/KV IDs straight into the tracked Wrangler config. `cal` is a **public** repo, so it keeps the placeholder/`wrangler.local.jsonc` split from the rest of this guide instead — the real IDs are supplied as secret build-trigger environment variables and assembled into `wrangler.local.jsonc` at build time by `scripts/write-ci-wrangler-config.js`, so they never touch git.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages), select the `cf-cal-replication` Worker → **Settings** → **Builds** → **Connect**.
2. Choose **GitHub**, authorize access to the `cal` repository if prompted (the Cloudflare GitHub App may already be installed on your account from other projects — if so, just add this repo to it).
3. Configure the **production trigger** (branch: `master`):
   - Build command: *(leave empty — same as this account's other Workers)*
   - Deploy command: `npm run ci:write-wrangler-config && npx wrangler deploy -c wrangler.local.jsonc`
4. Configure the **non-production branch trigger** (all other branches, for preview deployments):
   - Build command: *(leave empty)*
   - Deploy command: `npm run ci:write-wrangler-config && npx wrangler versions upload -c wrangler.local.jsonc`
5. On **both** triggers, add two **secret** environment variables (Settings → Builds → Environment variables — mark both "Encrypt"):
   - `D1_DATABASE_ID` — the real value from your `wrangler.local.jsonc`'s `d1_databases[0].database_id`
   - `KV_NAMESPACE_ID` — the real value from your `wrangler.local.jsonc`'s `kv_namespaces[0].id`
6. Push a commit to `master` to trigger the first build, and confirm it succeeds in the dashboard's build log before relying on it.

**Once this is live, every push to `master` deploys to production immediately** — there's no manual review gate in between. Make sure anything you push there is something you actually want live.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `redirect_uri_mismatch` at `/auth/callback` | The URI in Google Cloud Console credentials doesn't exactly match the Worker's actual origin (scheme/host/path). Re-check step 4 — production domain must match exactly, including `https://`. |
| Login redirects back to `/auth/login` in a loop | `PRIMARY_ACCOUNT_EMAIL` doesn't match the Google account you're logging in with, or that account isn't listed as a test user on the OAuth consent screen (step 4.3) while the app is in "Testing" status. |
| `npm test` fails on `atob()` of `undefined`/malformed input | `.dev.vars` doesn't exist or is missing `TOKEN_ENCRYPTION_KEY` — the test suite needs it to exist even though it never contacts real Google or Resend. Re-check step 2. |
| `wrangler deploy` succeeds but sync never runs | Confirm the Cron Trigger is present in `wrangler.local.jsonc` (copied from `wrangler.jsonc`, not hand-edited out) and check `/dashboard/logs` for `error`-status runs rather than assuming silence means nothing ran. |
| A newly-connected secondary account's events never replicate | Confirm it was granted consent for the Calendar API scope (not just basic profile) — if it's a *test user* under a Testing-status OAuth app, re-check step 4.3 lists it. |

## What this guide deliberately doesn't cover

- **CI/CD (deploy-on-push, test/prod branch structure)**: not yet decided for this project — see the open item in `TODO.md`. This guide covers a manual `wrangler deploy` only. Once a pipeline is chosen, this section should get a "Continuous deployment" addition rather than being written twice.
- **Custom domains**: Cloudflare's own [Custom Domains for Workers](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) docs cover attaching a domain you own; nothing in this app's own config needs to change beyond updating the redirect URI (step 4) and any hardcoded assumptions about the `*.workers.dev` origin (there are none currently).
