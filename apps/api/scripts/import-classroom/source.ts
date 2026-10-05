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
  locale: "en" | "fr" | null;
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
  state: string;
  deadlineAt: Date;
  graceMinutes: number;
  deadlineAppliedAt: Date | null;
  frozenAt: Date | null;
  archivedAt: Date | null;
  groupMode: boolean;
}

export interface SourceStudentRepo {
  id: string;
  assignmentId: string;
  groupId: string | null;
  currentGradeRunId: string | null;
  frozenGradeRunId: string | null;
  llmGradeRunId: string | null;
}

export interface SourceGradeRun {
  id: string;
  studentRepoId: string;
}

export interface SourceGroup {
  id: string;
  assignmentId: string;
}

export interface SourceGroupMember {
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
  studentRepos: SourceStudentRepo[];
  gradeRuns: SourceGradeRun[];
  groups: SourceGroup[];
  groupMembers: SourceGroupMember[];
  auditLog: SourceAuditRow[];
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
  assignments: `SELECT id, classroom_id AS "classroomId", name, state, deadline_at AS "deadlineAt",
      grace_minutes AS "graceMinutes", deadline_applied_at AS "deadlineAppliedAt",
      frozen_at AS "frozenAt", archived_at AS "archivedAt", group_mode AS "groupMode"
    FROM assignments ORDER BY id`,
  studentRepos: `SELECT id, assignment_id AS "assignmentId", group_id AS "groupId",
      current_grade_run_id AS "currentGradeRunId", frozen_grade_run_id AS "frozenGradeRunId",
      llm_grade_run_id AS "llmGradeRunId"
    FROM student_repos ORDER BY id`,
  gradeRuns: `SELECT id, student_repo_id AS "studentRepoId" FROM grade_runs ORDER BY id`,
  groups: `SELECT id, assignment_id AS "assignmentId" FROM assignment_groups ORDER BY id`,
  groupMembers: `SELECT group_id AS "groupId", assignment_id AS "assignmentId", enrollment_id AS "enrollmentId"
    FROM assignment_group_members ORDER BY id`,
  // `id` is a bigserial: read as double precision, exact far beyond any audit log.
  auditLog: `SELECT id::double precision AS id, actor_user_id AS "actorUserId", actor_type AS "actorType",
      action, subject_type AS "subjectType", subject_id AS "subjectId", payload, created_at AS "createdAt"
    FROM audit_log ORDER BY id`,
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
 * A read-only connection to classroom's PostgreSQL (`--source`). The role
 * given should be read-only as well; the session refuses writes anyway.
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
