-- The integrity journal follows its switch (ADR-088 §3): until now the
-- server stored `visibility` and `focus` events whatever `logVisibility`
-- said. Those of an evaluation whose switch is off, and of a poll, which
-- never journals, were never meant to be kept. A field absent from the
-- settings reads as on (the contract's default), so its rows stay. Every
-- other kind (`run`, `reconnect`, `ip_change`, `time_added`, `paused`,
-- `resumed`) is left alone.
DELETE FROM "attempt_events" ev
USING "attempts" a, "evaluations" e
WHERE ev."attempt_id" = a."id"
  AND a."evaluation_id" = e."id"
  AND ev."kind" IN ('visibility', 'focus')
  AND (e."mode" = 'poll' OR e."settings"->>'logVisibility' = 'false');
