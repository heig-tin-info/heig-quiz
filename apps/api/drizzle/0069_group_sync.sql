ALTER TABLE "project_group_members" ADD COLUMN "departing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_groups" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repo_access" ADD COLUMN "revoking_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "group_sync_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "group_sync_job_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "group_sync_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_group_sync_due_idx" ON "projects" USING btree ("group_sync_due_at") WHERE "projects"."group_sync_due_at" IS NOT NULL;
--> statement-breakpoint
-- Each copy group's stop (ADR-070's amendment of 2026-10-05): the FIRST of
-- its project's groups stopped and its repository's deadline applied — the
-- deadline applied now, or the first time the audit log recorded it, so a
-- repository reopened since keeps its group stopped.
UPDATE "project_groups" g SET "stopped_at" = s."at"
FROM (
  SELECT g2."id", LEAST(
    p."groups_stopped_at",
    r."deadline_applied_at",
    (SELECT min(a."created_at") FROM "audit_log" a
      WHERE a."subject_type" = 'project_repo' AND a."subject_id" = r."id"::text AND a."action" = 'project_repo.deadline_applied')
  ) AS "at"
  FROM "project_groups" g2
  JOIN "projects" p ON p."id" = g2."project_id"
  LEFT JOIN "project_repos" r ON r."group_id" = g2."id"
) s
WHERE g."id" = s."id" AND s."at" IS NOT NULL;
