#!/usr/bin/env node
// Idempotent setup helper: finds-or-creates the KV namespace and D1 database
// this Worker needs, by name, then prints the wrangler.local.jsonc values to
// paste in. Point it at ANY Cloudflare account via standard API auth — lets a
// deployer reuse existing resources (by name) instead of always creating
// fresh ones, without hand-editing wrangler.local.jsonc through the dashboard.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/provision-cloudflare.js
//
// Or put the same variables in a gitignored `.env` file in the repo root
// (separate from `.dev.vars`, which is the deployed Worker's own runtime
// secrets — this script's credentials aren't part of that and shouldn't be
// mixed in) — it's loaded automatically if present:
//   CLOUDFLARE_API_TOKEN=...
//   CLOUDFLARE_ACCOUNT_ID=...
//
// Add --dry-run (or DRY_RUN=1) to only list and report what would happen —
// no POST calls are made, nothing is created. A dry-run token only needs
// "Workers KV Storage: Read" and "D1: Read" permissions, not Edit.
//
// Optional overrides (both already match wrangler.jsonc's defaults):
//   KV_NAMESPACE_NAME=TOKEN_STORE
//   D1_DATABASE_NAME=cal-replication-db
//
// This only ever looks up or creates resources — it never modifies
// wrangler.jsonc itself (which is JSONC with comments; a naive JSON
// read/write would silently strip them). Paste the printed values in by hand.

try {
  process.loadEnvFile(".env");
} catch (err) {
  if (err.code !== "ENOENT") throw err; // a malformed .env should fail loudly, a missing one shouldn't
}

const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const KV_NAME = process.env.KV_NAMESPACE_NAME || "TOKEN_STORE";
const D1_NAME = process.env.D1_DATABASE_NAME || "cal-replication-db";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

if (!API_TOKEN || !ACCOUNT_ID) {
  console.error("Missing CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID environment variables.");
  console.error(
    "Create a token at https://dash.cloudflare.com/profile/api-tokens with 'Workers KV Storage: Edit' " +
      "and 'D1: Edit' permissions, and find your account ID on the Cloudflare dashboard's right sidebar.",
  );
  process.exit(1);
}

const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

async function cf(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`Cloudflare API error on ${options.method ?? "GET"} ${path}: ${JSON.stringify(data.errors)}`);
  }
  return data.result;
}

async function findOrCreateKvNamespace(title) {
  const namespaces = await cf("/storage/kv/namespaces");
  const existing = namespaces.find((n) => n.title === title);
  if (existing) {
    console.log(`Found existing KV namespace "${title}" (${existing.id}) — would reuse it.`);
    return existing.id;
  }
  if (DRY_RUN) {
    console.log(`No KV namespace named "${title}" — would create one (skipped, --dry-run).`);
    return "<would-be-created>";
  }
  console.log(`Creating new KV namespace "${title}"...`);
  const created = await cf("/storage/kv/namespaces", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return created.id;
}

async function findOrCreateD1Database(name) {
  const databases = await cf("/d1/database");
  const existing = databases.find((d) => d.name === name);
  if (existing) {
    console.log(`Found existing D1 database "${name}" (${existing.uuid}) — would reuse it.`);
    return existing.uuid;
  }
  if (DRY_RUN) {
    console.log(`No D1 database named "${name}" — would create one (skipped, --dry-run).`);
    return "<would-be-created>";
  }
  console.log(`Creating new D1 database "${name}"...`);
  const created = await cf("/d1/database", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return created.uuid;
}

if (DRY_RUN) console.log("--dry-run: listing only, nothing will be created.\n");

const kvId = await findOrCreateKvNamespace(KV_NAME);
const d1Id = await findOrCreateD1Database(D1_NAME);

if (DRY_RUN) {
  console.log("\nDry run complete — nothing was created or modified. Re-run without --dry-run to provision for real.");
} else {
  console.log("\nPaste these values into wrangler.local.jsonc (copy wrangler.jsonc to that gitignored");
  console.log("file first if you haven't already — never put real resource IDs in wrangler.jsonc itself,");
  console.log("it stays a placeholder template so it's always safe to commit):\n");
  console.log(`  kv_namespaces[0].id            = "${kvId}"`);
  console.log(`  d1_databases[0].database_id    = "${d1Id}"`);
  console.log(`  d1_databases[0].database_name  = "${D1_NAME}"`);
  console.log(`\nOptionally, account_id (top level, not required if you only ever deploy from an account with one Cloudflare account): "${ACCOUNT_ID}"`);
  console.log("\nThen: npx wrangler d1 migrations apply DB --remote -c wrangler.local.jsonc && npx wrangler deploy -c wrangler.local.jsonc");
}
