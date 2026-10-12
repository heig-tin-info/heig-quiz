CREATE TABLE "presence_hours" (
	"user_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	CONSTRAINT "presence_hours_user_id_hour_pk" PRIMARY KEY("user_id","hour")
);
--> statement-breakpoint
CREATE TABLE "presence_last_seen" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "presence_hours" ADD CONSTRAINT "presence_hours_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_last_seen" ADD CONSTRAINT "presence_last_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presence_hours_hour_idx" ON "presence_hours" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "presence_last_seen_at_idx" ON "presence_last_seen" USING btree ("at");