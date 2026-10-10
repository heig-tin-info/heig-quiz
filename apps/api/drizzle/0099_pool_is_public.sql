ALTER TABLE "pools" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "description_source" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
-- Data is kept: `public` becomes published; `private` and `shared` are derived from the roster from now on.
UPDATE "pools" SET "is_public" = true WHERE "visibility" = 'public';--> statement-breakpoint
ALTER TABLE "pools" DROP COLUMN "visibility";