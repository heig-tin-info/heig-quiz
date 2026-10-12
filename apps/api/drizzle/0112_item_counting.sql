ALTER TABLE "evaluation_items" ADD COLUMN "counting" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
UPDATE "evaluation_items" SET "counting" = 'bonus' WHERE "bonus" = true;--> statement-breakpoint
ALTER TABLE "evaluation_items" DROP COLUMN "bonus";