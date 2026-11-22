-- The reconciliations follow activity (ADR-011's addendum of 2026-11-22):
-- `reconcile.deliveries` every 15 minutes instead of daily, and
-- `reconcile.grades` daily instead of every 15 minutes. A new default in the
-- catalog moves no existing row, so each row is moved here, and only where
-- it still holds its old default: an administrator who set a period by hand
-- keeps it. A deployment that never ran either task has no row; the first
-- boot inserts it with the new default.
UPDATE "scheduled_tasks" SET "interval_minutes" = 15 WHERE "key" = 'reconcile.deliveries' AND "interval_minutes" = 1440;--> statement-breakpoint
UPDATE "scheduled_tasks" SET "interval_minutes" = 1440 WHERE "key" = 'reconcile.grades' AND "interval_minutes" = 15;
