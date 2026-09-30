/**
 * Route guards and access loaders shared by the API modules.
 *
 * Guards are preHandler factories (bound to the Fastify instance once per
 * plugin). Access loaders implement the single authorization motif of the
 * teacher API: load the entity if and only if the current user has access to
 * its course, otherwise reply 404 and return null — indistinguishable from a
 * missing entity.
 *
 * Where a caller cannot answer through a `reply` (the SSE handler, a route
 * that resolves a second entity from its body), the loader is split: a
 * `find…` FINDER returns the entity or null and never touches the reply, and
 * the reply-aware loader is that finder plus the 404. One query, two doors.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, getTableName, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";

import type { PoolRole } from "@quiz/contracts";
import { effectivePoolRole, ipAllowed, poolRoleAllows } from "@quiz/domain";

import { delegated, type SessionAuth } from "../auth/session.js";
import type { Db } from "../db/client.js";
import {
  answers,
  attempts,
  categories,
  classrooms,
  coursePools,
  courseStaff,
  courses,
  enrollments,
  evaluationItems,
  evaluations,
  gradings,
  poolMembers,
  pools,
  questionVersions,
  questions,
  ownedPollSql,
  STAFF_ROLES,
  users,
} from "../db/schema.js";
import { sebRequired } from "./evaluation/service.js";

/**
 * THE access predicate, on a query that has `courses` in scope: a seat on
 * the course staff. Every member of a staff holds the same rights
 * (docs/spec/07, 7.3) — there is no permission matrix, and no owner.
 *
 * Every loader below, the course listing and the SSE topics go through it:
 * one predicate, one definition of "who may work on this course". `courseId`
 * names the course column when the query reaches it by another way than
 * `courses.id` ({@link managedEvaluationAccess}).
 */
export function staffAccess(userId: string, courseId: AnyColumn | SQL = courses.id): SQL {
  return sql`EXISTS (SELECT 1 FROM ${courseStaff} WHERE ${courseStaff.courseId} = ${courseId} AND ${courseStaff.userId} = ${userId})`;
}

/**
 * The same predicate under the name PLAN-MVP §4.1 uses for the `org` routes.
 * One definition, two names: `staffAccess` reads well next to a `courses`
 * query, `courseAccess` next to `poolAccess` below.
 */
const courseAccess = staffAccess;

/**
 * `"table"."column"`, always — the same precaution as `qualified` in
 * `pool/service.ts`: inside a correlated subquery of a statement drizzle
 * believes reads a single table, a bare `${pools.id}` renders as `"id"` and
 * resolves against the SUBQUERY's table whenever that one has a column by
 * the same name (`question_versions.id` does). Qualifying by hand makes a
 * fragment independent of the statement it is dropped into.
 */
function qualified(column: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

/**
 * THE access predicate for a pool, on a query that has `pools` in scope
 * (F-POOL-05, F-POOL-06). A pool is reached by:
 *   - its owner (`pools.owner_id`);
 *   - a named member (`pool_members`), whatever their role;
 *   - every teacher, when the pool is `public` — the pool screen is read-only
 *     for them unless they are also a member (decided in ADR-013);
 *   - anyone on the staff of a course the pool is linked to (`course_pools`).
 *
 * Same motif as `staffAccess` — a caller who fails it gets a 404, never a
 * 403, so the existence of someone else's private pool never leaks. What a
 * caller may DO once they are in is `poolRoleOf` below, and failing THAT is a
 * 403: they already know the pool exists.
 *
 * And the caller's STORED role is staff (`STAFF_ROLES`), whatever branch lets
 * them in: a seat or an ownership kept by an account demoted to student (a
 * login never takes them away, ADR-013 rule 5) opens nothing, nor does a
 * `public` pool — the predicate holds by itself, without `teacherGuard`
 * (invariant 6). That EXISTS is uncorrelated, a primary-key lookup on
 * `users`: PostgreSQL evaluates it once per statement, not per pool row.
 */
export function poolAccess(userId: string): SQL {
  const staff = sql.join(
    STAFF_ROLES.map((role) => sql`${role}`),
    sql`, `,
  );
  return sql`(EXISTS (SELECT 1 FROM ${users} WHERE ${qualified(users.id)} = ${userId} AND ${qualified(users.role)} IN (${staff})) AND (${qualified(pools.ownerId)} = ${userId} OR ${qualified(pools.visibility)} = 'public' OR EXISTS (SELECT 1 FROM ${poolMembers} WHERE ${qualified(poolMembers.poolId)} = ${qualified(pools.id)} AND ${qualified(poolMembers.userId)} = ${userId}) OR EXISTS (SELECT 1 FROM ${coursePools} JOIN ${courseStaff} ON ${qualified(courseStaff.courseId)} = ${qualified(coursePools.courseId)} WHERE ${qualified(coursePools.poolId)} = ${qualified(pools.id)} AND ${qualified(courseStaff.userId)} = ${userId})))`;
}

/**
 * What the caller may DO in a pool they can already see. THE resolution order
 * is the pure rule `effectivePoolRole` of `@quiz/domain` (ADR-013) — this
 * function only loads the facts it needs, so the pool list can resolve the
 * same order in bulk without a second definition of it.
 */
export async function poolRoleOf(
  db: Db,
  pool: Pick<AccessiblePool, "id" | "ownerId" | "visibility">,
  user: { id: string; role: string },
): Promise<PoolRole> {
  if (user.role === "admin" || pool.ownerId === user.id) return "owner";
  const [[member], [seat]] = await Promise.all([
    db
      .select({ role: poolMembers.role })
      .from(poolMembers)
      .where(and(eq(poolMembers.poolId, pool.id), eq(poolMembers.userId, user.id)))
      .limit(1),
    db
      .select({ courseId: coursePools.courseId })
      .from(coursePools)
      .innerJoin(courseStaff, eq(courseStaff.courseId, coursePools.courseId))
      .where(and(eq(coursePools.poolId, pool.id), eq(courseStaff.userId, user.id)))
      .limit(1),
  ]);
  return effectivePoolRole({
    isAdmin: false,
    isOwner: false,
    memberRole: member?.role ?? null,
    isCourseStaff: seat !== undefined,
    isPublic: pool.visibility === "public",
  });
}

/** An `owner` does everything a `contributor` does, and so on down. */
const roleAllows = poolRoleAllows;

/**
 * The WRITE half of the pool motif, used by every write route of the module.
 *
 * The caller has already been let in by `poolAccess`, so a role they do not
 * hold is answered `403 forbidden`, NOT 404: invariant 6 hides the EXISTENCE
 * of an entity, and this caller can legitimately see it. A 404 here would
 * also leave the SPA unable to tell "the pool is gone" from "you may only
 * read it".
 */
export async function requirePoolRole(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  pool: Pick<AccessiblePool, "id" | "ownerId" | "visibility">,
  needed: PoolRole,
): Promise<PoolRole | null> {
  const role = await poolRoleOf(app.db, pool, req.user!);
  if (roleAllows(role, needed)) return role;
  await reply.code(403).send({
    error: "forbidden",
    message: needed === "owner" ? "Only an owner of this pool may do that" : "Read-only access",
    role,
  });
  return null;
}

/**
 * Same predicate expressed against a query that only has `classrooms` in
 * scope, so a classroom route does not have to join `courses` for the check.
 */
function staffAccessOfClassroom(userId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${courseStaff} WHERE ${courseStaff.courseId} = ${classrooms.courseId} AND ${courseStaff.userId} = ${userId})`;
}

/** Teacher only; admins pass too. */
export function teacherGuard(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.user!.role !== "teacher" && req.user!.role !== "admin") {
      return reply.code(403).send({ error: "forbidden" });
    }
    return undefined;
  };
}

/**
 * Super admin only. `hidden`: anyone else gets the 404 of a missing entity
 * rather than a 403, for a route on an entity a non-admin could reach
 * otherwise (invariant 6: the refusal says nothing about the entity).
 */
export function adminGuard(app: FastifyInstance, { hidden = false } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.user!.role !== "admin") {
      return reply.code(hidden ? 404 : 403).send({ error: hidden ? "not_found" : "forbidden" });
    }
    return undefined;
  };
}

async function notFound(reply: FastifyReply): Promise<null> {
  await reply.code(404).send({ error: "not_found" });
  return null;
}

/** Who is asking: the two fields every access decision reads. */
export interface Caller {
  id: string;
  role: string;
}

/**
 * An admin reaches every course; anyone else needs a staff seat. Keeping
 * this in one helper is what stops the two rules drifting apart — every
 * query gated by `staffAccess` or `poolAccess` goes through it.
 */
export function accessWhere(user: Pick<Caller, "role">, predicate: SQL): SQL | undefined {
  return user.role === "admin" ? undefined : predicate;
}

/**
 * "The caller already sees this user somewhere", which is exactly who may
 * fetch their uploaded picture (#318). The front end shows another user's
 * face in two places only, and this predicate is their union:
 *   - the staff of a course, on its card (`listCourses`): a fellow seat;
 *   - a classroom's roster (`rosterView`): a seat on the staff of a course
 *     where that user sits a classroom (`enrollments`, claimed).
 * Plus the user themselves (the shell, the settings) and an admin, like
 * every other loader. Nothing more: pool member lists show no avatar, so a
 * shared pool is no reason. Undefined when nothing needs checking; a caller
 * who fails it gets the 404 of a missing picture (invariant 6).
 */
export function seesUser(user: Caller, subjectId: string): SQL | undefined {
  if (user.id === subjectId) return undefined;
  const staffedBySubject = sql`SELECT ${qualified(courseStaff.courseId)} FROM ${courseStaff}
    WHERE ${qualified(courseStaff.userId)} = ${subjectId}`;
  const satBySubject = sql`SELECT ${qualified(classrooms.courseId)} FROM ${enrollments}
    JOIN ${classrooms} ON ${qualified(classrooms.id)} = ${qualified(enrollments.classroomId)}
    WHERE ${qualified(enrollments.userId)} = ${subjectId}`;
  const subjectCourses = sql`${staffedBySubject} UNION ${satBySubject}`;
  return accessWhere(
    user,
    sql`EXISTS (SELECT 1 FROM ${courses} WHERE ${staffAccess(user.id, qualified(courses.id))} AND ${qualified(courses.id)} IN (${subjectCourses}))`,
  );
}

/*
 * The route loaders below take the `params` the route wrapper has already
 * parsed with its schema from `@quiz/contracts` (a malformed id is the
 * wrapper's 404, indistinguishable from a miss), and answer their own 404.
 */

/** Loads the course if and only if the current user is on its staff. */
export async function accessibleCourse(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  params: { id: string },
) {
  const [course] = await app.db
    .select()
    .from(courses)
    .where(and(eq(courses.id, params.id), accessWhere(req.user!, staffAccess(req.user!.id))))
    .limit(1);
  if (!course) return notFound(reply);
  return course;
}

/** The classroom + its course if the caller is on its staff; null otherwise. */
export async function findAccessibleClassroom(db: Db, user: Caller, classroomId: string) {
  const [row] = await db
    .select({ room: classrooms, course: courses })
    .from(classrooms)
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(and(eq(classrooms.id, classroomId), accessWhere(user, staffAccess(user.id))))
    .limit(1);
  return row ?? null;
}

/** Loads the classroom + its course, gated by the same predicate. */
export async function accessibleClassroom(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  params: { id: string },
) {
  return (await findAccessibleClassroom(app.db, req.user!, params.id)) ?? notFound(reply);
}

// ---------------------------------------------------------------------------
// The student branch (invariant 6, spec 05 §5.7): the classroom routes a
// student reads — the student's classroom page, the journal.
// ---------------------------------------------------------------------------

/**
 * What a classroom route a student reads serves: the staff payload
 * (everything, drafts included) or the student payload (what a student with
 * a claimed seat reads, N-SEC-12).
 */
export type ClassroomPayload = "staff" | "student";

/** The facts {@link classroomPayload} decides on, loaded in one query. */
export interface ClassroomReadFacts {
  /** A `seb` session (ADR-027): opened to sit one exam, it reads no classroom. */
  seb: boolean;
  /** An impersonation session (ADR-034): somebody else acts as the user. */
  delegated: boolean;
  /** `staffAccess` holds on the classroom's course, or the caller is an admin. */
  staff: boolean;
  /** The caller holds a claimed seat (`enrollments.user_id`) in the classroom. */
  seat: boolean;
  /** The request asks for the student payload (a teacher in the student view, ADR-018). */
  studentView: boolean;
}

/**
 * THE rule of the student branch, pure: which payload the caller gets, or
 * null for the 404 of a missing classroom.
 *
 *   | session        | staff | seat | studentView | payload  |
 *   | seb            |   *   |  *   |      *      | 404      |
 *   | impersonation  |   *   | yes  |      *      | student  |
 *   | impersonation  |   *   | no   |      *      | 404      |
 *   | portal/token   | yes   |  *   |     no      | staff    |
 *   | portal/token   | yes   |  *   |     yes     | student  |
 *   | portal/token   | no    | yes  |      *      | student  |
 *   | portal/token   | no    | no   |      *      | 404      |
 *
 * `studentView` only ever narrows: it never turns a seat into staff. An
 * impersonation session reads through the student's seat alone, whatever
 * else that account could otherwise reach (N-SEC-12).
 */
export function classroomPayload(facts: ClassroomReadFacts): ClassroomPayload | null {
  if (facts.seb) return null;
  if (facts.delegated) return facts.seat ? "student" : null;
  if (facts.staff) return facts.studentView ? "student" : "staff";
  return facts.seat ? "student" : null;
}

/** A classroom loaded through {@link readableClassroom}. */
export interface ReadableClassroom {
  room: typeof classrooms.$inferSelect;
  course: typeof courses.$inferSelect;
  /** The caller's own claimed seat in it; null for a staff member without one. */
  seat: { id: string; timeBonusPercent: number } | null;
  payload: ClassroomPayload;
}

/**
 * The classroom, its course and the caller's seat if {@link classroomPayload}
 * lets the caller in; null otherwise. One query: the staff seat is an EXISTS
 * of the same `staffAccess` predicate, the student seat a left join.
 */
export async function findReadableClassroom(
  db: Db,
  user: Caller,
  auth: Pick<SessionAuth, "kind" | "actorUserId"> | null,
  classroomId: string,
  { studentView }: { studentView: boolean },
): Promise<ReadableClassroom | null> {
  if (auth?.kind === "seb") return null;
  const [row] = await db
    .select({
      room: classrooms,
      course: courses,
      seat: { id: enrollments.id, timeBonusPercent: enrollments.timeBonusPercent },
      staff: user.role === "admin" ? sql<boolean>`true` : sql<boolean>`${staffAccessOfClassroom(user.id)}`,
    })
    .from(classrooms)
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .leftJoin(
      enrollments,
      and(eq(enrollments.classroomId, classrooms.id), eq(enrollments.userId, user.id)),
    )
    .where(eq(classrooms.id, classroomId))
    .limit(1);
  if (!row) return null;
  const payload = classroomPayload({
    seb: false,
    delegated: delegated(auth),
    staff: row.staff,
    seat: row.seat !== null,
    studentView,
  });
  return payload === null ? null : { room: row.room, course: row.course, seat: row.seat, payload };
}

/**
 * `/classrooms/:id/…` read by a student or the staff: {@link findReadableClassroom}
 * for the request's own session, answering the 404 of a missing classroom.
 * `studentView` is the request's explicit ask for the student payload.
 */
export async function readableClassroom(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  params: { id: string },
  options: { studentView: boolean },
): Promise<ReadableClassroom | null> {
  return (
    (await findReadableClassroom(app.db, req.user!, req.auth, params.id, options)) ??
    notFound(reply)
  );
}

/** Loads the roster entry if the current user is on the course's staff. */
export async function accessibleEnrollment(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  params: { id: string; eid: string },
) {
  const [row] = await app.db
    .select({ enrollment: enrollments })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(
      and(
        eq(enrollments.id, params.eid),
        eq(enrollments.classroomId, params.id),
        accessWhere(req.user!, staffAccess(req.user!.id)),
      ),
    )
    .limit(1);
  if (!row) return notFound(reply);
  return row.enrollment;
}

// ---------------------------------------------------------------------------
// Pool loaders — same motif, `poolAccess` instead of `staffAccess`.
// ---------------------------------------------------------------------------

type AccessiblePool = typeof pools.$inferSelect;

/** The pool if `poolAccess` holds for the caller; null otherwise. */
export async function findAccessiblePool(
  db: Db,
  user: Caller,
  poolId: string,
): Promise<AccessiblePool | null> {
  const [pool] = await db
    .select()
    .from(pools)
    .where(and(eq(pools.id, poolId), accessWhere(user, poolAccess(user.id))))
    .limit(1);
  return pool ?? null;
}

/** `/pools/:id` */
export async function accessiblePool(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  params: { id: string },
): Promise<AccessiblePool | null> {
  return (await findAccessiblePool(app.db, req.user!, params.id)) ?? notFound(reply);
}

type QuestionScope = { question: typeof questions.$inferSelect; pool: AccessiblePool };

/**
 * The question AND its pool if `poolAccess` holds; null otherwise.
 * Soft-deleted questions are found on purpose: hard deletion is a route too.
 */
export async function findAccessibleQuestion(
  db: Db,
  user: Caller,
  questionId: string,
): Promise<QuestionScope | null> {
  const [row] = await db
    .select({ question: questions, pool: pools })
    .from(questions)
    .innerJoin(pools, eq(questions.poolId, pools.id))
    .where(and(eq(questions.id, questionId), accessWhere(user, poolAccess(user.id))))
    .limit(1);
  return row ?? null;
}

/**
 * A question written in the poll launcher and never kept (`pool_id` null,
 * ADR-014 addenda 2026-09-23 and 2026-09-27), loaded if and only if the
 * caller LAUNCHED a poll on it (or is an admin); null otherwise. It has no
 * pool for `poolAccess` to read, and the polls that froze it are the only
 * thing that ties it to anyone: the launcher's "Recent polls" lists it on
 * exactly this ground, so the two cannot disagree.
 */
export async function findOwnUnsavedPollQuestion(
  db: Db,
  user: Caller,
  questionId: string,
): Promise<typeof questions.$inferSelect | null> {
  const launched = sql`EXISTS (SELECT 1 FROM ${evaluationItems} JOIN ${evaluations} ON ${qualified(evaluations.id)} = ${qualified(evaluationItems.evaluationId)} JOIN ${questionVersions} ON ${qualified(questionVersions.id)} = ${qualified(evaluationItems.questionVersionId)} WHERE ${qualified(questionVersions.questionId)} = ${qualified(questions.id)} AND ${qualified(evaluations.mode)} = 'poll' AND ${qualified(evaluations.createdBy)} = ${user.id})`;
  const [row] = await db
    .select()
    .from(questions)
    .where(and(eq(questions.id, questionId), isNull(questions.poolId), accessWhere(user, launched)))
    .limit(1);
  return row ?? null;
}

/** `/questions/:id` — so a handler never has to re-check anything. */
export async function accessibleQuestion(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  params: { id: string },
): Promise<QuestionScope | null> {
  return (await findAccessibleQuestion(app.db, req.user!, params.id)) ?? notFound(reply);
}

/** `/categories/:id` — the category AND its pool. */
export async function accessibleCategory(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  params: { id: string },
): Promise<{ category: typeof categories.$inferSelect; pool: AccessiblePool } | null> {
  const [row] = await app.db
    .select({ category: categories, pool: pools })
    .from(categories)
    .innerJoin(pools, eq(categories.poolId, pools.id))
    .where(and(eq(categories.id, params.id), accessWhere(req.user!, poolAccess(req.user!.id))))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}

// ---------------------------------------------------------------------------
// Evaluation and attempt loaders (WP5) — same motif as everything above: the
// entity is LOADED only if access holds, and the failure is a 404 that a
// missing entity would produce too (invariant 6).
// ---------------------------------------------------------------------------

interface EvaluationScope {
  evaluation: typeof evaluations.$inferSelect;
  classroom: typeof classrooms.$inferSelect;
}

/** Loads an evaluation by id for a member of its course's teaching staff. */
export async function loadEvaluation(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  evaluationId: string,
): Promise<EvaluationScope | null> {
  const [row] = await app.db
    .select({ evaluation: evaluations, classroom: classrooms })
    .from(evaluations)
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(and(eq(evaluations.id, evaluationId), accessWhere(req.user!, staffAccess(req.user!.id))))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}

/**
 * An evaluation TEMPLATE (ADR-031) and its course, for a member of that
 * course's staff; null otherwise. A template is a row of `evaluations` whose
 * `course_id` is set, so the inner join on `courses` through that column is
 * what tells it apart: a classroom's evaluation or a poll never matches.
 */
async function findTemplate(
  db: Db,
  user: Caller,
  templateId: string,
): Promise<{ template: typeof evaluations.$inferSelect; course: typeof courses.$inferSelect } | null> {
  const [row] = await db
    .select({ template: evaluations, course: courses })
    .from(evaluations)
    .innerJoin(courses, eq(evaluations.courseId, courses.id))
    .where(and(eq(evaluations.id, templateId), accessWhere(user, staffAccess(user.id))))
    .limit(1);
  return row ?? null;
}

/** {@link findTemplate}, answering the 404 of a missing template (invariant 6). */
export async function loadTemplate(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  templateId: string,
) {
  return (await findTemplate(app.db, req.user!, templateId)) ?? notFound(reply);
}

type ReachableEvaluation = { evaluation: typeof evaluations.$inferSelect; staff: boolean };

/**
 * THE access predicate of an anonymous poll — an evaluation with no
 * classroom AND no course (`evaluations_home_ck`; ADR-014, addendum
 * 2026-09-27; ADR-031) — on a query that has `evaluations` in scope. There
 * is no course and so no staff: the teacher who launched it OWNS it, and
 * nobody else reaches it (an admin, through `accessWhere`). A colleague gets
 * the same 404 as for a poll that does not exist.
 */
function ownedPollAccess(userId: string): SQL {
  // `classroom_id is null` alone is no longer a poll: a template has none
  // either (ADR-031), and its creator must NOT own it through this door.
  return sql`(${ownedPollSql()} and ${qualified(evaluations.createdBy)} = ${userId})`;
}

/**
 * "The caller manages this row", on a query that has `evaluations` in scope
 * and `classrooms` LEFT-joined on its classroom: a staff seat on its course —
 * the classroom's, or a template's own (ADR-031) — or the ownership of an
 * anonymous poll. Undefined for an admin, like {@link accessWhere}. For a
 * query that must tell what it may name from what it may only count (the
 * pool-delete refusal), not for loading one entity.
 */
export function managedEvaluationAccess(user: Caller): SQL | undefined {
  return accessWhere(user, ownEvaluationAccess(user));
}

/**
 * {@link managedEvaluationAccess} WITHOUT the admin override: what the
 * caller manages in their own name — a staff seat, or a poll they own. The
 * Activities section (#190) lists exactly this, for an admin as for any
 * teacher: their page is their own work, not the whole platform's.
 */
export function ownEvaluationAccess(user: Caller): SQL {
  const course = sql`coalesce(${qualified(evaluations.courseId)}, ${qualified(classrooms.courseId)})`;
  return sql`(${staffAccess(user.id, course)} OR ${ownedPollAccess(user.id)})`;
}

/**
 * An evaluation the caller MANAGES: through a staff seat on its classroom's
 * course (`staffAccess`), or — a poll with no classroom — as its owner
 * (`ownedPollAccess`). Admins reach both. Null otherwise.
 *
 * `loadEvaluation` above keeps the classroom join, and therefore never finds
 * a classroom-less poll: the generic evaluation routes (settings, items,
 * grading, results) have nothing to offer one, and answer it 404. The poll
 * module and the live stream are the two places that load through this.
 */
export async function findManagedEvaluation(
  db: Db,
  user: Caller,
  evaluationId: string,
): Promise<typeof evaluations.$inferSelect | null> {
  const [row] = await db
    .select({ evaluation: evaluations })
    .from(evaluations)
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(and(eq(evaluations.id, evaluationId), accessWhere(user, staffAccess(user.id))))
    .limit(1);
  if (row) return row.evaluation;
  const [owned] = await db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.id, evaluationId),
        ownedPollSql(),
        accessWhere(user, ownedPollAccess(user.id)),
      ),
    )
    .limit(1);
  return owned ?? null;
}

/**
 * The same evaluation seen from the student side: reachable through a CLAIMED
 * roster seat in its classroom, and nothing else. A staff member also passes,
 * which is what makes the teacher preview, the dashboard and the SSE stream
 * share one predicate — and so does the owner of a poll with no classroom
 * ({@link findManagedEvaluation}), whose projection listens on the stream.
 * Null when none holds.
 */
export async function findReachableEvaluation(
  db: Db,
  user: Caller,
  evaluationId: string,
): Promise<ReachableEvaluation | null> {
  const managed = await findManagedEvaluation(db, user, evaluationId);
  if (managed) return { evaluation: managed, staff: true };

  const [student] = await db
    .select({ evaluation: evaluations })
    .from(evaluations)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.classroomId, evaluations.classroomId),
        eq(enrollments.userId, user.id),
      ),
    )
    .where(eq(evaluations.id, evaluationId))
    .limit(1);
  return student ? { evaluation: student.evaluation, staff: false } : null;
}

/**
 * ADR-027: why this request may NOT sit `evaluation` — enter it, answer it,
 * watch it as a participant — or `null` when it may. A `seb` session sits its
 * own evaluation and nothing else; any other session sits every evaluation
 * that does not require Safe Exam Browser, staff included: a teacher
 * rehearses a SEB exam with its `.seb`, like a student. And nobody sits from
 * outside the room (F-EVAL-12): the IP allow-list holds on every sitting
 * request, not only at the entry. `staffWatch` is a staff member watching
 * somebody else (dashboard, inspector), which is not sitting. Checked after
 * the loaders of invariant 6; `seb` is answered with their 404.
 */
export function sitRefusal(
  req: FastifyRequest,
  evaluation: typeof evaluations.$inferSelect,
  staffWatch: boolean,
): "seb" | "ip" | null {
  const confinedTo = req.auth?.evaluationId ?? null;
  if (confinedTo !== null ? confinedTo !== evaluation.id : !staffWatch && sebRequired(evaluation)) {
    return "seb";
  }
  if (!staffWatch && !ipAllowed(evaluation.ipAllowlist, req.ip)) return "ip";
  return null;
}

/** `findReachableEvaluation`, answering 404 when it finds nothing. */
export async function reachableEvaluation(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  evaluationId: string,
): Promise<ReachableEvaluation | null> {
  return (await findReachableEvaluation(app.db, req.user!, evaluationId)) ?? notFound(reply);
}

/**
 * `/attempts/:id` — the student's own attempt. A teacher does NOT reach a
 * student route: they have `/evaluations/:id/attempts/:attemptId` instead,
 * which is read-only and audited.
 */
export async function ownAttempt(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  attemptId: string,
): Promise<{
  attempt: typeof attempts.$inferSelect;
  evaluation: typeof evaluations.$inferSelect;
} | null> {
  const [row] = await app.db
    .select({ attempt: attempts, evaluation: evaluations })
    .from(attempts)
    .innerJoin(evaluations, eq(attempts.evaluationId, evaluations.id))
    .where(and(eq(attempts.id, attemptId), eq(attempts.userId, req.user!.id)))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}

/** Any attempt of an evaluation the caller is staff of (dashboard, controls). */
export async function staffAttempt(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  evaluationId: string,
  attemptId: string,
): Promise<typeof attempts.$inferSelect | null> {
  const [row] = await app.db
    .select({ attempt: attempts })
    .from(attempts)
    .innerJoin(evaluations, eq(attempts.evaluationId, evaluations.id))
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(
      and(
        eq(attempts.id, attemptId),
        eq(attempts.evaluationId, evaluationId),
        accessWhere(req.user!, staffAccess(req.user!.id)),
      ),
    )
    .limit(1);
  if (!row) return notFound(reply);
  return row.attempt;
}

// ---------------------------------------------------------------------------
// Grading loaders (WP6) — an answer and a grading are reached through the
// evaluation they belong to, by the same predicate as everything above, and
// an unreachable one is a 404 (invariant 6).
// ---------------------------------------------------------------------------

interface AnswerScope {
  answer: typeof answers.$inferSelect;
  attempt: typeof attempts.$inferSelect;
  evaluation: typeof evaluations.$inferSelect;
}

/** `/answers/:answerId/…` — teacher side (the grading panel). */
export async function staffAnswer(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  answerId: string,
): Promise<AnswerScope | null> {
  const [row] = await app.db
    .select({ answer: answers, attempt: attempts, evaluation: evaluations })
    .from(answers)
    .innerJoin(attempts, eq(answers.attemptId, attempts.id))
    .innerJoin(evaluations, eq(attempts.evaluationId, evaluations.id))
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(and(eq(answers.id, answerId), accessWhere(req.user!, staffAccess(req.user!.id))))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}

interface GradingScope {
  grading: typeof gradings.$inferSelect;
  evaluation: typeof evaluations.$inferSelect;
}

/** `/gradings/:id/…` — the same motif, from the grading itself. */
export async function staffGrading(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  gradingId: string,
): Promise<GradingScope | null> {
  const [row] = await app.db
    .select({ grading: gradings, evaluation: evaluations })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .innerJoin(evaluations, eq(attempts.evaluationId, evaluations.id))
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(and(eq(gradings.id, gradingId), accessWhere(req.user!, staffAccess(req.user!.id))))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}
