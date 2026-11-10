// Rollback path for series replication: while the KV flag is set, ticks and
// manual syncs delete replica series instead of syncing.
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import worker from "../src/index";
import { createSession, SESSION_COOKIE } from "../src/middleware/auth";
import { setPendingSyncToken, setSyncToken } from "../src/db/schema";
import { countSeriesMappingsForUser, createSeriesMapping, markCutoverComplete } from "../src/db/seriesSchema";
import { storeTokens } from "../src/services/tokenManager";
import { runSeriesRollbackBatch, SERIES_ROLLBACK_KV_KEY } from "../src/services/seriesRollback";
import { MAX_CALENDAR_API_CALLS_PER_RUN } from "../src/services/syncShared";
import { GoogleCalendarMock } from "./helpers/googleMock";
import { seriesSetup, type SeriesSetup } from "./helpers/seriesEvents";

let mock: GoogleCalendarMock;
let fetchSpy: Mock;
let seq = 0;

beforeEach(() => {
  mock = new GoogleCalendarMock();
  fetchSpy = mock.install() as unknown as Mock;
});

afterEach(async () => {
  await env.TOKEN_STORE.delete(SERIES_ROLLBACK_KV_KEY);
});

async function seedSeries(s: SeriesSetup, targetId = s.primary.id): Promise<string> {
  const targetSeriesId = `replica-series-${++seq}`;
  await createSeriesMapping(env.DB, {
    id: crypto.randomUUID(),
    userId: s.userId,
    sourceAccountId: s.biz.id,
    sourceSeriesId: `src-series-${seq}`,
    targetAccountId: targetId,
    targetSeriesId,
    fingerprint: "fp",
  });
  return targetSeriesId;
}

async function stateRows(s: SeriesSetup): Promise<number> {
  const ids = [s.primary.id, s.biz.id, s.side.id];
  let n = 0;
  for (const table of ["sync_tokens", "pending_sync_tokens", "series_cutover"]) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE account_id IN (?, ?, ?)`,
    )
      .bind(...ids)
      .first<{ n: number }>();
    n += row!.n;
  }
  return n;
}

function listCalls(): number {
  return fetchSpy.mock.calls.filter(([input, init]) => {
    const url = new URL(String(input));
    return url.pathname.endsWith("/events") && ((init as RequestInit | undefined)?.method ?? "GET") === "GET";
  }).length;
}

it("while the rollback flag is set, ticks remove replica series and don't sync", async () => {
  const s = await seriesSetup();
  const ids = [await seedSeries(s), await seedSeries(s, s.side.id)];
  await env.TOKEN_STORE.put(SERIES_ROLLBACK_KV_KEY, "1");

  await runInDurableObject(env.SYNC_SCHEDULER.getByName("rollback-tick"), (instance) => instance.tick());

  expect(mock.deletes.filter((d) => ids.includes(d.eventId)).map((d) => d.eventId).sort()).toEqual([...ids].sort());
  expect(listCalls()).toBe(0);
  expect(await countSeriesMappingsForUser(env.DB, s.userId)).toBe(0);
});

it("rollback removes at most one budget of series per tick and reports what remains", async () => {
  const s = await seriesSetup();
  const total = MAX_CALENDAR_API_CALLS_PER_RUN + 5;
  for (let i = 0; i < total; i++) await seedSeries(s);
  await markCutoverComplete(env.DB, s.biz.id);

  const first = await runSeriesRollbackBatch(env, s.userId);

  expect(first).toEqual({ removed: MAX_CALENDAR_API_CALLS_PER_RUN, remaining: 5 });
  expect(mock.deletes).toHaveLength(MAX_CALENDAR_API_CALLS_PER_RUN);
  // Not finished, so the sync state is kept.
  expect(await stateRows(s)).toBe(1);

  const second = await runSeriesRollbackBatch(env, s.userId);
  expect(second).toEqual({ removed: 5, remaining: 0 });
});

it("when the last series is gone, sync positions and cutover state are cleared", async () => {
  const s = await seriesSetup();
  await seedSeries(s);
  await setSyncToken(env.DB, s.userId, s.biz.id, "tok");
  await setPendingSyncToken(env.DB, s.userId, s.side.id, "pending");
  await markCutoverComplete(env.DB, s.biz.id);
  expect(await stateRows(s)).toBe(3);

  expect(await runSeriesRollbackBatch(env, s.userId)).toEqual({ removed: 1, remaining: 0 });

  expect(await stateRows(s)).toBe(0);
  // Idempotent while the flag stays set.
  expect(await runSeriesRollbackBatch(env, s.userId)).toEqual({ removed: 0, remaining: 0 });
});

it("a 400 on a delete drops the mapping and the batch carries on", async () => {
  const s = await seriesSetup();
  await seedSeries(s);
  await seedSeries(s);
  mock.failDeletes(400);

  expect(await runSeriesRollbackBatch(env, s.userId)).toEqual({ removed: 2, remaining: 0 });
});

it("a revoked target drops its mapping without a call and the batch carries on", async () => {
  const s = await seriesSetup();
  await seedSeries(s, s.side.id);
  const kept = await seedSeries(s, s.primary.id);
  // Expired token plus a refresh Google refuses: RefreshTokenInvalidError.
  await storeTokens(env, s.side.id, { access_token: "stale", refresh_token: "gone", expires_at: 0 });
  const mocked = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith("https://oauth2.googleapis.com/token")
      ? Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))
      : mocked(input, init),
  );

  expect(await runSeriesRollbackBatch(env, s.userId)).toEqual({ removed: 2, remaining: 0 });
  expect(mock.deletes.map((d) => d.eventId)).toEqual([kept]);
  vi.unstubAllGlobals();
});

it("any other failure stops the batch and keeps the mapping for the next tick", async () => {
  const s = await seriesSetup();
  await seedSeries(s);
  await seedSeries(s);
  mock.failDeletes(500);

  expect(await runSeriesRollbackBatch(env, s.userId)).toEqual({ removed: 0, remaining: 2 });
  // Stopped at the first failure rather than trying the second.
  // (googleFetch retries a 500, so count the distinct events tried.)
  const tried = fetchSpy.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
    .map(([input]) => String(input));
  expect(new Set(tried).size).toBe(1);
});

it("the rollback routes require a signed-in owner", async () => {
  const headers = { Accept: "application/json" };
  const post = await worker.fetch(
    new Request("https://cal.test/api/admin/series-rollback", { method: "POST", headers }),
    env,
  );
  const get = await worker.fetch(new Request("https://cal.test/api/admin/series-rollback", { headers }), env);
  expect(post.status).toBe(401);
  expect(get.status).toBe(401);
  expect(await env.TOKEN_STORE.get(SERIES_ROLLBACK_KV_KEY)).toBeNull();
});

it("POST sets the flag and GET reports it with the remaining count", async () => {
  const s = await seriesSetup();
  await seedSeries(s);
  const cookie = `${SESSION_COOKIE}=${await createSession(env, s.userId, "me@example.com")}`;

  const before = await worker.fetch(
    new Request("https://cal.test/api/admin/series-rollback", { headers: { cookie } }),
    env,
  );
  expect(await before.json()).toEqual({ active: false, remaining: 1 });

  const post = await worker.fetch(
    new Request("https://cal.test/api/admin/series-rollback", { method: "POST", headers: { cookie } }),
    env,
  );
  expect(await post.json()).toEqual({ status: "rollback started" });

  const after = await worker.fetch(
    new Request("https://cal.test/api/admin/series-rollback", { headers: { cookie } }),
    env,
  );
  expect(await after.json()).toEqual({ active: true, remaining: 1 });
});

it("a manual sync during rollback removes series instead of syncing", async () => {
  const s = await seriesSetup();
  const id = await seedSeries(s);
  await env.TOKEN_STORE.put(SERIES_ROLLBACK_KV_KEY, "1");
  const cookie = `${SESSION_COOKIE}=${await createSession(env, s.userId, "me@example.com")}`;

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://cal.test/api/trigger-sync", { method: "POST", headers: { cookie } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  expect(res.status).toBe(200);
  expect(mock.deletes.map((d) => d.eventId)).toEqual([id]);
  expect(listCalls()).toBe(0);
  expect(await countSeriesMappingsForUser(env.DB, s.userId)).toBe(0);
});
