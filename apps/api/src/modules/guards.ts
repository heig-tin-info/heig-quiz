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
import { and, eq, getTableName, isNotNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { PoolRole } from "@quiz/contracts";
import { effectivePoolRole, poolRoleAllows } from "@quiz/domain";

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
  evaluations,
  gradings,
  poolMembers,
  pools,
  questions,
} from "../db/schema.js";

const IdParam = z.object({ id: z.uuid() });

/**
 * THE access predicate, on a query that has `courses` in scope: a seat on
 * the course staff. Every member of a staff holds the same rights
 * (docs/spec/07, 7.3) — there is no permission matrix, and no owner.
 *
 * Every loader below, the course listing and the SSE topics go through it:
 * one predicate, one definition of "who may work on this course".
 */
export function staffAccess(userId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${courseStaff} WHERE ${courseStaff.courseId} = ${courses.id} AND ${courseStaff.userId} = ${userId})`;
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
 * `teacherGuard` runs before every pool route, so the `public` branch cannot
 * hand a pool to a student.
 */
export function poolAccess(userId: string): SQL {
  return sql`(${qualified(pools.ownerId)} = ${userId} OR ${qualified(pools.visibility)} = 'public' OR EXISTS (SELECT 1 FROM ${poolMembers} WHERE ${qualified(poolMembers.poolId)} = ${qualified(pools.id)} AND ${qualified(poolMembers.userId)} = ${userId}) OR EXISTS (SELECT 1 FROM ${coursePools} JOIN ${courseStaff} ON ${qualified(courseStaff.courseId)} = ${qualified(coursePools.courseId)} WHERE ${qualified(coursePools.poolId)} = ${qualified(pools.id)} AND ${qualified(courseStaff.userId)} = ${userId}))`;
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

/** Super admin only. */
export function adminGuard(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.user!.role !== "admin") return reply.code(403).send({ error: "forbidden" });
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

/** Loads the course if and only if the current user is on its staff. */
export async function accessibleCourse(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = IdParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [course] = await app.db
    .select()
    .from(courses)
    .where(and(eq(courses.id, params.data.id), accessWhere(req.user!, staffAccess(req.user!.id))))
    .limit(1);
  if (!course) return notFound(reply);
  return course;
}

const ClassroomParam = z.object({ id: z.uuid() });

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
) {
  const params = ClassroomParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  return (await findAccessibleClassroom(app.db, req.user!, params.data.id)) ?? notFound(reply);
}

const EnrollmentParam = z.object({ id: z.uuid(), eid: z.uuid() });

/** Loads the roster entry if the current user is on the course's staff. */
export async function accessibleEnrollment(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = EnrollmentParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [row] = await app.db
    .select({ enrollment: enrollments })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(
      and(
        eq(enrollments.id, params.data.eid),
        eq(enrollments.classroomId, params.data.id),
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

/** Loads a pool by id if and only if `poolAccess` holds; 404 otherwise. */
async function loadPool(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  poolId: string,
): Promise<AccessiblePool | null> {
  const [pool] = await app.db
    .select()
    .from(pools)
    .where(and(eq(pools.id, poolId), accessWhere(req.user!, poolAccess(req.user!.id))))
    .limit(1);
  if (!pool) return notFound(reply);
  return pool;
}

/** `/pools/:id` */
export async function accessiblePool(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AccessiblePool | null> {
  const params = IdParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  return loadPool(app, req, reply, params.data.id);
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

/** `/questions/:id` — so a handler never has to re-check anything. */
export async function accessibleQuestion(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<QuestionScope | null> {
  const params = IdParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  return (await findAccessibleQuestion(app.db, req.user!, params.data.id)) ?? notFound(reply);
}

/** `/categories/:id` — the category AND its pool. */
export async function accessibleCategory(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ category: typeof categories.$inferSelect; pool: AccessiblePool } | null> {
  const params = IdParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [row] = await app.db
    .select({ category: categories, pool: pools })
    .from(categories)
    .innerJoin(pools, eq(categories.poolId, pools.id))
    .where(and(eq(categories.id, params.data.id), accessWhere(req.user!, poolAccess(req.user!.id))))
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

/** `/evaluations/:id` — teacher side. */
export async function accessibleEvaluation(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<EvaluationScope | null> {
  const params = IdParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  return loadEvaluation(app, req, reply, params.data.id);
}

type ReachableEvaluation = { evaluation: typeof evaluations.$inferSelect; staff: boolean };

/**
 * The same evaluation seen from the student side: reachable through a CLAIMED
 * roster seat in its classroom, and nothing else. A staff member also passes,
 * which is what makes the teacher preview, the dashboard and the SSE stream
 * share one predicate. Null when neither holds.
 */
export async function findReachableEvaluation(
  db: Db,
  user: Caller,
  evaluationId: string,
): Promise<ReachableEvaluation | null> {
  const [row] = await db
    .select({ evaluation: evaluations, classroom: classrooms })
    .from(evaluations)
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(and(eq(evaluations.id, evaluationId), accessWhere(user, staffAccess(user.id))))
    .limit(1);
  if (row) return { evaluation: row.evaluation, staff: true };

  const [student] = await db
    .select({ evaluation: evaluations })
    .from(evaluations)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.classroomId, evaluations.classroomId),
        eq(enrollments.userId, user.id),
        isNotNull(enrollments.userId),
      ),
    )
    .where(eq(evaluations.id, evaluationId))
    .limit(1);
  return student ? { evaluation: student.evaluation, staff: false } : null;
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
