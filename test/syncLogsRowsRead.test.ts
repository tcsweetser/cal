import { env } from "cloudflare:workers";
import { it, expect } from "vitest";
import { findActiveSyncLog, tryStartSyncLog } from "../src/db/schema";
import { createTestUser } from "./helpers/fixtures";

const HISTORY_ROWS = 300;
const MAX_ROWS_READ = 5;

// D1 bills rows scanned, not rows returned, and both lock checks run on every
// 10-minute tick, so a lock check that walks a user's sync_logs history gets
// more expensive every day (it reached 3.6M rows_read/day against the
// account's 5M limit in Nov 2026). Exercises the real helpers rather than a
// copy of their SQL so that rewriting a query can't quietly bring the scan
// back. first() hides meta, so the wrapper runs it through all() instead.
function meteredDb(db: D1Database): { db: D1Database; rowsRead: number[] } {
  const rowsRead: number[] = [];
  function wrap(stmt: D1PreparedStatement): unknown {
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      first: async () => {
        const result = await stmt.all();
        rowsRead.push(result.meta.rows_read);
        return result.results[0] ?? null;
      },
      run: async () => {
        const result = await stmt.run();
        rowsRead.push(result.meta.rows_read);
        return result;
      },
    };
  }
  return { db: { prepare: (sql: string) => wrap(db.prepare(sql)) } as unknown as D1Database, rowsRead };
}

async function seedCompletedRuns(userId: string): Promise<void> {
  const stmt = env.DB.prepare("INSERT INTO sync_logs (id, user_id, status) VALUES (?, ?, 'success')");
  await env.DB.batch(Array.from({ length: HISTORY_ROWS }, () => stmt.bind(crypto.randomUUID(), userId)));
}

it("findActiveSyncLog does not scan a user's completed runs", async () => {
  const userId = await createTestUser();
  await seedCompletedRuns(userId);
  const metered = meteredDb(env.DB);

  expect(await findActiveSyncLog(metered.db, userId)).toBeNull();

  expect(metered.rowsRead).toHaveLength(1);
  expect(metered.rowsRead[0]).toBeLessThan(MAX_ROWS_READ);
});

it("tryStartSyncLog does not scan a user's completed runs", async () => {
  const userId = await createTestUser();
  await seedCompletedRuns(userId);
  const metered = meteredDb(env.DB);

  expect(await tryStartSyncLog(metered.db, crypto.randomUUID(), userId)).toBe(true);

  expect(metered.rowsRead).toHaveLength(1);
  expect(metered.rowsRead[0]).toBeLessThan(MAX_ROWS_READ);
});

it("the lock is still seen when an in-progress run sits among completed runs", async () => {
  const userId = await createTestUser();
  await seedCompletedRuns(userId);
  const runningId = crypto.randomUUID();
  expect(await tryStartSyncLog(env.DB, runningId, userId)).toBe(true);

  expect((await findActiveSyncLog(env.DB, userId))?.id).toBe(runningId);
  expect(await tryStartSyncLog(env.DB, crypto.randomUUID(), userId)).toBe(false);
});
