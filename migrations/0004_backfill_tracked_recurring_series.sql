-- Closes the "not retroactive" gap documented in task_plan.md: any recurring
-- series fully synced *before* the daily-recurring-audit feature deployed
-- was never registered in tracked_recurring_series (nothing existed to
-- register it into), and — since it hasn't been edited since — never will
-- be via the normal incremental (syncToken) path either, which only reports
-- *changes*. Confirmed hitting a real deployment within a day of shipping:
-- two pre-existing series stopped gaining new replicated occurrences past
-- their last-synced date, with no future event ever queued again.
--
-- Backfills tracked_recurring_series from event_mappings.source_event_id,
-- which already encodes the recurring master's id as a prefix on every
-- expanded-instance id Google hands out: "<masterId>_<YYYYMMDDTHHMMSSZ>" for
-- timed events, "<masterId>_<YYYYMMDD>" for all-day ones. Only event_mappings
-- rows are used (not sync_queue or anything else) — a mapping row only
-- exists for an event that was actually, successfully replicated, so this
-- can't accidentally register a series that was never real.
--
-- Parsing uses length()/substr() position checks rather than a single GLOB
-- with repeated [0-9] character classes — SQLite (and so D1) enforces a
-- pattern-complexity limit that a 14-class GLOB trips as soon as it's
-- actually evaluated against a real row ("LIKE or GLOB pattern too complex"),
-- caught while writing this migration's test, not in production.
--
-- covered_through is backfilled to "now", not to the series' last-known
-- occurrence date — this deliberately makes the very next daily audit re-
-- check the ENTIRE current [now, now+FUTURE_WINDOW_MS] range for the series,
-- not just resume from where it left off. Slightly more expensive (one
-- events.instances() call still covers the whole window in one request
-- regardless), but correct: "last known occurrence" could itself be stale
-- if the series had a deletion or edit in between that never made it back
-- to us either.
WITH extracted AS (
    SELECT DISTINCT
        em.user_id,
        em.source_account_id AS account_id,
        CASE
            -- Timed instance: "<masterId>_YYYYMMDDTHHMMSSZ" — 17-char suffix.
            WHEN length(em.source_event_id) > 17
                AND substr(em.source_event_id, length(em.source_event_id) - 16, 1) = '_'
                AND substr(em.source_event_id, length(em.source_event_id) - 15, 8) NOT GLOB '*[^0-9]*'
                AND substr(em.source_event_id, length(em.source_event_id) - 7, 1) = 'T'
                AND substr(em.source_event_id, length(em.source_event_id) - 6, 6) NOT GLOB '*[^0-9]*'
                AND substr(em.source_event_id, length(em.source_event_id), 1) = 'Z'
                THEN substr(em.source_event_id, 1, length(em.source_event_id) - 17)
            -- All-day instance: "<masterId>_YYYYMMDD" — 9-char suffix.
            WHEN length(em.source_event_id) > 9
                AND substr(em.source_event_id, length(em.source_event_id) - 8, 1) = '_'
                AND substr(em.source_event_id, length(em.source_event_id) - 7, 8) NOT GLOB '*[^0-9]*'
                THEN substr(em.source_event_id, 1, length(em.source_event_id) - 9)
            ELSE NULL
        END AS recurring_event_id
    FROM event_mappings em
)
INSERT INTO tracked_recurring_series (user_id, account_id, recurring_event_id, covered_through)
SELECT user_id, account_id, recurring_event_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM extracted
WHERE recurring_event_id IS NOT NULL
ON CONFLICT (account_id, recurring_event_id) DO NOTHING;
