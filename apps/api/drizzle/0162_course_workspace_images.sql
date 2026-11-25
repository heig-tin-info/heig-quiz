CREATE TABLE "course_workspace_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"reference" text NOT NULL,
	"digest_reference" text,
	"candidate_reference" text,
	"state" text NOT NULL,
	"reason" text,
	"detail" text,
	"base_version" text,
	"disk_bytes" bigint,
	"requested_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "course_workspace_images_state_ck" CHECK ("course_workspace_images"."state" in ('downloading', 'checking', 'ready', 'refused')),
	CONSTRAINT "course_workspace_images_reason_ck" CHECK ("course_workspace_images"."reason" IS NULL OR "course_workspace_images"."reason" in ('not_found', 'not_public', 'too_large', 'not_on_base', 'config', 'disk_full', 'pull_failed', 'contract_failed', 'interrupted')),
	CONSTRAINT "course_workspace_images_candidate_ck" CHECK (("course_workspace_images"."candidate_reference" IS NOT NULL) = ("course_workspace_images"."state" in ('downloading', 'checking')))
);
--> statement-breakpoint
ALTER TABLE "codespace_projects" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "course_workspace_images" ADD CONSTRAINT "course_workspace_images_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_workspace_images" ADD CONSTRAINT "course_workspace_images_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_workspace_images_course_name_uq" ON "course_workspace_images" USING btree ("course_id",lower("name"));--> statement-breakpoint
ALTER TABLE "codespace_projects" ADD CONSTRAINT "codespace_projects_image_id_course_workspace_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."course_workspace_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "codespace_projects_image_idx" ON "codespace_projects" USING btree ("image_id");