-- Google profile display info (Phase 9 UI redesign, task_plan.md — sidebar
-- identity tile). Both nullable: existing rows predate this column, and a
-- Google account can have no `name`/`picture` claim at all. Populated from
-- the `userinfo` endpoint's `name`/`picture` fields (routes/auth.ts), which
-- requires the `profile` scope added alongside this migration — re-fetched
-- and upserted on every login, not just account creation, so a changed
-- Google photo/name stays current here.
ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE users ADD COLUMN picture_url TEXT;
