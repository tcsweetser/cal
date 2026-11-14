import { env } from "cloudflare:workers";

/** Writes the engine owner row in the test database. Never use against a real database. */
export const setOwner = (value: string) =>
  env.DB.prepare(
    "INSERT INTO engine_state (key, value) VALUES ('engine_owner', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(value)
    .run();

/** A D1 stand-in whose every call throws, as when the engine_state table is missing. */
export const broken = {
  prepare() {
    throw new Error("D1_ERROR: no such table: engine_state");
  },
} as unknown as D1Database;

/** A D1 stand-in that answers every first() with the given stored value. */
export const answering = (value: string) =>
  ({ prepare: () => ({ first: async () => ({ value }) }) }) as unknown as D1Database;
