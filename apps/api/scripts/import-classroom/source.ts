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

export interface SourceSnapshot {
  users: SourceUser[];
  userEmails: SourceUserEmail[];
  claims: SourceClaims[];
  avatars: SourceAvatar[];
  grants: SourceGrant[];
  organizations: SourceOrganization[];
  classrooms: SourceClassroom[];
  staff: SourceStaffSeat[];
  enrollments: SourceEnrollment[];
}

/**
 * GitHub ids are `bigint`, which node-postgres hands over as strings: read as
 * `double precision`, exact for every GitHub id (Quiz's columns use `number`
 * mode too).
 */
const STATEMENTS: { [K in keyof SourceSnapshot]: string } = {
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
};

/** The snapshot, read in one read-only transaction. */
export async function readSnapshot(query: SourceQuery): Promise<SourceSnapshot> {
  await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const snapshot = {} as Record<keyof SourceSnapshot, unknown[]>;
    for (const [key, statement] of Object.entries(STATEMENTS)) {
      snapshot[key as keyof SourceSnapshot] = await query(statement);
    }
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
