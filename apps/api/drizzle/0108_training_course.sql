ALTER TABLE "courses" ADD COLUMN "training_for" uuid;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "is_training" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_training_for_users_id_fk" FOREIGN KEY ("training_for") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courses_training_for_uq" ON "courses" USING btree ("training_for");--> statement-breakpoint
CREATE UNIQUE INDEX "pools_training_uq" ON "pools" USING btree ("is_training") WHERE "pools"."is_training";