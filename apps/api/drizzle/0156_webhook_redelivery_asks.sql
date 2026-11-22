CREATE TABLE "webhook_redelivery_asks" (
	"guid" text PRIMARY KEY NOT NULL,
	"attempt_id" bigint NOT NULL,
	"failed_at" timestamp with time zone NOT NULL,
	"asks" integer NOT NULL,
	"last_asked_at" timestamp with time zone,
	"next_ask_at" timestamp with time zone NOT NULL,
	"failed_requests" integer DEFAULT 0 NOT NULL,
	"last_status" integer NOT NULL,
	"refused_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "webhook_redelivery_asks_due_idx" ON "webhook_redelivery_asks" USING btree ("failed_at") WHERE "webhook_redelivery_asks"."refused_at" IS NULL;