/**
 * Database access to assignments and sessions. No hidden ORM: functions that
 * take the Drizzle handle, as everywhere else in the portal.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  assignments,
  pushEvents,
  sessions,
  users,
  type AssignmentRow,
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
export type LiveState = (typeof LIVE_STATES)[number];

export function findAssignment(db: Db, id: string): AssignmentRow | undefined {
  return db.select().from(assignments).where(eq(assignments.id, id)).get();
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

export function listLiveSessions(db: Db): SessionRow[] {
  return db
    .select()
    .from(sessions)
    .where(inArray(sessions.state, [...LIVE_STATES]))
    .all();
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
 * the quota set by the administrator (docs/leads.md, "quota of active
 * sessions per teacher"). `sessions.teacherId` is copied from the assignment
 * at creation time, so the count fits in a single query.
 */
export function countLiveSessionsForTeacher(db: Db, teacherId: string): number {
  const rows = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.teacherId, teacherId), inArray(sessions.state, [...LIVE_STATES])))
    .all();
  return rows.length;
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
