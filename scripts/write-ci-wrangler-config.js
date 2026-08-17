#!/usr/bin/env node
// Used only by Cloudflare Workers Builds (CI/CD on push). Materializes
// wrangler.local.jsonc from wrangler.jsonc by substituting the two
// placeholder tokens with real values supplied as secret build-trigger
// environment variables — so the real D1/KV IDs never touch the git repo,
// matching this project's standing rule against committing real resource
// IDs into tracked files. See DEPLOYMENT.md's "Continuous deployment"
// section for how to configure the trigger that runs this.
//
// Usage (set by the trigger's deploy_command, not run by hand normally):
//   D1_DATABASE_ID=... KV_NAMESPACE_ID=... node scripts/write-ci-wrangler-config.js

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = `${repoRoot}wrangler.jsonc`;
const outputPath = `${repoRoot}wrangler.local.jsonc`;

const substitutions = {
  "<YOUR_D1_DATABASE_ID>": "D1_DATABASE_ID",
  "<YOUR_KV_NAMESPACE_ID>": "KV_NAMESPACE_ID",
};

let config = readFileSync(sourcePath, "utf8");

for (const [placeholder, envVar] of Object.entries(substitutions)) {
  const value = process.env[envVar];
  if (!value) {
    console.error(`Missing required env var ${envVar} (needed to replace ${placeholder} from wrangler.jsonc).`);
    console.error("Set it as a secret environment variable on this Worker's Cloudflare Build trigger.");
    process.exit(1);
  }
  if (!config.includes(placeholder)) {
    console.error(`Expected placeholder ${placeholder} not found in wrangler.jsonc — has the config changed shape?`);
    process.exit(1);
  }
  config = config.split(placeholder).join(value);
}

writeFileSync(outputPath, config);
console.log(`Wrote ${outputPath} from wrangler.jsonc + secret build environment variables.`);
