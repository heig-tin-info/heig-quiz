CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_kind_channel_pk" PRIMARY KEY("user_id","kind","channel")
);
--> statement-breakpoint
CREATE TABLE "teams_links" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"object_id" text NOT NULL,
	"chat_id" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "evaluation_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_links" ADD CONSTRAINT "teams_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_evaluation_idx" ON "notifications" USING btree ("evaluation_id");