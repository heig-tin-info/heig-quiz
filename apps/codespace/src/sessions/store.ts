/**
 * Database access to assignments and sessions. No hidden ORM: functions that
 * take the Drizzle handle, as everywhere else in the portal.
 */
import { HS256_SKEW_SECONDS } from "@quiz/domain";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  assignments,
  pushEvents,
  sessions,
  users,
  type AssignmentRow,
  type NewAssignmentRow,
  type PushEventRow,
  type SessionRow,
  type UserRow,
} from "../db/schema.js";
import { lastRejectedPush, type RejectedPush, type RepoRef } from "../git/index.js";

/**
 * States in which a session still counts as "the" session of the (student,
 * assignment) pair (analyse.md D5). `stopped` is one of them: the container is
 * dead but the volume and the session id survive, and a page reload must come
 * back to it rather than open a second one.
 */
export const LIVE_STATES = ["starting", "running", "stopped"] as const;

/**
 * How long a consumed `jti` outlives its token's `exp`: `verifyHs256`
 * accepts a token until `exp + HS256_SKEW_SECONDS`, so a row purged at `exp`
 * made a used link valid again for those seconds (audit M11). A minute more
 * covers a clock step between the check and the purge.
 */
export const JTI_RETENTION_AFTER_EXP_MS = (HS256_SKEW_SECONDS + 60) * 1000;

/** The portal's id of a review assignment is this prefix and Quiz's `project_repos.id` (ADR-129 §10). */
export const REVIEW_ASSIGNMENT_PREFIX = "review-";

/**
 * At most this many live review sessions per quota holder (ADR-129 §3), so
 * that reviews cannot starve the students. The portal alone enforces it.
 */
export const REVIEW_SESSIONS_PER_HOLDER = 2;

export function findAssignment(db: Db, id: string): AssignmentRow | undefined {
  return db.select().from(assignments).where(eq(assignments.id, id)).get();
}

/**
 * Inserts an assignment or updates every field of it but `createdAt`: the
 * platform's sync and a review launch alike.
 */
export function upsertAssignment(db: Db, row: NewAssignmentRow): AssignmentRow {
  const { createdAt: _keep, ...updatable } = row;
  const saved = db
    .insert(assignments)
    .values(row)
    .onConflictDoUpdate({ target: assignments.id, set: updatable })
    .returning()
    .get();
  if (!saved) throw new Error(`assignment ${row.id} upsert returned no row`);
  return saved;
}

export function isOpen(assignment: AssignmentRow, now: Date = new Date()): boolean {
  if (assignment.opensAt && now < assignment.opensAt) return false;
  if (assignment.closesAt && now > assignment.closesAt) return false;
  return true;
}

export function findSession(db: Db, id: string): SessionRow | undefined {
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

/**
 * The user of a session, by primary key. The session manager needs it at
 * `podman run` time: the git identity set on the container (`display_name`,
 * `email`) comes from this row, and `launch()` only receives the session.
 */
export function findUser(db: Db, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** The live session of the pair, if there is one. */
export function findLiveSession(
  db: Db,
  student: string,
  assignmentId: string,
): SessionRow | undefined {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.student, student),
        eq(sessions.assignmentId, assignmentId),
        inArray(sessions.state, [...LIVE_STATES]),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .get();
}

/**
 * The row of the (student, assignment) pair, whatever its state. There is only
 * one: `manager.ts` revives this one rather than creating a second one, so that
 * the session id — and hence the `origin` remote written into the workspace —
 * stays stable for the lifetime of the volume.
 */
export function findAnySession(
  db: Db,
  student: string,
  assignmentId: string,
): SessionRow | undefined {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.student, student), eq(sessions.assignmentId, assignmentId)))
    .orderBy(desc(sessions.createdAt))
    .get();
}

/** Live sessions; `{ reviews: false }` leaves out the staff's review sessions (ADR-129 §10). */
export function listLiveSessions(db: Db, opts: { reviews?: boolean } = {}): SessionRow[] {
  return db
    .select({ session: sessions })
    .from(sessions)
    .innerJoin(assignments, eq(sessions.assignmentId, assignments.id))
    .where(
      and(
        inArray(sessions.state, [...LIVE_STATES]),
        opts.reviews === false ? isNull(assignments.reviewOf) : undefined,
      ),
    )
    .all()
    .map((r) => r.session);
}

export function updateSession(db: Db, id: string, patch: Partial<SessionRow>): SessionRow {
  const [row] = db.update(sessions).set(patch).where(eq(sessions.id, id)).returning().all();
  if (!row) throw new Error(`session ${id} not found`);
  return row;
}

/** `<owner>/<name>` → `RepoRef`. Undefined if the shape is not there. */
export function splitRepoRef(full: string): RepoRef | undefined {
  const slash = full.indexOf("/");
  if (slash <= 0 || slash === full.length - 1) return undefined;
  return { owner: full.slice(0, slash), name: full.slice(slash + 1) };
}

/** Target repository of the relay: fixed value, or `{student}` convention. */
export function targetRepoFor(
  assignment: Pick<AssignmentRow, "targetRepo" | "targetRepoPattern">,
  student: string,
): RepoRef | undefined {
  const raw = assignment.targetRepo ?? assignment.targetRepoPattern;
  if (!raw) return undefined;
  return splitRepoRef(raw.replace(/\{student\}/g, student));
}

/**
 * Target repository **of the session**. The platform's launch token brings the
 * student's repository, which is authoritative; the assignment's convention is
 * no more than a fallback for an assignment that carries one (the former
 * standalone YAML seed, not imported into Quiz).
 */
export function targetRepoOfSession(
  session: Pick<SessionRow, "targetRepo" | "student">,
  assignment: Pick<AssignmentRow, "targetRepo" | "targetRepoPattern"> | undefined,
): RepoRef | undefined {
  if (session.targetRepo) return splitRepoRef(session.targetRepo.fullName);
  return assignment ? targetRepoFor(assignment, session.student) : undefined;
}

/**
 * A teacher's live sessions, **across all assignments**: that is the unit of
 * the quota set by the administrator (docs/history/leads.md, "quota of active
 * sessions per teacher"). `sessions.teacherId` is copied from the assignment
 * at creation time, so the count fits in a single query.
 */
export function countLiveSessionsForTeacher(db: Db, teacherId: string, exclude: readonly string[] = []): number {
  const rows = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.teacherId, teacherId),
        inArray(sessions.state, [...LIVE_STATES]),
        exclude.length > 0 ? notInArray(sessions.id, [...exclude]) : undefined,
      ),
    )
    .all();
  return rows.length;
}

/** A staff member's review assignment (ADR-129 §10), as opposed to a synchronized project. */
export function isReview(assignment: Pick<AssignmentRow, "reviewOf">): boolean {
  return Boolean(assignment.reviewOf);
}

/** Live review sessions (ADR-129 §10) matching `where`. */
function liveReviewIds(db: Db, where: SQL | undefined): string[] {
  return db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(assignments, eq(sessions.assignmentId, assignments.id))
    .where(and(isNotNull(assignments.reviewOf), inArray(sessions.state, [...LIVE_STATES]), where))
    .all()
    .map((r) => r.id);
}

/** A staff member's live review sessions: at most one by construction (ADR-129 §1). */
export function liveReviewSessionIds(db: Db, student: string): string[] {
  return liveReviewIds(db, eq(sessions.student, student));
}

/** A quota holder's live review sessions, but those in `exclude` (ADR-129 §3). */
export function countLiveReviewSessions(db: Db, teacherId: string, exclude: readonly string[] = []): number {
  return liveReviewIds(
    db,
    and(eq(sessions.teacherId, teacherId), exclude.length > 0 ? notInArray(sessions.id, [...exclude]) : undefined),
  ).length;
}

/**
 * At startup (ADR-129 §10): deletes the review assignments' dead sessions,
 * then every review assignment left without a session. Nothing references a
 * session row (a review writes no `PushEvent`). Returns the number of
 * assignments deleted.
 */
export function deleteDeadReviews(db: Db): number {
  const reviewIds = db
    .select({ id: assignments.id })
    .from(assignments)
    .where(isNotNull(assignments.reviewOf))
    .all()
    .map((r) => r.id);
  if (reviewIds.length === 0) return 0;
  db.delete(sessions)
    .where(and(inArray(sessions.assignmentId, reviewIds), notInArray(sessions.state, [...LIVE_STATES])))
    .run();
  const kept = new Set(
    db
      .select({ id: sessions.assignmentId })
      .from(sessions)
      .where(inArray(sessions.assignmentId, reviewIds))
      .all()
      .map((r) => r.id),
  );
  const gone = reviewIds.filter((id) => !kept.has(id));
  if (gone.length > 0) db.delete(assignments).where(inArray(assignments.id, gone)).run();
  return gone.length;
}

/** The last push the portal received from `student` on `assignmentId`, any session: what a fallback snapshot must not be older than (ADR-130 §3). */
export function lastPushAt(db: Db, student: string, assignmentId: string): Date | null {
  const row = db
    .select({ at: pushEvents.receivedAt })
    .from(pushEvents)
    .where(and(eq(pushEvents.student, student), eq(pushEvents.assignment, assignmentId)))
    .orderBy(desc(pushEvents.receivedAt))
    .limit(1)
    .get();
  return row?.at ?? null;
}

/** Sessions of an assignment, with their user: the platform's teacher table. */
export function assignmentSessionRows(
  db: Db,
  assignmentId: string,
): Array<{ session: SessionRow; user: UserRow; lastPushAt: Date | null; rejectedPush: RejectedPush | null }> {
  const rows = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.assignmentId, assignmentId))
    .orderBy(desc(sessions.createdAt))
    .all();
  const pushes = new Map<string, PushEventRow[]>();
  for (const p of db.select().from(pushEvents).where(eq(pushEvents.assignment, assignmentId)).all()) {
    const list = pushes.get(p.sessionId);
    if (list) list.push(p);
    else pushes.set(p.sessionId, [p]);
  }
  return rows.map((r) => {
    const own = pushes.get(r.session.id) ?? [];
    const last = own.reduce<Date | null>((at, p) => (at === null || p.receivedAt > at ? p.receivedAt : at), null);
    return { session: r.session, user: r.user, lastPushAt: last, rejectedPush: lastRejectedPush(own) };
  });
}
