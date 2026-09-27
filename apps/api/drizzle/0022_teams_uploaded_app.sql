DROP TABLE "teams_links" CASCADE;--> statement-breakpoint
CREATE TABLE "teams_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"service_url" text NOT NULL,
	"tenant_id" text NOT NULL,
	"aad_object_id" text NOT NULL,
	"teams_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "teams_links" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"aad_object_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"service_url" text NOT NULL,
	"teams_name" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams_links" ADD CONSTRAINT "teams_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teams_link_tokens_conversation_idx" ON "teams_link_tokens" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "teams_link_tokens_expires_idx" ON "teams_link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_links_conversation_idx" ON "teams_links" USING btree ("conversation_id");