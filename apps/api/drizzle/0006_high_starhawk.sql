CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pool_members" ALTER COLUMN "role" SET DEFAULT 'reader';--> statement-breakpoint
-- The role vocabulary of a pool member becomes reader|contributor|owner
-- (F-POOL-05). The table held no row in any deployment, but the rename is
-- written out: a migration must not depend on a table being empty.
UPDATE "pool_members" SET "role" = 'reader' WHERE "role" = 'viewer';--> statement-breakpoint
UPDATE "pool_members" SET "role" = 'contributor' WHERE "role" = 'editor';--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at");