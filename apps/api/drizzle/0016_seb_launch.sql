CREATE TABLE "launch_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret_hash" char(64) NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"evaluation_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "launch_tickets_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "kind" text DEFAULT 'portal' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "evaluation_id" uuid;--> statement-breakpoint
ALTER TABLE "launch_tickets" ADD CONSTRAINT "launch_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_tickets" ADD CONSTRAINT "launch_tickets_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_tickets" ADD CONSTRAINT "launch_tickets_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launch_tickets_user_idx" ON "launch_tickets" USING btree ("user_id","evaluation_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;