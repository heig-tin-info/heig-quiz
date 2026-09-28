-- The evaluations a restart of the application would interrupt: the deploy
-- guard of deploy.sh (docs/spec/05-architecture.md §5.9) refuses to deploy
-- production while this returns a row. One row per live session, tab-
-- separated: title, state, mode, opens_at, closes_at (Swiss time, or `-`).
--
-- It runs against the database of the version CURRENTLY deployed, before the
-- new image migrates it: it reads only columns that have been there since
-- the table was created (0002_evaluation.sql). `deployGuard.db.test.ts`
-- (apps/api) runs this very file against the real migrations, so a schema
-- change that breaks it fails CI rather than a deploy.
--
-- Live means students are in the room, or about to be:
--   - `lobby`, `running` or `paused`: connected, or waiting to start;
--   - `scheduled` with an opening time in the next 15 minutes: the ticker
--     would open it in the middle of the restart.
-- Two exclusions keep a forgotten session from freezing every deploy:
--   - a take-home exercise (an `exercise` whose waiting room is `skip`, the
--     glossary's `exercise`, `isInClass` in @quiz/domain): it may stay open
--     for days, and a student loses a few seconds of reconnection at most;
--   - a session whose state has not changed for 12 hours: a sitting in the
--     room lasts hours, so that one was left open and nobody is waiting on
--     it. `updated_at` is set by every transition (`tryApplyState`).
select
  title,
  state,
  mode,
  coalesce(to_char(opens_at at time zone 'Europe/Zurich', 'YYYY-MM-DD HH24:MI'), '-'),
  coalesce(to_char(closes_at at time zone 'Europe/Zurich', 'YYYY-MM-DD HH24:MI'), '-')
from evaluations
where (mode <> 'exercise' or coalesce(settings ->> 'lobby', 'manual') <> 'skip')
  and (
    (state in ('lobby', 'running', 'paused') and updated_at > now() - interval '12 hours')
    or (state = 'scheduled' and opens_at < now() + interval '15 minutes')
  )
order by opens_at nulls last, title;
