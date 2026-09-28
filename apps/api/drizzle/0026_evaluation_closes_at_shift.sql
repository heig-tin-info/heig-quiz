-- Existing rows start at 0: their announced window is closes_at - opens_at as stored (#253).
ALTER TABLE "evaluations" ADD COLUMN "closes_at_shift_s" integer DEFAULT 0 NOT NULL;