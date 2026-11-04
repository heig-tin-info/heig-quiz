CREATE TABLE "paper_sheets" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"exam_date" date NOT NULL,
	"entered_by" uuid NOT NULL,
	"scan_mime" text,
	"scan_bytes" integer,
	"scan_sha256" text,
	"scan_uploaded_at" timestamp with time zone,
	"scan_uploaded_by" uuid
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "origin" text DEFAULT 'digital' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "paper_sheets" ADD CONSTRAINT "paper_sheets_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_sheets" ADD CONSTRAINT "paper_sheets_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_sheets" ADD CONSTRAINT "paper_sheets_scan_uploaded_by_users_id_fk" FOREIGN KEY ("scan_uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_superseded_by_attempts_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;