CREATE TABLE "assist_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assist_exchanges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"context" jsonb NOT NULL,
	"model" text NOT NULL,
	"corpus_version" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assist_conversations" ADD CONSTRAINT "assist_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assist_exchanges" ADD CONSTRAINT "assist_exchanges_conversation_id_assist_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assist_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assist_conversations_user_idx" ON "assist_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "assist_exchanges_conversation_idx" ON "assist_exchanges" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "assist_exchanges_created_idx" ON "assist_exchanges" USING btree ("created_at");