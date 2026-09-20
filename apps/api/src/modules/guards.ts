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
  categories,
  classrooms,
  coursePools,
  courseStaff,
  courses,
  enrollments,
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
