CREATE TABLE "webhook_redelivery_asks" (
	"guid" uuid PRIMARY KEY NOT NULL,
	"first_asked_at" timestamp with time zone NOT NULL,
	"asks" integer NOT NULL,
	"last_status" integer NOT NULL,
	"refused_at" timestamp with time zone
);
