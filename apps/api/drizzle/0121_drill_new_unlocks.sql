CREATE TABLE "drill_new_unlocks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"batches" integer NOT NULL,
	CONSTRAINT "drill_new_unlocks_batches_ck" CHECK ("drill_new_unlocks"."batches" >= 1)
);
--> statement-breakpoint
ALTER TABLE "drill_new_unlocks" ADD CONSTRAINT "drill_new_unlocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;