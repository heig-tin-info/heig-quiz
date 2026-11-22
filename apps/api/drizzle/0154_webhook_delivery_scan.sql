CREATE TABLE "webhook_delivery_scan" (
	"id" text PRIMARY KEY NOT NULL,
	"covered_until" timestamp with time zone,
	"resume_cursor" text,
	"resume_ceiling" timestamp with time zone,
	CONSTRAINT "webhook_delivery_scan_one_row" CHECK ("webhook_delivery_scan"."id" = 'app'),
	CONSTRAINT "webhook_delivery_scan_resume" CHECK (("webhook_delivery_scan"."resume_cursor" IS NULL) = ("webhook_delivery_scan"."resume_ceiling" IS NULL))
);
