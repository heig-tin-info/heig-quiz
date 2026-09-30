CREATE TABLE "scheduled_tasks" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_message" text,
	"last_duration_ms" integer,
	"last_ok_at" timestamp with time zone
);
