-- Integrity constraints and missing indexes (docs/audits/2026-11-21-database-remediation.md, Phases 2.2, 2.4
-- and 3). Additive only: no column, constraint or index is dropped or altered, and no row is written. The
-- production audit of 2026-11-21 (`scripts/db-audit.sql`) found no row that any of these constraints refuses.
--
-- Written by hand where drizzle-kit falls short, the rest as generated:
--   - the order: the two UNIQUE constraints come first, since a foreign key needs its target's unique key
--     to exist (drizzle-kit emits the foreign keys before them);
--   - `ON DELETE SET NULL ("group_id")` on `project_repos_group_project_fk` (PostgreSQL 15+; drizzle cannot
--     express the column list): deleting a group empties the repository's `group_id` and keeps its
--     `project_id`, which is not null.
ALTER TABLE "answers" ADD CONSTRAINT "answers_id_attempt_item_uq" UNIQUE("id","attempt_id","item_id");--> statement-breakpoint
ALTER TABLE "project_groups" ADD CONSTRAINT "project_groups_id_project_uq" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_last_item_id_evaluation_items_id_fk" FOREIGN KEY ("last_item_id") REFERENCES "public"."evaluation_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradings" ADD CONSTRAINT "gradings_answer_attempt_item_fk" FOREIGN KEY ("answer_id","attempt_id","item_id") REFERENCES "public"."answers"("id","attempt_id","item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_group_members" ADD CONSTRAINT "project_group_members_group_project_fk" FOREIGN KEY ("group_id","project_id") REFERENCES "public"."project_groups"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_current_grade_run_id_project_grade_runs_id_fk" FOREIGN KEY ("current_grade_run_id") REFERENCES "public"."project_grade_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_frozen_grade_run_id_project_grade_runs_id_fk" FOREIGN KEY ("frozen_grade_run_id") REFERENCES "public"."project_grade_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_review_grade_run_id_project_grade_runs_id_fk" FOREIGN KEY ("review_grade_run_id") REFERENCES "public"."project_grade_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_group_project_fk" FOREIGN KEY ("group_id","project_id") REFERENCES "public"."project_groups"("id","project_id") ON DELETE SET NULL ("group_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_user_idx" ON "attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "attempts_last_item_idx" ON "attempts" USING btree ("last_item_id");--> statement-breakpoint
CREATE INDEX "answer_acceptances_item_idx" ON "answer_acceptances" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "grade_dispatches_repo_idx" ON "grade_dispatches" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "project_repos_project_idx" ON "project_repos" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_repos_current_run_idx" ON "project_repos" USING btree ("current_grade_run_id");--> statement-breakpoint
CREATE INDEX "project_repos_frozen_run_idx" ON "project_repos" USING btree ("frozen_grade_run_id");--> statement-breakpoint
CREATE INDEX "project_repos_review_run_idx" ON "project_repos" USING btree ("review_grade_run_id");--> statement-breakpoint
ALTER TABLE "launch_tickets" ADD CONSTRAINT "launch_tickets_kind_ck" CHECK ("launch_tickets"."kind" in ('portal', 'impersonation', 'seb', 'kiosk'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_ck" CHECK ("sessions"."kind" in ('portal', 'impersonation', 'seb', 'kiosk'));--> statement-breakpoint
ALTER TABLE "teacher_grants" ADD CONSTRAINT "teacher_grants_email_normalized_ck" CHECK ("teacher_grants"."email" = lower(btrim("teacher_grants"."email")));--> statement-breakpoint
ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_email_normalized_ck" CHECK ("user_emails"."email" = lower(btrim("user_emails"."email")));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_ck" CHECK ("users"."role" in ('student', 'teacher', 'admin'));--> statement-breakpoint
ALTER TABLE "course_staff" ADD CONSTRAINT "course_staff_role_ck" CHECK ("course_staff"."role" in ('owner', 'assistant'));--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_email_normalized_ck" CHECK ("enrollments"."email" = lower(btrim("enrollments"."email")));--> statement-breakpoint
ALTER TABLE "course_pools" ADD CONSTRAINT "course_pools_mode_ck" CHECK ("course_pools"."mode" in ('edit', 'read'));--> statement-breakpoint
ALTER TABLE "pool_members" ADD CONSTRAINT "pool_members_role_ck" CHECK ("pool_members"."role" in ('reader', 'contributor', 'owner'));--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_state_ck" CHECK ("attempts"."state" in ('not_started', 'in_progress', 'submitted', 'expired'));--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_state_ck" CHECK ("contestations"."state" in ('open', 'accepted', 'refused'));--> statement-breakpoint
ALTER TABLE "gradings" ADD CONSTRAINT "gradings_source_ck" CHECK ("gradings"."source" in ('auto', 'llm', 'manual'));--> statement-breakpoint
ALTER TABLE "gradings" ADD CONSTRAINT "gradings_state_ck" CHECK ("gradings"."state" in ('proposed', 'validated', 'superseded'));--> statement-breakpoint
ALTER TABLE "project_contestations" ADD CONSTRAINT "project_contestations_state_ck" CHECK ("project_contestations"."state" in ('open', 'accepted', 'refused'));--> statement-breakpoint
ALTER TABLE "project_criterion_grades" ADD CONSTRAINT "project_criterion_grades_source_ck" CHECK ("project_criterion_grades"."source" in ('auto', 'llm', 'manual'));--> statement-breakpoint
ALTER TABLE "project_criterion_grades" ADD CONSTRAINT "project_criterion_grades_state_ck" CHECK ("project_criterion_grades"."state" in ('proposed', 'validated', 'superseded'));--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_provision_status_ck" CHECK ("project_repos"."provision_status" in ('pending', 'ok', 'error'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_state_ck" CHECK ("projects"."state" in ('draft', 'scheduled', 'published', 'locked'));--> statement-breakpoint
ALTER TABLE "kiosk_pairings" ADD CONSTRAINT "kiosk_pairings_state_ck" CHECK ("kiosk_pairings"."state" in ('pending', 'approved', 'consumed', 'expired'));
