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
 * heig-classroom's online workspace columns are left out; `work_mode` came
 * back with M6-06 (ADR-047 as amended 2026-10-07), `free` by default: a
 * project is worked in the student's own tools unless an owner with the
 * grant puts it in the portal. The portal's state of a project (its sync,
 * its first launch) is the `codespace` module's (`db/codespace.ts`).
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
  SYNC_OUTCOMES,
  SYNC_PR_STATES,
  WORK_MODES,
  type ProjectGradingScale,
} from "@quiz/contracts";

import { users } from "./auth.js";
import { githubOrganizations } from "./github.js";
import { groupSets, studentGroups } from "./group.js";
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
    /**
     * The classroom's group set a group project follows (ADR-070 §4), chosen
     * while a draft; its copy is `project_groups`. A set's deletion is
     * refused while a project that is not archived names it (`set_in_use`),
     * hence `set null` for an archived one.
     */
    groupSetId: uuid("group_set_id").references(() => groupSets.id, { onDelete: "set null" }),
    /**
     * The copy of the set stopped following it (ADR-070 §4, M3-15a): written
     * with the project's deadline applied, or its archive, and NEVER cleared
     * — not by a reopen, nor by an unarchive, nor by a *Resync* (a stopped
     * copy does not follow again by itself; a resync is one-shot, M3-15b-2b).
     */
    groupsStoppedAt: timestamp("groups_stopped_at", { withTimezone: true }),
    branches: text("branches").array().notNull(),
    protectedFiles: text("protected_files").array().notNull(),
    /**
     * Where the students work (ADR-047, F-PROJ-19 as amended 2026-10-07):
     * `free` in their own tools, `online` in the portal's workspace,
     * `online_seb` there under Safe Exam Browser (M6-07). Set by an owner
     * with the grant (`setWorkMode`); frozen once a workspace was launched.
     * It decides the invitation's permission (`collaboratorPermission`).
     */
    workMode: text("work_mode", { enum: WORK_MODES }).notNull().default("free"),
    /**
     * The source's head when it is ahead of the distribution repository
     * (F-PROJ-12, M3-07): the `after` of the last push to a handed-out
     * branch of the source, with the server's receipt of that push. Set by
     * the source push handler on every non-archived project of the source
     * (drafts included: Publish never hands out a stale distribution);
     * cleared by a sync pass that failed no repository, and only while it
     * still is the sha the pass synced — a push landing meanwhile keeps the
     * source ahead. Never a student's (N-SEC-20).
     */
    sourceAheadSha: text("source_ahead_sha"),
    sourcePushedAt: timestamp("source_pushed_at", { withTimezone: true }),
    /**
     * How many commits each pushed branch holds past its handed-out sha
     * (`source_heads`), by branch, as GitHub's compare counted them at the
     * push — null when it could not. Merged by each push, cleared with
     * `source_ahead_sha`.
     */
    sourceAhead: jsonb("source_ahead").$type<Record<string, number | null>>(),
    /**
     * The source's sha handed out per branch: written when the distribution
     * repository is built and at each sync (the commits the students may
     * receive), what "ahead" is counted from. Null on a project built before
     * it was recorded, and on heig-classroom's imported rows (F-PROJ-20):
     * the source is then shown ahead with no number.
     */
    sourceHeads: jsonb("source_heads").$type<Record<string, string>>(),
    /** The last sync pass that finished (F-PROJ-12). */
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    /** Validated by `ProjectGradingScale` of `@quiz/contracts` (D05); no default, the service writes it. */
    gradingScale: jsonb("grading_scale").$type<ProjectGradingScale>().notNull(),
    /**
     * The project's deadline applied by the ticker (`locked` from then on);
     * a repository with its own later deadline stays open until its own
     * (`project_repos.deadline_applied_at`). Cleared by a reopen.
     */
    deadlineAppliedAt: timestamp("deadline_applied_at", { withTimezone: true }),
    // No `frozen_at` (dropped by 0058, M3-05a): the freeze is a repository's,
    // `project_repos.frozen_at`, at its effective deadline + the grace.
    /**
     * The lease of the project's `project.deadline` job (ADR-064): taken by
     * the ticker, or by a staff action, with one conditional UPDATE when it
     * is null or older than ten minutes; given back by the job that holds it
     * once every repository is settled. A job that crashed, or exhausted its
     * retries, leaves it to expire, and the ticker claims the work again.
     */
    deadlineJobAt: timestamp("deadline_job_at", { withTimezone: true }),
    /**
     * The lease of the project's `project.dispatch` job (the final reviews
     * and the checkpoints' dispatches, M3-05b): the same claim, renewal and
     * expiry as `deadline_job_at`, apart from it so that a deadline's lock
     * never waits for a review, nor the reverse. (No `review_dispatched_at`
     * since 0060: whether a repository's final review was asked is its
     * `grade_dispatches` row.)
     */
    dispatchJobAt: timestamp("dispatch_job_at", { withTimezone: true }),
    /**
     * The copy has moves waiting for GitHub (ADR-070 §4, M3-15b-2): the
     * `group.sync` job may run from then on. Set to now by a set's write
     * that leaves it a departure or an arrival of a group with a
     * repository; cleared by the job once nothing waits; moved later by a
     * failed pass (a capped backoff, `group_sync_failures`).
     */
    groupSyncDueAt: timestamp("group_sync_due_at", { withTimezone: true }),
    /** The lease of the project's `group.sync` job: the claim, renewal and expiry of `deadline_job_at`. */
    groupSyncJobAt: timestamp("group_sync_job_at", { withTimezone: true }),
    /** Failed `group.sync` passes in a row, the backoff's exponent; zero once a pass leaves nothing waiting. */
    groupSyncFailures: integer("group_sync_failures").notNull().default(0),
    /**
     * The lease of the project's `project.sync` job (F-PROJ-12, M3-07): the
     * same claim, renewal and expiry as `deadline_job_at`, taken by the
     * staff's request — which updates the distribution repository while it
     * holds it — and given back by the job once every repository has its
     * outcome; held, the request is `409 sync_in_progress`. Never claimed
     * by the ticker: a sync is the staff's act.
     */
    syncJobAt: timestamp("sync_job_at", { withTimezone: true }),
    /**
     * A confirmed *Resync with the set* not fully applied yet (ADR-070 §4,
     * M3-15b-2b): the keys (`<copy group>:<roster line>:<lose|join>`) of
     * the consequences the staff confirmed, which the `group.sync` job
     * applies with the copy's stops lifted, each dropped once done or no
     * longer asked for by the set. Never extended by a set's write. While
     * not empty, the release is refused (`409 group_sync_pending`).
     */
    groupResync: jsonb("group_resync").$type<string[]>().notNull().default([]),
    /** The latest confirmed resync: when, and by whom (kept once applied). */
    groupResyncAt: timestamp("group_resync_at", { withTimezone: true }),
    groupResyncBy: uuid("group_resync_by").references(() => users.id),
    /**
     * The day-before reminder of the project's deadline sent (F-NOTIF-13,
     * M3-09b): claimed by the ticker's scan before it tells the students
     * under the project's deadline (`project_deadline_reminder`). Null:
     * owed — or never due, the scan skipping a window under a day
     * (`start_at`). A deadline moved more than a day ahead re-arms it
     * (`reminderClaimAfterMove`, `@quiz/domain`).
     */
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
    // The projects that follow a set, read by each of its writes (ADR-070).
    index("projects_group_set_idx").on(t.groupSetId),
    // The ticker's scan: the copies with moves waiting for GitHub (M3-15b-2).
    index("projects_group_sync_due_idx")
      .on(t.groupSyncDueAt)
      .where(sql`${t.groupSyncDueAt} IS NOT NULL`),
    // The ticker's scans: deadlines due and not applied,
    index("projects_deadline_due_idx")
      .on(t.deadlineAt)
      .where(sql`${t.state} = 'published' AND ${t.deadlineAppliedAt} IS NULL`),
    // and the scheduled drafts waiting for their start. (The freeze and the
    // final review are per repository since M3-05a: `project_repos`.)
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
 * A group of a project's copy of its group set (ADR-048, ADR-070 §4): its
 * name for the staff, its slug for the repository
 * (`<project-slug>-<group-slug>`), frozen once that repository exists;
 * `position` keeps the set's order. `source_group_id` is the set's group it
 * follows; null once that group is deleted (a stopped copy keeps its own).
 * `stopped_at`: the group no longer follows (M3-15b-2) — the FIRST of its
 * repository's deadline applied and its project's groups stopped
 * (`projects.groups_stopped_at`), written in the transaction of either,
 * never cleared.
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
    sourceGroupId: uuid("source_group_id").references(() => studentGroups.id, { onDelete: "set null" }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_groups_project_name_uq").on(t.projectId, t.name),
    uniqueIndex("project_groups_project_slug_uq").on(t.projectId, t.slug),
    index("project_groups_source_idx").on(t.sourceGroupId),
  ],
);

/**
 * A member of a group, by roster line: a student may be in a group before
 * they ever sign in. `project_id` is denormalized so that the UNIQUE states
 * the rule itself — at most one group per student per project.
 *
 * **A departure waits for GitHub** (ADR-070 §4, M3-15b-2): a member the set
 * moves out of a group with a repository stays in it, `departing_at` set
 * (by the set's write, or the `group.sync` job), until the job has revoked
 * their access; no invitation of them on it is recorded meanwhile
 * (`recordGrant`). Their access not revoked yet is a stray grant — the
 * project page's *access to revoke* (`STRAY_GRANT`), retried by the job.
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
    departingAt: timestamp("departing_at", { withTimezone: true }),
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
    /**
     * The staff's last resend of a pending invitation (F-PROJ-07, M3-08b):
     * at most one a minute per repository. Apart from the reconciliation's
     * daily re-invite (M3-06), which neither reads nor writes it.
     */
    invitationResentAt: timestamp("invitation_resent_at", { withTimezone: true }),
    /**
     * The reconciliation's last re-invite of a pending invitation (F-PROJ-07,
     * N-RES-08, M3-06): at most once a day per repository, claimed on the row
     * before GitHub is called; a student's own repository only, and never
     * once the repository is frozen. The staff's resend neither reads nor
     * writes it: the two never wait for each other.
     */
    invitationReinvitedAt: timestamp("invitation_reinvited_at", { withTimezone: true }),
    /**
     * The repository's own deadline, an individual extension set by its
     * staff (D13 as amended 2026-10-02); null: the project's. The EFFECTIVE
     * deadline, `coalesce(deadline_at, projects.deadline_at)`, is what every
     * deadline rule reads (`effectiveDeadline`, `@quiz/domain`).
     */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    /**
     * The day-before reminder of the repository's OWN deadline sent
     * (M3-09b): the project's claim leaves out the members of a repository
     * with its own deadline, whose reminder is claimed here, per repository
     * — `projects.reminder_sent_at`'s rules, on `deadline_at`. Meaningless
     * (and left null) while the repository follows the project's deadline.
     */
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    /**
     * The effective deadline applied (M3-05a): the provisional freeze written
     * (`frozen_grade_run_id`, the current score's run), the grace begun.
     * Cleared when the effective deadline moves later (a reopen).
     */
    deadlineAppliedAt: timestamp("deadline_applied_at", { withTimezone: true }),
    /** The definitive freeze, at the effective deadline + the project's grace (F-PROJ-11). */
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    /**
     * Every handed-out branch carries the App's deadline commit (strategy
     * `commit`, best effort): the repository's deadline work is done.
     */
    deadlineCommittedAt: timestamp("deadline_committed_at", { withTimezone: true }),
    /**
     * Locked on GitHub — by the deadline's ruleset, by the archive that
     * stands for it, or by the staff's hand. What GitHub was last made to
     * hold; what it should hold is `staff_lock`, else the deadline.
     */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /**
     * The lock fell back to archiving the repository (H8: no ruleset at
     * provisioning, or the plan refuses rulesets), shown as degraded; a
     * reopen or an unlock un-archives it.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /**
     * The staff's hand on the lock (F-PROJ-09): true locked, false unlocked,
     * null the deadline decides. A deadline pass never overrides it — a
     * repository its staff unlocked is never locked again — until the
     * repository's effective deadline moves, which clears it.
     */
    staffLock: boolean("staff_lock"),
    /** The protection ruleset made at provisioning (`hgc-protect`); null on a plan without rulesets. */
    rulesetId: bigint("ruleset_id", { mode: "number" }),
    lastCommitSha: text("last_commit_sha"),
    lastCommitAt: timestamp("last_commit_at", { withTimezone: true }),
    ciStatus: text("ci_status", { enum: CI_STATUSES }).notNull().default("none"),
    /**
     * What the last sync did to the repository (F-PROJ-12, M3-07), and when
     * (the server's clock): opened or updated its pull request, found it up
     * to date, failed on GitHub (the next sync retries it), or skipped it
     * (locked, past its effective deadline, gone). Its pull requests are
     * `project_sync_prs`. Null until a sync reaches it.
     */
    syncOutcome: text("sync_outcome", { enum: SYNC_OUTCOMES }),
    syncOutcomeAt: timestamp("sync_outcome_at", { withTimezone: true }),
    /**
     * The runs that fill the three CI slots, by id, with no foreign key (as
     * heig-classroom): the current score's run, the frozen one, the final
     * review's.
     */
    currentGradeRunId: uuid("current_grade_run_id"),
    frozenGradeRunId: uuid("frozen_grade_run_id"),
    reviewGradeRunId: uuid("review_grade_run_id"),
    /**
     * The teacher's score (F-PROJ-14), written after the definitive freeze:
     * `teacher_points` out of `teacher_max` — the scored run's maximum when
     * the repository has one, the teacher's own otherwise (product owner,
     * 2026-10-02, M3-08b). Written together, so the score is self-contained:
     * a later run with another maximum never re-reads it. Null when none;
     * `teacher_max` null on heig-classroom's imported rows, which read the
     * CI's maximum (`resolveFinalScore`).
     */
    teacherPoints: doublePrecision("teacher_points"),
    teacherMax: doublePrecision("teacher_max"),
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
     * The teacher's comment as the release wrote it (M3-09a): what the
     * student reads with their released score (F-PROJ-15). A comment written
     * since names a score not yet released again, so it stays the staff's
     * until the next release.
     */
    releasedComment: text("released_comment"),
    /**
     * Restoring protected files stopped: five restores in an hour
     * (F-PROJ-08). The staff re-enable it by hand, which clears it.
     */
    protectionSuspendedAt: timestamp("protection_suspended_at", { withTimezone: true }),
    /**
     * The staff's last re-enable of the protection (M3-08b): only the
     * restores after it count toward the cap again, the runs flagged during
     * the suspension stay `to_verify`, nothing is restored at the re-enable.
     */
    protectionReenabledAt: timestamp("protection_reenabled_at", { withTimezone: true }),
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
    // The ticker's scan of the repositories in their grace (M3-05a).
    index("project_repos_freeze_due_idx")
      .on(t.projectId)
      .where(sql`${t.deadlineAppliedAt} IS NOT NULL AND ${t.frozenAt} IS NULL`),
  ],
);

/**
 * The sync pull requests of a repository (F-PROJ-12, M3-07): ONE per
 * handed-out branch — "never two" reads per branch (product owner,
 * 2026-10-05) —, the App's own, from `sync/<branch>` onto `<branch>`.
 * Written by the sync job when it opens or reuses one, and by the
 * `pull_request` events of the App's pull requests, which keep `state`
 * (`open`, `merged`, `closed`); a replayed event for an older pull request
 * than the row's changes nothing. The row's branch is what the page shows
 * for the repository's default branch. (heig-classroom's `sync_pr_number`
 * and `sync_pr_state` columns were this row for the default branch,
 * migration `0072`; the import maps them here, F-PROJ-20.)
 */
export const projectSyncPrs = pgTable(
  "project_sync_prs",
  {
    repoId: uuid("repo_id")
      .notNull()
      .references(() => projectRepos.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    prNumber: integer("pr_number").notNull(),
    state: text("state", { enum: SYNC_PR_STATES }).notNull(),
    /** The server's clock, or the event's receipt: no default. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.branch] })],
);

/**
 * A GitHub account let into a repository for a roster line (M3-15b,
 * ADR-070 §4–§5, F-PROJ-17): written when Quiz invites it — at Accept, a
 * group's first Accept for every member, a member's later Accept, a resend,
 * a link — and what a departure revokes. The account is the one INVITED,
 * by its immutable id and the login it was invited under, never the user's
 * link of today: a student who unlinks or relinks between the invitation
 * and their departure still loses the account that holds the seat.
 *
 * One row per (repository, line, account); `revoked_at` set once GitHub
 * took the access away, or there was nothing left to take (the App gone,
 * the repository deleted); an invitation of the same account again clears
 * it. **Written BEFORE GitHub is asked**, under the line's lock and only
 * while the line is still claimed by the account's user as a student seat
 * (`recordGrant`); taken back if GitHub refuses. A roster write that takes
 * the line or its account away revokes these rows first, then, in its own
 * transaction, locks the line and refuses while one is still live
 * (`releaseLine`, `502 revoke_failed`, retried). The line's removal then
 * takes its rows with it (the trace is the audit's,
 * `project_group.repo_revoke`).
 */
export const projectRepoAccess = pgTable(
  "project_repo_access",
  {
    id: uuid("id").primaryKey(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => projectRepos.id, { onDelete: "cascade" }),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull(),
    /** The last invitation's time (`app.clock`): no default. */
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull(),
    /**
     * A revocation asked GitHub and has no answer yet (M3-15b-2): the grant
     * still counts as live (`revoked_at` null) for every check — a crash or
     * a lease taken over leaves it set, and the next revocation asks again.
     */
    revokingAt: timestamp("revoking_at", { withTimezone: true }),
    /** GitHub confirmed the revocation, or there was nothing to take (P1). */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("project_repo_access_repo_enrollment_account_uq").on(t.repoId, t.enrollmentId, t.githubUserId),
    // A departure reads the line's live grants.
    index("project_repo_access_live_idx")
      .on(t.enrollmentId)
      .where(sql`${t.revokedAt} IS NULL`),
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
    /**
     * The GRADE annotation's message as the run printed it, for a run whose
     * annotation was not taken as is (F-PROJ-10): why a `malformed` run has no
     * score, or what a `clamped` run printed. At most 500 characters. Null
     * otherwise.
     */
    parseDetail: text("parse_detail"),
    /** The CI printed a negative score, counted 0 (M3-14n); `parseDetail` keeps what it printed. */
    clamped: boolean("clamped").notNull().default(false),
    /** `ci` — a push; `review` — the final review (heig-classroom's `llm`). */
    kind: text("kind", { enum: GRADE_RUN_KINDS }).notNull().default("ci"),
    /** Its commit was received after the deadline (ADR-012): never changes the frozen score. */
    afterDeadline: boolean("after_deadline").notNull().default(false),
    /**
     * Ingested while the repository's protected files were no longer
     * restored (`project_repos.protection_suspended_at`, F-PROJ-08): its
     * score may come from an altered `grading.yml`, and the staff verify it.
     */
    toVerify: boolean("to_verify").notNull().default(false),
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
 * CONFLICT DO NOTHING` BEFORE GitHub is called, so two workers never both
 * dispatch; `dispatched_at` is set once GitHub accepted it. AT MOST ONCE
 * (product owner, 2026-10-02; M3-05b): a row is never sent again — one left
 * without `dispatched_at` (a crash between the claim and the call, a call
 * whose answer never came, a 5xx) stays "not confirmed" for the staff; only
 * a 4xx gives its claim back. One row per
 * (repository, final review) and per (repository, checkpoint): the unique
 * index coalesces the final review's null checkpoint. A reopen forgets a
 * repository's `deadline` rows (M3-05a).
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
    /**
     * The restore commit the branch was moved onto. Null (M3-06b) on a push
     * answered WITHOUT a restore, whose heads stay `to_verify`
     * (`restoredHeads`, `grading.ts`). The row's states:
     * - filled: `revert_sha` the restore, `covered_sha` the head it was
     *   built on, `branch` the push's;
     * - refused move (a 422, a student's push raced it): `revert_sha` null,
     *   `covered_sha` the head the attempt read — covered up to it, bounded
     *   by `created_at`; a retry that can restore fills the row in;
     * - nothing to restore: `revert_sha` and `covered_sha` null — a clean
     *   head had overtaken the push's when its delivery was handled; the
     *   head alone;
     * - imported from heig-classroom: `head_sha`, `covered_sha` and `branch`
     *   null.
     * A null row is no restore: it never counts toward the cap.
     */
    revertSha: text("revert_sha"),
    /** The files restored; on a null row, the protected files the push touched (the tampering, not a restore). */
    files: text("files").array().notNull(),
    /**
     * The pushed head the restore answered (M3-04): a push redelivered never
     * restores, nor counts toward the cap, twice. Null on heig-classroom's
     * imported rows.
     */
    headSha: text("head_sha"),
    /**
     * The branch head the restore commit was built on (M3-04): `head_sha`,
     * or a later push already on the branch when the restore ran. Its runs
     * used the student's copy of the protected files too. Null on imported
     * rows.
     */
    coveredSha: text("covered_sha"),
    /**
     * The branch the row answered a push on (M3-06b; on a null row, the
     * tampering push's branch): the window of heads it covers is read on
     * this branch, not on the branch of the tampering head's receipt (a
     * receipt is one per sha, and a sha may have been received on another
     * branch first). Null on the rows written before, which fall back to the
     * receipt's branch.
     */
    branch: text("branch"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("reverts_repo_time_idx").on(t.repoId, t.createdAt),
    uniqueIndex("reverts_repo_head_uq")
      .on(t.repoId, t.headSha)
      .where(sql`${t.headSha} IS NOT NULL`),
  ],
);
