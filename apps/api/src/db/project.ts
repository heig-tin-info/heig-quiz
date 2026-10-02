/**
 * Projects (F-PROJ, ADR-035; spec 05 §5.3 and §5.11,
 * docs/merge/03-github-projects.md §3.3). Owned by the `project` module
 * (`modules/project/`, from merge task M3-02 on); every other module reads
 * them by join and never writes them.
 *
 * Ported from heig-classroom's tables under Quiz's words (07 §7.4):
 * assignment ⇒ project, `assignment_milestones` ⇒ `project_checkpoints`,
 * `student_repos` ⇒ `project_repos`, `grade_runs` ⇒ `project_grade_runs`,
 * the `llm` slot ⇒ the `review` slot, "validate the grades" ⇒ release.
 * heig-classroom's online workspace columns and `work_mode` are left out: a
 * project is worked in the student's own tools (D09, F-PROJ-19).
 *
 * **The rows of heig-classroom are imported as they are** (M8-01, ids kept):
 * every fact the import carries — when a repository was accepted, when a run
 * completed, when a restore happened — has NO database default, so neither
 * the import nor a service can forget to write it (the services write
 * `app.clock.now()`). New rows take `randomUUID()` ids, like every table.
 *
 * UNIQUE constraints are the idempotency of Accept, of the ingestion and of
 * the dispatches (ADR-011): a replay never writes a second row. The partial
 * indexes on `projects` and `project_checkpoints` are the ticker's scans
 * (claim and enqueue only, invariant 5).
 *
 * Deleting a project, or its classroom, deletes these rows and never a
 * repository on GitHub (D19, F-PROJ-16). `push_receipts` is the `github`
 * module's, keyed on GitHub's repository id with no foreign key into this
 * module: a project's deletion, its classroom's and its course's purge
 * those receipts first, in their transaction, through the `github`
 * module's `purgeProjectReceipts` (M3-02, N-DATA-03).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  BOT_COMMIT_KINDS,
  CI_STATUSES,
  DEADLINE_STRATEGIES,
  INVITATION_STATUSES,
  PROJECT_DEFAULTS,
  PROJECT_GRADING_MODES,
  PROJECT_STATES,
  PROVISION_STATUSES,
  PUBLISH_MODES,
  REVIEW_DISPATCH_TRIGGERS,
  GRADE_RUN_PARSE_STATUSES,
  GRADE_RUN_KINDS,
  SOURCE_STRATEGIES,
  SYNC_PR_STATES,
  type ProjectGradingScale,
} from "@quiz/contracts";

import { users } from "./auth.js";
import { githubOrganizations } from "./github.js";
import { classrooms, enrollments } from "./org.js";

/** A project of a classroom (F-PROJ-01, F-PROJ-03). */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    /**
     * The organization the project's repositories live in, copied from the
     * classroom's link at creation: a disconnected classroom keeps its
     * projects' organization. Never deleted (`github_organizations`).
     */
    orgId: uuid("org_id")
      .notNull()
      .references(() => githubOrganizations.id),
    name: text("name").notNull(),
    /** Unique in the classroom; names the repositories (`<slug>-<login>`). */
    slug: text("slug").notNull(),
    state: text("state", { enum: PROJECT_STATES }).notNull().default("draft"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    /** Minutes after the deadline before the freeze is definitive (F-PROJ-11). */
    graceMinutes: integer("grace_minutes").notNull().default(PROJECT_DEFAULTS.graceMinutes),
    /** The teacher's repository; never shown to a student, nor its existence (N-SEC-20). */
    sourceRepoId: bigint("source_repo_id", { mode: "number" }).notNull(),
    sourceFullName: text("source_full_name").notNull(),
    /**
     * The distribution repository (`<slug>-squashed`, F-PROJ-02): its id is
     * written when the draft claims it, before the build; its name once the
     * build is done — the mark Publish requires (ADR-062).
     */
    distributionRepoId: bigint("distribution_repo_id", { mode: "number" }),
    distributionFullName: text("distribution_full_name"),
    sourceStrategy: text("source_strategy", { enum: SOURCE_STRATEGIES }).notNull().default(PROJECT_DEFAULTS.sourceStrategy),
    deadlineStrategy: text("deadline_strategy", { enum: DEADLINE_STRATEGIES }).notNull().default(PROJECT_DEFAULTS.deadlineStrategy),
    gradingMode: text("grading_mode", { enum: PROJECT_GRADING_MODES }).notNull().default(PROJECT_DEFAULTS.gradingMode),
    publishMode: text("publish_mode", { enum: PUBLISH_MODES }).notNull().default(PROJECT_DEFAULTS.publishMode),
    /** Manual publication: the deadline is publication + this; null for an absolute deadline. */
    durationMinutes: integer("duration_minutes"),
    /** One repository per group (ADR-048); chosen while a draft. */
    groupMode: boolean("group_mode").notNull().default(false),
    /** Advisory: exceeding it warns, never blocks. */
    groupMaxSize: integer("group_max_size"),
    branches: text("branches").array().notNull(),
    protectedFiles: text("protected_files").array().notNull(),
    /** The source's head when it is ahead of the distribution repository (F-PROJ-12). */
    sourceAheadSha: text("source_ahead_sha"),
    sourcePushedAt: timestamp("source_pushed_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    /** Validated by `ProjectGradingScale` of `@quiz/contracts` (D05); no default, the service writes it. */
    gradingScale: jsonb("grading_scale").$type<ProjectGradingScale>().notNull(),
    deadlineAppliedAt: timestamp("deadline_applied_at", { withTimezone: true }),
    /** The definitive freeze, at deadline + grace (F-PROJ-11). */
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    /** The final review dispatched to every repository (`grade-final`). */
    reviewDispatchedAt: timestamp("review_dispatched_at", { withTimezone: true }),
    /** The day-before reminder sent (one shot, claimed by the ticker). */
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    /** The final scores made the students' and the gradebook's (F-PROJ-14). */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("projects_classroom_slug_uq").on(t.classroomId, t.slug),
    // One project per distribution repository: two creations racing for the
    // same empty leftover never both adopt it (ADR-062).
    uniqueIndex("projects_distribution_repo_uq")
      .on(t.distributionRepoId)
      .where(sql`${t.distributionRepoId} IS NOT NULL`),
    // An organization renamed, deleted or uninstalled (F-PROJ-18).
    index("projects_org_idx").on(t.orgId),
    // The ticker's scans: deadlines due and not applied,
    index("projects_deadline_due_idx")
      .on(t.deadlineAt)
      .where(sql`${t.state} = 'published' AND ${t.deadlineAppliedAt} IS NULL`),
    // the definitive freeze after the grace,
    index("projects_freeze_due_idx")
      .on(t.deadlineAt)
      .where(sql`${t.deadlineAppliedAt} IS NOT NULL AND ${t.frozenAt} IS NULL`),
    // the final review once frozen,
    index("projects_review_due_idx")
      .on(t.frozenAt)
      .where(sql`${t.frozenAt} IS NOT NULL AND ${t.reviewDispatchedAt} IS NULL`),
    // and the scheduled drafts waiting for their start.
    index("projects_scheduled_publish_idx")
      .on(t.startAt)
      .where(sql`${t.state} = 'draft' AND ${t.publishMode} = 'scheduled' AND ${t.archivedAt} IS NULL`),
  ],
);

/**
 * A review checkpoint (F-PROJ-11): at `due_at`, one `grade-milestone`
 * dispatch per repository; never counts for the score. `offset_days` (J−n)
 * keeps it with the deadline: re-resolved while not dispatched.
 */
export const projectCheckpoints = pgTable(
  "project_checkpoints",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The tag of `criteria.yml`'s `milestone:` entries (a wire name, I16). */
    name: text("name").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    offsetDays: integer("offset_days"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_checkpoints_project_name_uq").on(t.projectId, t.name),
    // The ticker's scan: checkpoints due, not dispatched.
    index("project_checkpoints_due_idx")
      .on(t.dueAt)
      .where(sql`${t.dispatchedAt} IS NULL`),
  ],
);

/**
 * A group of a project (ADR-048): its name for the staff, its slug for the
 * repository (`<project-slug>-<group-slug>`), frozen once that repository
 * exists; `position` keeps the creation order across renames.
 */
export const projectGroups = pgTable(
  "project_groups",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_groups_project_name_uq").on(t.projectId, t.name),
    uniqueIndex("project_groups_project_slug_uq").on(t.projectId, t.slug),
  ],
);

/**
 * A member of a group, by roster line: a student may be in a group before
 * they ever sign in. `project_id` is denormalized so that the UNIQUE states
 * the rule itself — at most one group per student per project.
 */
export const projectGroupMembers = pgTable(
  "project_group_members",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => projectGroups.id, { onDelete: "cascade" }),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_group_members_project_enrollment_uq").on(t.projectId, t.enrollmentId),
    index("project_group_members_group_idx").on(t.groupId),
    index("project_group_members_enrollment_idx").on(t.enrollmentId),
  ],
);

/**
 * A student's repository, or a group's (F-PROJ-05, ADR-048). A group's row
 * is created by the first member to accept: `user_id` is then that member,
 * and the members are read from `project_group_members`, never stored here.
 */
export const projectRepos = pgTable(
  "project_repos",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Who accepted. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** A group's repository; `set null` so that deleting a group never deletes a repository's row. */
    groupId: uuid("group_id").references(() => projectGroups.id, { onDelete: "set null" }),
    /** GitHub's id: what a rename is followed by. */
    githubRepoId: bigint("github_repo_id", { mode: "number" }).unique(),
    fullName: text("full_name"),
    defaultBranch: text("default_branch"),
    provisionStatus: text("provision_status", { enum: PROVISION_STATUSES }).notNull().default("pending"),
    provisionError: text("provision_error"),
    /** The right to provision, taken by one acceptance; stale after a few minutes. */
    provisionClaimedAt: timestamp("provision_claimed_at", { withTimezone: true }),
    /** Accept's time (`app.clock`), or heig-classroom's for an imported row: no default. */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    invitationStatus: text("invitation_status", { enum: INVITATION_STATUSES }).notNull().default("none"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    rulesetId: bigint("ruleset_id", { mode: "number" }),
    lastCommitSha: text("last_commit_sha"),
    lastCommitAt: timestamp("last_commit_at", { withTimezone: true }),
    ciStatus: text("ci_status", { enum: CI_STATUSES }).notNull().default("none"),
    /** The open sync pull request (F-PROJ-12): one at most. */
    syncPrNumber: integer("sync_pr_number"),
    syncPrState: text("sync_pr_state", { enum: SYNC_PR_STATES }),
    /**
     * The runs that fill the three CI slots, by id, with no foreign key (as
     * heig-classroom): the current score's run, the frozen one, the final
     * review's.
     */
    currentGradeRunId: uuid("current_grade_run_id"),
    frozenGradeRunId: uuid("frozen_grade_run_id"),
    reviewGradeRunId: uuid("review_grade_run_id"),
    /** The teacher's score, on the score's own maximum (F-PROJ-14); null when none. */
    teacherPoints: doublePrecision("teacher_points"),
    teacherComment: text("teacher_comment"),
    teacherGradedBy: uuid("teacher_graded_by").references(() => users.id),
    teacherGradedAt: timestamp("teacher_graded_at", { withTimezone: true }),
    /**
     * The final score as the release wrote it (product owner, 2026-10-01):
     * any later difference with the final score is "changed after release"
     * (F-PROJ-14). Null before the release, or without a score then.
     */
    releasedPoints: doublePrecision("released_points"),
    releasedMax: doublePrecision("released_max"),
    /**
     * Restoring protected files stopped: five restores in an hour
     * (F-PROJ-08). The staff re-enable it by hand, which clears it.
     */
    protectionSuspendedAt: timestamp("protection_suspended_at", { withTimezone: true }),
    /** Gone from GitHub: terminal, never retried. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // The idempotency of Accept: one individual repository per student and
    // project, one per group. A group's `user_id` may also hold an
    // individual row of the same project, hence the two partial indexes.
    uniqueIndex("project_repos_project_user_uq")
      .on(t.projectId, t.userId)
      .where(sql`${t.groupId} IS NULL`),
    uniqueIndex("project_repos_project_group_uq")
      .on(t.projectId, t.groupId)
      .where(sql`${t.groupId} IS NOT NULL`),
    index("project_repos_group_idx").on(t.groupId),
    // The student side reads its repositories by account.
    index("project_repos_user_idx").on(t.userId),
  ],
);

/**
 * One counted run of `grading.yml` on a repository, with its score or why it
 * has none (F-PROJ-10). Immutable; once per (repository, run, attempt).
 * `points` and `max` are doubles, as the CI reported them: a score, never a
 * grade (I06).
 */
export const projectGradeRuns = pgTable(
  "project_grade_runs",
  {
    id: uuid("id").primaryKey(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => projectRepos.id, { onDelete: "cascade" }),
    workflowRunId: bigint("workflow_run_id", { mode: "number" }).notNull(),
    runAttempt: integer("run_attempt").notNull().default(1),
    headBranch: text("head_branch").notNull(),
    headSha: text("head_sha").notNull(),
    conclusion: text("conclusion").notNull(),
    points: doublePrecision("points"),
    max: doublePrecision("max"),
    /** The TESTS annotation's counters, when the run printed one. */
    testsPassed: integer("tests_passed"),
    testsTotal: integer("tests_total"),
    parseStatus: text("parse_status", { enum: GRADE_RUN_PARSE_STATUSES }).notNull(),
    /** `ci` — a push; `review` — the final review (heig-classroom's `llm`). */
    kind: text("kind", { enum: GRADE_RUN_KINDS }).notNull().default("ci"),
    /** Its commit was received after the deadline (ADR-012): never changes the frozen score. */
    afterDeadline: boolean("after_deadline").notNull().default(false),
    /** GitHub's completion time of the run: no default. */
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_grade_runs_repo_run_attempt_uq").on(t.repoId, t.workflowRunId, t.runAttempt),
    // The selection of the current score: the latest counted run.
    index("project_grade_runs_selection_idx").on(t.repoId, t.completedAt),
  ],
);

/**
 * The App's own commits on a repository (restore, deadline, sync, the review
 * workflow's): how a bot push is told from a student's, and why a run on one
 * never counts (N-SEC-21).
 */
export const botCommits = pgTable(
  "bot_commits",
  {
    repoId: uuid("repo_id")
      .notNull()
      .references(() => projectRepos.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    kind: text("kind", { enum: BOT_COMMIT_KINDS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.sha] })],
);

/**
 * The ledger of review dispatches (F-PROJ-11): a row claimed with `ON
 * CONFLICT DO NOTHING` BEFORE GitHub is called, so a restarted worker never
 * dispatches twice; `dispatched_at` is set after the call (at-least-once).
 * One row per (repository, final review) and per (repository, checkpoint):
 * the unique index coalesces the final review's null checkpoint.
 */
export const gradeDispatches = pgTable(
  "grade_dispatches",
  {
    id: uuid("id").primaryKey(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => projectRepos.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: REVIEW_DISPATCH_TRIGGERS }).notNull(),
    checkpointId: uuid("checkpoint_id").references(() => projectCheckpoints.id, { onDelete: "cascade" }),
    /** The commit sent in the dispatch's payload. */
    sha: text("sha").notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("grade_dispatches_repo_trigger_uq").on(
      t.repoId,
      t.trigger,
      sql`coalesce(${t.checkpointId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

/**
 * The protected-file restores of a repository (F-PROJ-08): what counts the
 * five an hour that suspend them. `created_at` is the server's clock,
 * written by the service: no default.
 */
export const reverts = pgTable(
  "reverts",
  {
    id: uuid("id").primaryKey(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => projectRepos.id, { onDelete: "cascade" }),
    revertSha: text("revert_sha").notNull(),
    files: text("files").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("reverts_repo_time_idx").on(t.repoId, t.createdAt)],
);
