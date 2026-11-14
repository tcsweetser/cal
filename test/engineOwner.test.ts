import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { engineMayRun, readEngineOwner } from "../src/services/engineOwner";
import { answering, broken, setOwner } from "./helpers/engineOwner";
import { meteredDb } from "./helpers/meteredD1";

afterEach(() => setOwner("cal"));

it("the migration leaves the owner as cal", async () => {
  expect(await readEngineOwner(env.DB)).toBe("cal");
  expect(await engineMayRun(env.DB)).toBe(true);
});

it("stops when the owner is mailmcp", async () => {
  await setOwner("mailmcp");
  expect(await engineMayRun(env.DB)).toBe(false);
});

it("fails closed when the row is missing, the table is missing, or the value is not exact", async () => {
  await env.DB.prepare("DELETE FROM engine_state WHERE key = 'engine_owner'").run();
  expect(await engineMayRun(env.DB)).toBe(false);
  expect(await engineMayRun(broken)).toBe(false);
  for (const v of ["CAL", " cal", "both"]) expect(await engineMayRun(answering(v))).toBe(false);
});

it("the read costs one row", async () => {
  const m = meteredDb(env.DB);
  await readEngineOwner(m.db);
  expect(m.calls).toHaveLength(1);
  expect(m.calls[0]!.rowsRead).toBeLessThanOrEqual(1);
});
