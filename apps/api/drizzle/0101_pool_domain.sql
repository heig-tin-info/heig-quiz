ALTER TABLE "pools" ADD COLUMN "domain_fr" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "domain_en" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "domain_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "domain_at" timestamp with time zone;