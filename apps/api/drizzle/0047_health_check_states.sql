CREATE TABLE "health_check_states" (
	"key" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"consecutive" integer NOT NULL,
	"notified_status" text,
	"notified_at" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL
);
