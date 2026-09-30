CREATE TABLE "kiosk_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"google_device_id" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'unnamed' NOT NULL,
	"attested_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"attestation" text,
	"credential_hash" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiosk_devices_google_device_id_unique" UNIQUE("google_device_id"),
	CONSTRAINT "kiosk_devices_credential_hash_unique" UNIQUE("credential_hash")
);
--> statement-breakpoint
CREATE TABLE "kiosk_pairings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"device_code_hash" char(64) NOT NULL,
	"user_code_hash" char(64) NOT NULL,
	"state" text NOT NULL,
	"user_id" uuid,
	"evaluation_id" uuid,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "kiosk_pairings_device_code_hash_unique" UNIQUE("device_code_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "seb_config_key" char(64);--> statement-breakpoint
ALTER TABLE "kiosk_pairings" ADD CONSTRAINT "kiosk_pairings_device_id_kiosk_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."kiosk_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_pairings" ADD CONSTRAINT "kiosk_pairings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_pairings" ADD CONSTRAINT "kiosk_pairings_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_pairings" ADD CONSTRAINT "kiosk_pairings_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kiosk_pairings_user_code_idx" ON "kiosk_pairings" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX "kiosk_pairings_device_state_idx" ON "kiosk_pairings" USING btree ("device_id","state");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_kiosk_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."kiosk_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_device_idx" ON "sessions" USING btree ("device_id") WHERE "sessions"."device_id" IS NOT NULL;