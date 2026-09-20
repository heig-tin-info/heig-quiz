/**
 * Route guards and access loaders shared by the API modules.
 *
 * Guards are preHandler factories (bound to the Fastify instance once per
 * plugin). Access loaders implement the single authorization motif of the
 * teacher API: load the entity if and only if the current user has access to
 * its course, otherwise reply 404 and return null — indistinguishable from a
 * missing entity.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

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
export const courseAccess = staffAccess;

/**
 * THE access predicate for a pool, on a query that has `pools` in scope: its
 * owner, or anyone on the staff of a course the pool is linked to
 * (`course_pools`). Same motif as `staffAccess` — a caller who fails it gets
 * a 404, never a 403, so the existence of someone else's pool never leaks.
 *
 * `pool_members` (explicit per-account sharing) is phase 2 and deliberately
 * NOT read here: the table exists, the rule does not.
 */
export function poolAccess(userId: string): SQL {
  return sql`(${pools.ownerId} = ${userId} OR EXISTS (SELECT 1 FROM ${coursePools} JOIN ${courseStaff} ON ${courseStaff.courseId} = ${coursePools.courseId} WHERE ${coursePools.poolId} = ${pools.id} AND ${courseStaff.userId} = ${userId}))`;
}

/**
 * Same predicate expressed against a query that only has `classrooms` in
 * scope, so a classroom route does not have to join `courses` for the check.
 */
export function staffAccessOfClassroom(userId: string): SQL {
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

/**
 * An admin reaches every course; anyone else needs a staff seat. Keeping
 * this in one helper is what stops the two rules drifting apart.
 */
function accessWhere(req: FastifyRequest, predicate: SQL): SQL | undefined {
  return req.user!.role === "admin" ? undefined : predicate;
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
    .where(and(eq(courses.id, params.data.id), accessWhere(req, staffAccess(req.user!.id))))
    .limit(1);
  if (!course) return notFound(reply);
  return course;
}

const ClassroomParam = z.object({ id: z.uuid() });

/** Loads the classroom + its course, gated by the same predicate. */
export async function accessibleClassroom(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = ClassroomParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [row] = await app.db
    .select({ room: classrooms, course: courses })
    .from(classrooms)
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(
      and(eq(classrooms.id, params.data.id), accessWhere(req, staffAccess(req.user!.id))),
    )
    .limit(1);
  if (!row) return notFound(reply);
  return row;
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
        accessWhere(req, staffAccess(req.user!.id)),
      ),
    )
    .limit(1);
  if (!row) return notFound(reply);
  return row.enrollment;
}

// ---------------------------------------------------------------------------
// Pool loaders — same motif, `poolAccess` instead of `staffAccess`.
// ---------------------------------------------------------------------------

export type AccessiblePool = typeof pools.$inferSelect;

/** Loads a pool by id if and only if `poolAccess` holds; 404 otherwise. */
export async function loadPool(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  poolId: string,
): Promise<AccessiblePool | null> {
  const [pool] = await app.db
    .select()
    .from(pools)
    .where(and(eq(pools.id, poolId), accessWhere(req, poolAccess(req.user!.id))))
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

/**
 * `/questions/:id` — the question AND its pool, so a handler never has to
 * re-check anything. Soft-deleted questions are loaded on purpose: restoring
 * and hard-deleting them are routes too.
 */
export async function accessibleQuestion(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ question: typeof questions.$inferSelect; pool: AccessiblePool } | null> {
  const params = IdParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [row] = await app.db
    .select({ question: questions, pool: pools })
    .from(questions)
    .innerJoin(pools, eq(questions.poolId, pools.id))
    .where(and(eq(questions.id, params.data.id), accessWhere(req, poolAccess(req.user!.id))))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
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
    .where(and(eq(categories.id, params.data.id), accessWhere(req, poolAccess(req.user!.id))))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}

// ---------------------------------------------------------------------------
// Evaluation and attempt loaders (WP5) — same motif as everything above: the
// entity is LOADED only if access holds, and the failure is a 404 that a
// missing entity would produce too (invariant 6).
// ---------------------------------------------------------------------------

export interface EvaluationScope {
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
    .where(and(eq(evaluations.id, evaluationId), accessWhere(req, staffAccess(req.user!.id))))
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

/**
 * The same evaluation seen from the student side: reachable through a CLAIMED
 * roster seat in its classroom, and nothing else. A staff member also passes,
 * which is what makes the teacher preview and the dashboard share one loader.
 */
export async function reachableEvaluation(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  evaluationId: string,
): Promise<{ evaluation: typeof evaluations.$inferSelect; staff: boolean } | null> {
  const [row] = await app.db
    .select({ evaluation: evaluations, classroom: classrooms })
    .from(evaluations)
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(and(eq(evaluations.id, evaluationId), accessWhere(req, staffAccess(req.user!.id))))
    .limit(1);
  if (row) return { evaluation: row.evaluation, staff: true };

  const [student] = await app.db
    .select({ evaluation: evaluations })
    .from(evaluations)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.classroomId, evaluations.classroomId),
        eq(enrollments.userId, req.user!.id),
        eq(enrollments.status, "claimed"),
      ),
    )
    .where(eq(evaluations.id, evaluationId))
    .limit(1);
  if (!student) return notFound(reply);
  return { evaluation: student.evaluation, staff: false };
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
        accessWhere(req, staffAccess(req.user!.id)),
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

export interface AnswerScope {
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
    .where(and(eq(answers.id, answerId), accessWhere(req, staffAccess(req.user!.id))))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}

export interface GradingScope {
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
    .where(and(eq(gradings.id, gradingId), accessWhere(req, staffAccess(req.user!.id))))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}
