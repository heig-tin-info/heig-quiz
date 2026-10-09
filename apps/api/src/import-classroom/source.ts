/**
 * The heig-classroom side of the import: one consistent, read-only snapshot
 * of the tables M1-06 imports, loaded into memory (a few hundred rows in
 * production, `docs/merge/measures-2026-09-28.md`).
 *
 * Read-only twice over: the connection is opened with
 * `default_transaction_read_only=on`, and the snapshot is read in ONE
 * `REPEATABLE READ READ ONLY` transaction, so every table is seen at the same
 * instant and no statement can write. Nothing here ever writes the source.
 */
import pg from "pg";

import type { Locale } from "@quiz/domain";

/** Runs one statement on the source and returns its rows. */
export type SourceQuery = <T>(sql: string) => Promise<T[]>;

export interface SourceUser {
  id: string;
  oidcSub: string;
  email: string;
  emailVerified: boolean;
  givenName: string;
  familyName: string;
  swissEduId: string | null;
  pictureUrl: string | null;
  githubUserId: number | null;
  githubLogin: string | null;
  githubLinkedAt: Date | null;
  lastLoginAt: Date | null;
  locale: Locale | null;
  dateFormat: "iso" | "eu" | "uk" | "us" | null;
  emailPrefs: Record<string, boolean> | null;
  anonymizedAt: Date | null;
  createdAt: Date;
}

export interface SourceUserEmail {
  userId: string;
  email: string;
  source: string;
  verified: boolean;
  firstSeenAt: Date;
}

export interface SourceClaims {
  userId: string;
  claims: Record<string, unknown>;
  affiliations: string[];
  updatedAt: Date;
}

export interface SourceAvatar {
  userId: string;
  data: Uint8Array;
  contentType: string;
  updatedAt: Date;
}

export interface SourceGrant {
  id: string;
  email: string;
  codespaceEnabled: boolean;
  createdBy: string;
  createdAt: Date;
}

export interface SourceOrganization {
  id: string;
  githubOrgId: number | null;
  login: string;
}

export interface SourceClassroom {
  id: string;
  orgId: string;
  teacherId: string;
  name: string;
  archivedAt: Date | null;
}

export interface SourceStaffSeat {
  id: string;
  classroomId: string;
  email: string;
  role: "teacher" | "assistant";
  userId: string | null;
}

export interface SourceEnrollment {
  id: string;
  classroomId: string;
  nom: string;
  prenom: string;
  email: string;
  status: "pending" | "claimed";
  userId: string | null;
  claimedAt: Date | null;
  staff: boolean;
}

export interface SourceAssignment {
  id: string;
  classroomId: string;
  name: string;
  slug: string;
  state: string;
  startAt: Date;
  deadlineAt: Date;
  graceMinutes: number;
  sourceRepoId: number;
  sourceFullName: string;
  squashedRepoId: number | null;
  squashedFullName: string | null;
  sourceStrategy: string;
  deadlineStrategy: string;
  gradingMode: string;
  publishMode: string;
  durationMinutes: number | null;
  /** `free`, or an online codespace mode, which Quiz does not carry (pre-flight `work-mode`). */
  workMode: string;
  groupMode: boolean;
  /** The group assignment's advisory size (the set's `max_size`). */
  groupMaxSize: number | null;
  branches: string[];
  protectedFiles: string[];
  sourceAheadSha: string | null;
  sourcePushedAt: Date | null;
  syncedAt: Date | null;
  deadlineAppliedAt: Date | null;
  frozenAt: Date | null;
  llmDispatchedAt: Date | null;
  reminderSentAt: Date | null;
  gradesValidatedAt: Date | null;
  gradesValidatedBy: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface SourceMilestone {
  id: string;
  assignmentId: string;
  name: string;
  dueAt: Date;
  offsetDays: number | null;
  dispatchedAt: Date | null;
  createdAt: Date;
}

export interface SourceStudentRepo {
  id: string;
  assignmentId: string;
  userId: string;
  groupId: string | null;
  githubRepoId: number | null;
  fullName: string | null;
  defaultBranch: string | null;
  provisionStatus: string;
  provisionError: string | null;
  provisionClaimedAt: Date | null;
  deletedAt: Date | null;
  acceptedAt: Date;
  invitationStatus: string;
  lockedAt: Date | null;
  rulesetId: number | null;
  lastCommitSha: string | null;
  lastCommitAt: Date | null;
  ciStatus: string;
  syncPrNumber: number | null;
  syncPrState: string | null;
  currentGradeRunId: string | null;
  frozenGradeRunId: string | null;
  llmGradeRunId: string | null;
  teacherPoints: number | null;
  teacherComment: string | null;
  teacherGradedBy: string | null;
  teacherGradedAt: Date | null;
}

export interface SourceGradeRun {
  id: string;
  studentRepoId: string;
  workflowRunId: number;
  runAttempt: number;
  headBranch: string;
  headSha: string;
  conclusion: string;
  gradePoints: number | null;
  gradeMax: number | null;
  testsPassed: number | null;
  testsTotal: number | null;
  parseStatus: string;
  kind: string;
  afterDeadline: boolean;
  completedAt: Date;
  createdAt: Date;
}

export interface SourcePushReceipt {
  id: string;
  studentRepoId: string;
  branch: string;
  headSha: string;
  receivedAt: Date;
  isBot: boolean;
  forced: boolean;
}

export interface SourceBotCommit {
  studentRepoId: string;
  sha: string;
  kind: string;
  createdAt: Date;
}

export interface SourceDispatch {
  id: string;
  studentRepoId: string;
  trigger: string;
  milestoneId: string | null;
  sha: string;
  dispatchedAt: Date | null;
  createdAt: Date;
}

export interface SourceRevert {
  id: string;
  studentRepoId: string;
  revertSha: string;
  files: string[];
  createdAt: Date;
}

export interface SourceGroup {
  id: string;
  assignmentId: string;
  name: string;
  slug: string;
  position: number;
  createdAt: Date;
}

export interface SourceGroupMember {
  id: string;
  addedAt: Date;
  groupId: string;
  assignmentId: string;
  enrollmentId: string;
}

/** heig-classroom's `audit_log`, whole (D11): the legacy audit step copies it. */
export interface SourceAuditRow {
  id: number;
  actorUserId: string | null;
  actorType: string;
  action: string;
  subjectType: string;
  subjectId: string;
  payload: unknown;
  createdAt: Date;
}

/** A classroom's journal attachment, with the journal it reads (M8-01d): never its pages nor assets (I65). */
export interface SourceJournalAttachment {
  classroomId: string;
  journalId: string;
  orgId: string;
  githubRepoId: number | null;
  fullName: string;
  ref: string;
  rootPath: string;
  attachedAt: Date;
  attachedBy: string;
}

/** A webhook delivery as received (M8-01d). */
export interface SourceWebhookDelivery {
  deliveryId: string;
  event: string;
  action: string | null;
  payload: Record<string, unknown>;
  receivedAt: Date;
  processedAt: Date | null;
  error: string | null;
}

/**
 * What the source says about being stopped (pre-flight, `preflight.ts`): its
 * own clock, the freshest sign of life, and what its work queue still holds.
 */
export interface SourceActivity {
  /** The source's `now()`, the pre-flight's clock (the run's, `ImportOptions.now`, overrides it). */
  now: Date;
  lastTaskRunAt: Date | null;
  runningTasks: number;
  lastWebhookAt: Date | null;
  unprocessedWebhooks: number;
  /** pg-boss (`pgboss.job`): whether it could be read, and the jobs not finished. */
  queue: { readable: boolean; pending: { name: string; state: string; n: number }[] };
}

export interface SourceSnapshot {
  activity: SourceActivity;
  users: SourceUser[];
  userEmails: SourceUserEmail[];
  claims: SourceClaims[];
  avatars: SourceAvatar[];
  grants: SourceGrant[];
  organizations: SourceOrganization[];
  classrooms: SourceClassroom[];
  staff: SourceStaffSeat[];
  enrollments: SourceEnrollment[];
  assignments: SourceAssignment[];
  milestones: SourceMilestone[];
  studentRepos: SourceStudentRepo[];
  gradeRuns: SourceGradeRun[];
  pushReceipts: SourcePushReceipt[];
  botCommits: SourceBotCommit[];
  dispatches: SourceDispatch[];
  reverts: SourceRevert[];
  groups: SourceGroup[];
  groupMembers: SourceGroupMember[];
  auditLog: SourceAuditRow[];
  journalAttachments: SourceJournalAttachment[];
  webhookDeliveries: SourceWebhookDelivery[];
}

/**
 * GitHub ids are `bigint`, which node-postgres hands over as strings: read as
 * `double precision`, exact for every GitHub id (Quiz's columns use `number`
 * mode too).
 */
const STATEMENTS: { [K in Exclude<keyof SourceSnapshot, "activity">]: string } = {
  users: `SELECT id, oidc_sub AS "oidcSub", email, email_verified AS "emailVerified",
      given_name AS "givenName", family_name AS "familyName", swiss_edu_id AS "swissEduId",
      picture_url AS "pictureUrl", github_user_id::double precision AS "githubUserId",
      github_login AS "githubLogin", github_linked_at AS "githubLinkedAt",
      last_login_at AS "lastLoginAt", locale, date_format AS "dateFormat",
      email_prefs AS "emailPrefs", anonymized_at AS "anonymizedAt", created_at AS "createdAt"
    FROM users ORDER BY id`,
  userEmails: `SELECT user_id AS "userId", email, source, verified, first_seen_at AS "firstSeenAt"
    FROM user_emails ORDER BY user_id, email`,
  claims: `SELECT user_id AS "userId", claims, affiliations, updated_at AS "updatedAt"
    FROM user_idp_claims ORDER BY user_id`,
  avatars: `SELECT user_id AS "userId", data, content_type AS "contentType", updated_at AS "updatedAt"
    FROM avatars ORDER BY user_id`,
  grants: `SELECT id, email, codespace_enabled AS "codespaceEnabled", created_by AS "createdBy",
      created_at AS "createdAt"
    FROM teacher_grants ORDER BY id`,
  organizations: `SELECT id, github_org_id::double precision AS "githubOrgId", login
    FROM organizations ORDER BY id`,
  classrooms: `SELECT id, org_id AS "orgId", teacher_id AS "teacherId", name, archived_at AS "archivedAt"
    FROM classrooms ORDER BY id`,
  staff: `SELECT id, classroom_id AS "classroomId", email, role, user_id AS "userId"
    FROM classroom_staff ORDER BY id`,
  enrollments: `SELECT id, classroom_id AS "classroomId", nom, prenom, email, status,
      user_id AS "userId", claimed_at AS "claimedAt", staff
    FROM enrollments ORDER BY id`,
  assignments: `SELECT id, classroom_id AS "classroomId", name, slug, state, start_at AS "startAt",
      deadline_at AS "deadlineAt", grace_minutes AS "graceMinutes",
      source_repo_id::double precision AS "sourceRepoId", source_full_name AS "sourceFullName",
      squashed_repo_id::double precision AS "squashedRepoId", squashed_full_name AS "squashedFullName",
      source_strategy AS "sourceStrategy", deadline_strategy AS "deadlineStrategy",
      grading_mode AS "gradingMode", publish_mode AS "publishMode", duration_minutes AS "durationMinutes",
      work_mode AS "workMode", group_mode AS "groupMode", group_max_size AS "groupMaxSize", branches, protected_files AS "protectedFiles",
      source_ahead_sha AS "sourceAheadSha", source_pushed_at AS "sourcePushedAt", synced_at AS "syncedAt",
      deadline_applied_at AS "deadlineAppliedAt", frozen_at AS "frozenAt",
      llm_dispatched_at AS "llmDispatchedAt", reminder_sent_at AS "reminderSentAt",
      grades_validated_at AS "gradesValidatedAt", grades_validated_by AS "gradesValidatedBy",
      archived_at AS "archivedAt", created_at AS "createdAt"
    FROM assignments ORDER BY id`,
  milestones: `SELECT id, assignment_id AS "assignmentId", name, due_at AS "dueAt", offset_days AS "offsetDays",
      dispatched_at AS "dispatchedAt", created_at AS "createdAt"
    FROM assignment_milestones ORDER BY id`,
  studentRepos: `SELECT id, assignment_id AS "assignmentId", user_id AS "userId", group_id AS "groupId",
      github_repo_id::double precision AS "githubRepoId", full_name AS "fullName",
      default_branch AS "defaultBranch", provision_status AS "provisionStatus",
      provision_error AS "provisionError", provision_claimed_at AS "provisionClaimedAt",
      deleted_at AS "deletedAt", accepted_at AS "acceptedAt", invitation_status AS "invitationStatus",
      locked_at AS "lockedAt", ruleset_id::double precision AS "rulesetId",
      last_commit_sha AS "lastCommitSha", last_commit_at AS "lastCommitAt", ci_status AS "ciStatus",
      sync_pr_number AS "syncPrNumber", sync_pr_state AS "syncPrState",
      current_grade_run_id AS "currentGradeRunId", frozen_grade_run_id AS "frozenGradeRunId",
      llm_grade_run_id AS "llmGradeRunId", teacher_points AS "teacherPoints",
      teacher_comment AS "teacherComment", teacher_graded_by AS "teacherGradedBy",
      teacher_graded_at AS "teacherGradedAt"
    FROM student_repos ORDER BY id`,
  gradeRuns: `SELECT id, student_repo_id AS "studentRepoId", workflow_run_id::double precision AS "workflowRunId",
      run_attempt AS "runAttempt", head_branch AS "headBranch", head_sha::text AS "headSha", conclusion,
      grade_points AS "gradePoints", grade_max AS "gradeMax", tests_passed AS "testsPassed",
      tests_total AS "testsTotal", parse_status AS "parseStatus", kind, after_deadline AS "afterDeadline",
      completed_at AS "completedAt", created_at AS "createdAt"
    FROM grade_runs ORDER BY id`,
  pushReceipts: `SELECT id, student_repo_id AS "studentRepoId", branch, head_sha::text AS "headSha",
      received_at AS "receivedAt", is_bot AS "isBot", forced
    FROM push_receipts ORDER BY id`,
  botCommits: `SELECT student_repo_id AS "studentRepoId", sha::text AS sha, kind, created_at AS "createdAt"
    FROM bot_commits ORDER BY student_repo_id, sha`,
  dispatches: `SELECT id, student_repo_id AS "studentRepoId", trigger, milestone_id AS "milestoneId", sha::text AS sha,
      dispatched_at AS "dispatchedAt", created_at AS "createdAt"
    FROM grade_dispatches ORDER BY id`,
  reverts: `SELECT id, student_repo_id AS "studentRepoId", revert_sha::text AS "revertSha", files,
      created_at AS "createdAt"
    FROM reverts ORDER BY id`,
  groups: `SELECT id, assignment_id AS "assignmentId", name, slug, position, created_at AS "createdAt"
    FROM assignment_groups ORDER BY id`,
  groupMembers: `SELECT id, added_at AS "addedAt", group_id AS "groupId", assignment_id AS "assignmentId",
      enrollment_id AS "enrollmentId"
    FROM assignment_group_members ORDER BY id`,
  // `id` is a bigserial: read as double precision, exact far beyond any audit log.
  auditLog: `SELECT id::double precision AS id, actor_user_id AS "actorUserId", actor_type AS "actorType",
      action, subject_type AS "subjectType", subject_id AS "subjectId", payload, created_at AS "createdAt"
    FROM audit_log ORDER BY id`,
  journalAttachments: `SELECT cj.classroom_id AS "classroomId", cj.journal_id AS "journalId", j.org_id AS "orgId",
      j.github_repo_id::double precision AS "githubRepoId", j.full_name AS "fullName", j.ref,
      j.root_path AS "rootPath", cj.attached_at AS "attachedAt", cj.attached_by AS "attachedBy"
    FROM classroom_journals cj JOIN journals j ON j.id = cj.journal_id ORDER BY cj.classroom_id`,
  // Whole table (a few thousand rows): the 30-day window is the run's clock, applied by the step.
  webhookDeliveries: `SELECT delivery_id AS "deliveryId", event, action, payload, received_at AS "receivedAt",
      processed_at AS "processedAt", error
    FROM webhook_deliveries ORDER BY received_at, delivery_id`,
};

/**
 * Signs of life and unfinished work. pg-boss keeps its queue in `pgboss.job`
 * (absent in a bare database, unreadable to a role without the grant): said
 * so (`readable: false`) rather than failing the snapshot.
 */
const ACTIVITY = `SELECT now() AS now,
    (SELECT max(last_run_at) FROM scheduled_tasks) AS "lastTaskRunAt",
    (SELECT count(*)::int FROM scheduled_tasks WHERE last_status = 'running') AS "runningTasks",
    (SELECT max(received_at) FROM webhook_deliveries) AS "lastWebhookAt",
    (SELECT count(*)::int FROM webhook_deliveries WHERE processed_at IS NULL) AS "unprocessedWebhooks",
    coalesce(to_regclass('pgboss.job') IS NOT NULL AND has_table_privilege('pgboss.job', 'SELECT'), false) AS "queueReadable"`;
const QUEUE = `SELECT name, state::text AS state, count(*)::int AS n FROM pgboss.job
  WHERE state::text IN ('created', 'retry', 'active') GROUP BY name, state ORDER BY name, state`;

/** The snapshot, read in one read-only transaction. */
export async function readSnapshot(query: SourceQuery): Promise<SourceSnapshot> {
  await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const snapshot: Record<string, unknown> = {};
    const [first] = await query<SourceActivity & { queueReadable: boolean }>(ACTIVITY);
    const { queueReadable, ...rest } = first!;
    snapshot.activity = {
      ...rest,
      queue: { readable: queueReadable, pending: queueReadable ? await query(QUEUE) : [] },
    };
    for (const [key, statement] of Object.entries(STATEMENTS)) snapshot[key] = await query(statement);
    return snapshot as unknown as SourceSnapshot;
  } finally {
    await query("ROLLBACK");
  }
}

/**
 * The source's connection string: the database `name` (`--source-db`) on
 * the server of the target's `DATABASE_URL`, with its credentials. The
 * cutover restores classroom's dump into a scratch database there
 * (`hgc_cutover`), so no second URL, and above all no password, ever
 * appears on the command line (`/proc/<pid>/cmdline`).
 */
export function sourceUrl(targetUrl: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`--source-db: ${name} is not a database name`);
  const url = new URL(targetUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("--source-db: the target DATABASE_URL is not a PostgreSQL URL");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * A read-only connection to classroom's PostgreSQL (`sourceUrl`). The
 * session refuses writes whatever the role may do.
 */
export async function openSource(url: string): Promise<{ query: SourceQuery; close: () => Promise<void> }> {
  const client = new pg.Client({
    connectionString: url,
    options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  return {
    query: async <T>(sql: string) => (await client.query(sql)).rows as T[],
    close: () => client.end(),
  };
}
