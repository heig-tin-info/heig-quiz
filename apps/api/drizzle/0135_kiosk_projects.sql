ALTER TABLE "sessions" ADD COLUMN "kiosk_pairing_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "devices" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "kiosk_pairings" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "kiosk_pairings" ADD COLUMN "close_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kiosk_pairing_id_kiosk_pairings_id_fk" FOREIGN KEY ("kiosk_pairing_id") REFERENCES "public"."kiosk_pairings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_pairings" ADD CONSTRAINT "kiosk_pairings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ADR-089 point 2: an `online_seb` project made before the device level was
-- Safe Exam Browser only; it keeps that level, as the check below requires.
-- Every other row keeps the default `any`. (Production held none on
-- 2026-11-15; staging and development may.)
UPDATE "projects" SET "devices" = 'seb' WHERE "work_mode" = 'online_seb';--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_devices_supervised" CHECK (("projects"."work_mode" = 'online_seb') = ("projects"."devices" <> 'any'));--> statement-breakpoint
ALTER TABLE "kiosk_pairings" ADD CONSTRAINT "kiosk_pairings_one_activity" CHECK ("kiosk_pairings"."evaluation_id" IS NULL OR "kiosk_pairings"."project_id" IS NULL);