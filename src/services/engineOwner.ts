// Fail-closed gate for CAL's replication engine. The engine_owner row in this database says which Worker runs
// the engine. CAL runs only when it is exactly "cal". Nothing in this Worker writes that row.

export type EngineOwner = "cal" | "mailmcp";
export const ENGINE_SELF: EngineOwner = "cal";

/** The stored owner if it is exactly "cal" or "mailmcp"; otherwise null. Never throws. */
export async function readEngineOwner(db: D1Database): Promise<EngineOwner | null> {
  try {
    const row = await db.prepare("SELECT value FROM engine_state WHERE key = 'engine_owner'").first<{ value: string }>();
    const value = row?.value;
    return value === "cal" || value === "mailmcp" ? value : null;
  } catch (err) {
    console.warn("engine_owner read failed", err instanceof Error ? `${err.name}: ${err.message}` : "unknown");
    return null;
  }
}

/** True only when the stored owner is exactly "cal". A missing table or row, a D1 error or any other value is false. */
export async function engineMayRun(db: D1Database): Promise<boolean> {
  return (await readEngineOwner(db)) === ENGINE_SELF;
}
