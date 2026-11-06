-- The per-evaluation unlock password of SEB (ADR-027, addendum of 2026-11-06):
-- drawn on first need by sebUnlockPasswordOf, staff-only. No backfill.
ALTER TABLE "evaluations" ADD COLUMN "seb_unlock_password" text;