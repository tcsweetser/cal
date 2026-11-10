import { env } from "cloudflare:workers";
import { it, expect } from "vitest";
import { createEventMapping, deleteEventMapping, enqueueEvents } from "../src/db/schema";
import {
  createSeriesMapping,
  deleteSeriesMapping,
  findSeriesMapping,
  getCutoverState,
  getExceptionFingerprint,
  isEventQueued,
  isReplicaSeries,
  listLegacyCleanup,
  markCutoverReset,
  upsertExceptionFingerprint,
} from "../src/db/seriesSchema";
import { createTestAccount, createTestUser } from "./helpers/fixtures";
import { meteredDb } from "./helpers/meteredD1";

async function setup() {
  const userId = await createTestUser();
  const source = await createTestAccount(userId, "primary", { email: "src@example.com", accessToken: "tok-src" });
  const target = await createTestAccount(userId, "secondary", { email: "tgt@example.com", accessToken: "tok-tgt" });
  return { userId, source, target };
}

async function seedMapping(
  userId: string,
  sourceId: string,
  targetId: string,
  sourceEventId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await createEventMapping(env.DB, {
    id,
    userId,
    sourceAccountId: sourceId,
    sourceEventId,
    targetAccountId: targetId,
    targetEventId: `tgt-${id}`,
  });
  return id;
}

async function cleanupRows(sourceId: string) {
  const { results } = await env.DB
    .prepare("SELECT * FROM legacy_instance_cleanup WHERE source_account_id = ?")
    .bind(sourceId)
    .all<{ mapping_id: string; source_series_id: string; instance_date: string }>();
  return results;
}

it("a series mapping is found by source series and target, and isReplicaSeries recognises its target id", async () => {
  const { userId, source, target } = await setup();
  const id = crypto.randomUUID();
  await createSeriesMapping(env.DB, {
    id,
    userId,
    sourceAccountId: source.id,
    sourceSeriesId: "ser1",
    targetAccountId: target.id,
    targetSeriesId: "tser1",
    fingerprint: "fp1",
  });

  const found = await findSeriesMapping(env.DB, source.id, "ser1", target.id);
  expect(found?.id).toBe(id);
  expect(found?.target_series_id).toBe("tser1");
  expect(await findSeriesMapping(env.DB, source.id, "other", target.id)).toBeNull();
  expect(await isReplicaSeries(env.DB, target.id, "tser1")).toBe(true);
  expect(await isReplicaSeries(env.DB, target.id, "ser1")).toBe(false);
});

it("deleting a series mapping removes its exception rows", async () => {
  const { userId, source, target } = await setup();
  const id = crypto.randomUUID();
  await createSeriesMapping(env.DB, {
    id,
    userId,
    sourceAccountId: source.id,
    sourceSeriesId: "ser1",
    targetAccountId: target.id,
    targetSeriesId: "tser1",
    fingerprint: "fp1",
  });
  await upsertExceptionFingerprint(env.DB, id, "2026-11-24T00:00:00Z", "efp1");
  expect(await getExceptionFingerprint(env.DB, id, "2026-11-24T00:00:00Z")).toBe("efp1");
  await upsertExceptionFingerprint(env.DB, id, "2026-11-24T00:00:00Z", "efp2");
  expect(await getExceptionFingerprint(env.DB, id, "2026-11-24T00:00:00Z")).toBe("efp2");

  await deleteSeriesMapping(env.DB, id);

  expect(await getExceptionFingerprint(env.DB, id, "2026-11-24T00:00:00Z")).toBeNull();
});

it("markCutoverReset queues only this account's instance mappings, with their instance dates, and clears its sync position", async () => {
  const { userId, source, target } = await setup();
  const other = await createTestAccount(userId, "secondary", { email: "oth@example.com", accessToken: "tok-oth" });
  await seedMapping(userId, source.id, target.id, "ser1_20261124T000000Z");
  await seedMapping(userId, source.id, target.id, "ser1_20260901");
  await seedMapping(userId, source.id, target.id, "single1");
  await seedMapping(userId, other.id, target.id, "ser2_20261201T000000Z");
  for (const acct of [source, other]) {
    await env.DB
      .prepare("INSERT INTO sync_tokens (user_id, account_id, sync_token) VALUES (?, ?, 'tok')")
      .bind(userId, acct.id)
      .run();
    await env.DB
      .prepare("INSERT INTO pending_sync_tokens (user_id, account_id, sync_token) VALUES (?, ?, 'ptok')")
      .bind(userId, acct.id)
      .run();
  }

  await markCutoverReset(env.DB, userId, source.id);
  await markCutoverReset(env.DB, userId, source.id); // idempotent

  const rows = await cleanupRows(source.id);
  expect(rows.map((r) => r.instance_date).sort()).toEqual(["20260901", "20261124"]);
  expect(rows.every((r) => r.source_series_id === "ser1")).toBe(true);
  expect(await cleanupRows(other.id)).toHaveLength(0);

  const count = async (table: string, id: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).bind(id).first<{ n: number }>())!.n;
  expect(await count("sync_tokens", source.id)).toBe(0);
  expect(await count("pending_sync_tokens", source.id)).toBe(0);
  expect(await count("sync_tokens", other.id)).toBe(1);
  expect(await count("pending_sync_tokens", other.id)).toBe(1);

  const state = await getCutoverState(env.DB, source.id);
  expect(state?.reset_at).toBeTruthy();
  expect(state?.completed_at).toBeNull();
  expect(await getCutoverState(env.DB, other.id)).toBeNull();
});

it("deleting an event mapping removes its legacy cleanup row", async () => {
  const { userId, source, target } = await setup();
  const mappingId = await seedMapping(userId, source.id, target.id, "ser1_20261124T000000Z");
  await markCutoverReset(env.DB, userId, source.id);
  expect(await cleanupRows(source.id)).toHaveLength(1);

  await deleteEventMapping(env.DB, mappingId);

  expect(await cleanupRows(source.id)).toHaveLength(0);
});

it("listLegacyCleanup returns future instances first, then the most recent past ones", async () => {
  const { userId, source, target } = await setup();
  for (const date of ["20261201", "20261111", "20261020", "20260901"]) {
    await seedMapping(userId, source.id, target.id, `ser1_${date}`);
  }
  await markCutoverReset(env.DB, userId, source.id);

  const rows = await listLegacyCleanup(env.DB, source.id, "20261110", 3);

  expect(rows.map((r) => r.instance_date)).toEqual(["20261111", "20261201", "20261020"]);
});

it("per-tick lookups read a bounded number of rows", async () => {
  const { userId, source, target } = await setup();
  const mapStmt = env.DB.prepare(
    `INSERT INTO series_mappings
     (id, user_id, source_account_id, source_series_id, target_account_id, target_series_id, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, 'fp')`,
  );
  const ids = Array.from({ length: 300 }, () => crypto.randomUUID());
  await env.DB.batch(ids.map((id, i) => mapStmt.bind(id, userId, source.id, `ser${i}`, target.id, `tser${i}`)));
  const excStmt = env.DB.prepare(
    "INSERT INTO exception_mappings (series_mapping_id, original_start, fingerprint) VALUES (?, ?, 'e')",
  );
  await env.DB.batch(Array.from({ length: 300 }, (_, i) => excStmt.bind(ids[0], `2026-12-${i}`)));
  await enqueueEvents(
    env.DB,
    userId,
    source.id,
    Array.from({ length: 300 }, (_, i) => ({ id: `q${i}`, json: "{}" })),
  );

  const metered = meteredDb(env.DB);
  expect(await findSeriesMapping(metered.db, source.id, "ser150", target.id)).not.toBeNull();
  expect(await isReplicaSeries(metered.db, target.id, "tser150")).toBe(true);
  expect(await getExceptionFingerprint(metered.db, ids[0]!, "2026-12-150")).toBe("e");
  expect(await isEventQueued(metered.db, source.id, "q150")).toBe(true);

  expect(metered.calls).toHaveLength(4);
  for (const call of metered.calls) expect(call.rowsRead).toBeLessThan(5);
});
