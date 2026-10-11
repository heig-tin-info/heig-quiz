CREATE TABLE "codespace_relay_jtis" (
	"jti" text PRIMARY KEY NOT NULL,
	"exp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "codespace_relay_jtis_exp_idx" ON "codespace_relay_jtis" USING btree ("exp");