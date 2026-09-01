# Lovable prototype — test plan (paused, not started)

Status: **pinned at user's request on 2026-09-02, before any Lovable project was created.** No credits spent
yet. This doc is what a session (this one resumed, or a fresh one) needs to actually run the prototype when
we pick this back up. Read `task_plan.md` and `options.md` first for the surrounding decision context.

## Why this test exists

`options.md`'s open question #5 / `notes.md`'s "Cost at scale" section both flag the same unverified claim:
Supabase's `pg_cron` + Edge Functions are *assumed* comparable to Cloudflare's Cron Triggers for CAL's sync
workload, but this has only been checked against docs, never run. The user explicitly wants Lovable derisked
hands-on ("exploring lovable is part of this process"), not just read about.

## Preconditions (already done, still true when resuming)

- Lovable plugin installed (`/plugin install lovable@claude-plugins-official`) and MCP OAuth completed —
  authenticated as `terry@ieisi.org`, workspace `Terry's Lovable` (id `3c6a23c85e485dd63f0d`), `max_mode: true`.
  If the MCP connection has since expired/disconnected, re-run `mcp__plugin_lovable_lovable__authenticate`
  first (see this session's transcript for the flow — Chrome-based OAuth, ~2 min).
- Available Lovable MCP tools (as of this session): `create_project`, `send_message`, `get_diff`,
  `list_projects`, `render_project_widget`, `enable_database`, `get_database_status`, `query_database`,
  `add_connector`, `list_connectors`, `deploy_project`, plus knowledge/skill tools. Full list was surfaced via
  ToolSearch after auth completed — re-run `ToolSearch("select:mcp__plugin_lovable_lovable__create_project,
  mcp__plugin_lovable_lovable__send_message,mcp__plugin_lovable_lovable__get_diff,mcp__plugin_lovable_lovable__render_project_widget,
  mcp__plugin_lovable_lovable__list_workspaces")` if starting a fresh session.

## Scope — deliberately minimal

**One throwaway Lovable project**, not a CAL port attempt. Single question to answer: *does a scheduled job
on Supabase (via Lovable) actually fire reliably on a short interval, and what does the process of setting
that up look like?* Do not try to replicate CAL's full sync engine here.

## Steps

1. `list_workspaces` / use `get_me`'s result (already have workspace id `3c6a23c85e485dd63f0d`) — confirm
   still valid.
2. `create_project` with `workspace_id` set and an `initial_message` describing: a minimal app with one
   Supabase Edge Function, scheduled to run every N minutes (use 5 or 10 to mirror CAL's real 10-min tick),
   that calls a trivial external HTTP endpoint (e.g. a public test API, or just `httpbin.org`) and writes a
   timestamped row to a Postgres table each time it fires. Use `plan_mode=true` first to see Lovable's
   proposed approach before it writes code — cheaper to review the plan than to iterate after code exists.
3. `render_project_widget` with the returned `projectId` to watch build progress.
4. Once built, leave it running for at least **60–90 minutes** (i.e., 6-9 ticks at a 10-min interval) — a
   single successful tick doesn't tell you much about reliability; drift, skipped ticks, or silent failures
   only show up over several.
5. `query_database` against the logged-ticks table to check: did it fire on schedule, how consistent was the
   interval, any gaps.
6. Check the Supabase project's own dashboard/logs (via `get_database_status` or a self-managed Supabase
   connection if one gets attached) for anything Lovable's own tools don't surface — e.g. actual Edge
   Function invocation duration, cold-start behavior.
7. Note how many Lovable credits the whole exercise consumed (visible via `get_me` or the workspace) against
   the Pro plan's 200/mo allotment, to sanity-check the "handful of credits" estimate given to the user.

## Success / failure criteria

- **Pass**: ticks fire within a reasonable tolerance of the configured interval (no multi-tick gaps, no
  silent stop), and the setup process (declaring the schedule, wiring the Edge Function) is straightforward
  enough that CAL's real sync engine looks portable onto the same mechanism.
- **Fail / needs more digging**: missed ticks, an interval that drifts, a hard invocation-duration ceiling
  that a real Google Calendar sync call (network-bound, sometimes slow) would risk hitting, or friction in
  Lovable's own tooling that would make the port meaningfully harder than expected.
- Either outcome gets written back into `notes.md`'s "Cost at scale" / capability section and folds into a
  revised recommendation in `options.md` (Phase 8 in `task_plan.md`).

## Afterward

- Decide whether to delete the throwaway project or keep it around as a reference — ask the user, don't
  delete unilaterally (it's a Lovable-side resource, not a local file, but the same "don't destroy things
  without checking" instinct applies).
- Resume `task_plan.md` Phase 7 → 8.

## Explicitly not in scope for this prototype

- Not attempting Stripe integration here — that's a separate, lower-risk unknown (Lovable's own docs already
  describe it as a first-class integration); no need to spend credits proving it works before it's the
  actual next step.
- Not attempting the encrypted-token-storage pattern or the HTML-only booking-flow constraint here — both are
  design questions to work through on paper first (per-option in `options.md`), not things a throwaway cron
  test would usefully derisk.
