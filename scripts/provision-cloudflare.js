#!/usr/bin/env node
// Idempotent setup helper: finds-or-creates the KV namespace and D1 database
// this Worker needs, by name, then prints the wrangler.jsonc values to paste
// in. Point it at ANY Cloudflare account via standard API auth — lets a
// deployer reuse existing resources (by name) instead of always creating
// fresh ones, without hand-editing wrangler.jsonc through the dashboard.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/provision-cloudflare.js
//
// Optional overrides (both already match wrangler.jsonc's defaults):
//   KV_NAMESPACE_NAME=TOKEN_STORE
//   D1_DATABASE_NAME=cal-replication-db
//
// This only ever looks up or creates resources — it never modifies
// wrangler.jsonc itself (which is JSONC with comments; a naive JSON
// read/write would silently strip them). Paste the printed values in by hand.

const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const KV_NAME = process.env.KV_NAMESPACE_NAME || "TOKEN_STORE";
const D1_NAME = process.env.D1_DATABASE_NAME || "cal-replication-db";

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
    console.log(`Found existing KV namespace "${title}" (${existing.id}) — reusing it.`);
    return existing.id;
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
    console.log(`Found existing D1 database "${name}" (${existing.uuid}) — reusing it.`);
    return existing.uuid;
  }
  console.log(`Creating new D1 database "${name}"...`);
  const created = await cf("/d1/database", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return created.uuid;
}

const kvId = await findOrCreateKvNamespace(KV_NAME);
const d1Id = await findOrCreateD1Database(D1_NAME);

console.log("\nPaste these values into wrangler.jsonc:\n");
console.log(`  kv_namespaces[0].id            = "${kvId}"`);
console.log(`  d1_databases[0].database_id    = "${d1Id}"`);
console.log(`  d1_databases[0].database_name  = "${D1_NAME}"`);
console.log(`\nOptionally, account_id (top level, not required if you only ever deploy from an account with one Cloudflare account): "${ACCOUNT_ID}"`);
console.log("\nThen: npm run db:migrate:remote && npx wrangler deploy");
