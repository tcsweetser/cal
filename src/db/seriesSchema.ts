// D1 helpers for series replication and the per-account cutover from
// instance replication (migration 0010). Every per-tick lookup is by primary
// key or an indexed prefix, so its cost does not grow with table size.

export interface SeriesMappingRow {
  id: string;
  user_id: string;
  source_account_id: string;
  source_series_id: string;
  target_account_id: string;
  target_series_id: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
}

export interface LegacyCleanupRow {
  mapping_id: string;
  source_account_id: string;
  source_series_id: string;
  target_account_id: string;
  target_event_id: string;
  instance_date: string;
}

export interface CreateSeriesMappingInput {
  id: string;
  userId: string;
  sourceAccountId: string;
  sourceSeriesId: string;
  targetAccountId: string;
  targetSeriesId: string;
  fingerprint: string;
}

export function findSeriesMapping(
  db: D1Database,
  sourceAccountId: string,
  sourceSeriesId: string,
  targetAccountId: string,
): Promise<SeriesMappingRow | null> {
  return db
    .prepare(
      "SELECT * FROM series_mappings WHERE source_account_id = ? AND source_series_id = ? AND target_account_id = ?",
    )
    .bind(sourceAccountId, sourceSeriesId, targetAccountId)
    .first<SeriesMappingRow>();
}

export async function listSeriesMappingsForSource(
  db: D1Database,
  sourceAccountId: string,
  sourceSeriesId: string,
): Promise<SeriesMappingRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM series_mappings WHERE source_account_id = ? AND source_series_id = ?")
    .bind(sourceAccountId, sourceSeriesId)
    .all<SeriesMappingRow>();
  return results;
}

// Used only by 410 recovery: every series replicated from one account.
export async function listSeriesIdsForSourceAccount(db: D1Database, sourceAccountId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT source_series_id FROM series_mappings WHERE source_account_id = ?")
    .bind(sourceAccountId)
    .all<{ source_series_id: string }>();
  return results.map((r) => r.source_series_id);
}

export async function createSeriesMapping(db: D1Database, input: CreateSeriesMappingInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO series_mappings
       (id, user_id, source_account_id, source_series_id, target_account_id, target_series_id, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.sourceAccountId,
      input.sourceSeriesId,
      input.targetAccountId,
      input.targetSeriesId,
      input.fingerprint,
    )
    .run();
}

export async function updateSeriesFingerprint(db: D1Database, id: string, fingerprint: string): Promise<void> {
  await db
    .prepare(
      "UPDATE series_mappings SET fingerprint = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
    .bind(fingerprint, id)
    .run();
}

// exception_mappings rows go with it (ON DELETE CASCADE).
export async function deleteSeriesMapping(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM series_mappings WHERE id = ?").bind(id).run();
}

export async function isReplicaSeries(db: D1Database, targetAccountId: string, seriesId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM series_mappings WHERE target_account_id = ? AND target_series_id = ? LIMIT 1")
    .bind(targetAccountId, seriesId)
    .first();
  return row !== null;
}

export async function getExceptionFingerprint(
  db: D1Database,
  seriesMappingId: string,
  originalStart: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT fingerprint FROM exception_mappings WHERE series_mapping_id = ? AND original_start = ?")
    .bind(seriesMappingId, originalStart)
    .first<{ fingerprint: string }>();
  return row?.fingerprint ?? null;
}

export async function upsertExceptionFingerprint(
  db: D1Database,
  seriesMappingId: string,
  originalStart: string,
  fingerprint: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO exception_mappings (series_mapping_id, original_start, fingerprint) VALUES (?, ?, ?)
       ON CONFLICT (series_mapping_id, original_start) DO UPDATE SET fingerprint = excluded.fingerprint`,
    )
    .bind(seriesMappingId, originalStart, fingerprint)
    .run();
}

export async function deleteExceptionRows(db: D1Database, seriesMappingId: string): Promise<void> {
  await db.prepare("DELETE FROM exception_mappings WHERE series_mapping_id = ?").bind(seriesMappingId).run();
}

// Uses the unique (account_id, event_id) index on sync_queue.
export async function isEventQueued(db: D1Database, accountId: string, eventId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM sync_queue WHERE account_id = ? AND event_id = ? LIMIT 1")
    .bind(accountId, eventId)
    .first();
  return row !== null;
}

// --- Cutover from instance replication ---

export function getCutoverState(
  db: D1Database,
  accountId: string,
): Promise<{ reset_at: string | null; completed_at: string | null } | null> {
  return db
    .prepare("SELECT reset_at, completed_at FROM series_cutover WHERE account_id = ?")
    .bind(accountId)
    .first<{ reset_at: string | null; completed_at: string | null }>();
}

// Google event ids contain no "_"; only expanded instance ids do
// (<seriesId>_<YYYYMMDD[THHMMSSZ]>). One batch, so a crash cannot leave the
// sync position cleared without the cleanup rows queued.
export async function markCutoverReset(db: D1Database, userId: string, accountId: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO legacy_instance_cleanup
         (mapping_id, source_account_id, source_series_id, target_account_id, target_event_id, instance_date)
         SELECT id, source_account_id,
                substr(source_event_id, 1, instr(source_event_id, '_') - 1),
                target_account_id, target_event_id,
                substr(source_event_id, instr(source_event_id, '_') + 1, 8)
         FROM event_mappings
         WHERE source_account_id = ? AND instr(source_event_id, '_') > 0`,
      )
      .bind(accountId),
    db.prepare("DELETE FROM sync_tokens WHERE user_id = ? AND account_id = ?").bind(userId, accountId),
    db.prepare("DELETE FROM pending_sync_tokens WHERE user_id = ? AND account_id = ?").bind(userId, accountId),
    db
      .prepare(
        `INSERT INTO series_cutover (account_id, reset_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (account_id) DO UPDATE SET reset_at = excluded.reset_at`,
      )
      .bind(accountId),
  ]);
}

export async function markCutoverComplete(db: D1Database, accountId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO series_cutover (account_id, completed_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (account_id) DO UPDATE SET completed_at = excluded.completed_at`,
    )
    .bind(accountId)
    .run();
}

// Future instances first (soonest first), since those are the ones showing
// up as clutter; then, if room remains, the most recent past ones.
export async function listLegacyCleanup(
  db: D1Database,
  sourceAccountId: string,
  today: string,
  limit: number,
): Promise<LegacyCleanupRow[]> {
  const { results: future } = await db
    .prepare(
      `SELECT * FROM legacy_instance_cleanup
       WHERE source_account_id = ? AND instance_date >= ? ORDER BY instance_date ASC LIMIT ?`,
    )
    .bind(sourceAccountId, today, limit)
    .all<LegacyCleanupRow>();
  if (future.length >= limit) return future;
  const { results: past } = await db
    .prepare(
      `SELECT * FROM legacy_instance_cleanup
       WHERE source_account_id = ? AND instance_date < ? ORDER BY instance_date DESC LIMIT ?`,
    )
    .bind(sourceAccountId, today, limit - future.length)
    .all<LegacyCleanupRow>();
  return [...future, ...past];
}

export async function deleteLegacyCleanupRow(db: D1Database, mappingId: string): Promise<void> {
  await db.prepare("DELETE FROM legacy_instance_cleanup WHERE mapping_id = ?").bind(mappingId).run();
}

// Rollback only, not per tick.
export async function listSeriesMappingsForUser(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<SeriesMappingRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM series_mappings WHERE user_id = ? LIMIT ?")
    .bind(userId, limit)
    .all<SeriesMappingRow>();
  return results;
}

export async function countSeriesMappingsForUser(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM series_mappings WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
