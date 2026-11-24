CREATE TABLE "course_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"course_id" uuid NOT NULL,
	"title" text NOT NULL,
	"filename" text NOT NULL,
	"kind" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"html" text,
	"toc" jsonb,
	"warnings" jsonb,
	"rendered_with" integer,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_documents_kind_ck" CHECK ("course_documents"."kind" in ('pdf', 'markdown')),
	CONSTRAINT "course_documents_bytes_ck" CHECK ("course_documents"."bytes" > 0),
	CONSTRAINT "course_documents_html_ck" CHECK (("course_documents"."kind" = 'markdown') = ("course_documents"."html" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "documents_quota_bytes" bigint DEFAULT 104857600 NOT NULL;--> statement-breakpoint
ALTER TABLE "course_documents" ADD CONSTRAINT "course_documents_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_documents" ADD CONSTRAINT "course_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_documents_course_sha_uq" ON "course_documents" USING btree ("course_id","sha256");--> statement-breakpoint
CREATE INDEX "course_documents_sha256_idx" ON "course_documents" USING btree ("sha256");