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

import { classrooms, courseStaff, courses, enrollments } from "../db/schema.js";

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
