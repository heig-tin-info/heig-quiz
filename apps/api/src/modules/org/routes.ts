/**
 * The `org` routes PLAN-MVP §4.1 asks for and the bootstrap did not have:
 * the course detail with its pools, the `course_pools` link, and the join
 * code with the student self-enrolment it opens (F-ORG-06).
 *
 * Courses, staff, classrooms and the roster live in `modules/courses.ts`;
 * this file completes them rather than moving them, so the routes the web
 * app already calls keep their handlers.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";

import { CoursePoolsPut, JoinParams, type CourseDetail, type JoinResult } from "@quiz/contracts";

import { audit } from "../../audit.js";
import { classrooms, courseStaff, courses, users } from "../../db/schema.js";
import { publish } from "../../events.js";
import { accessibleCourse, poolAccess, teacherGuard } from "../guards.js";
import { poolsOfCourse, setCoursePools } from "../pool/service.js";
import { joinClassroom } from "./service.js";

export async function orgPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  /** `GET /courses/:id` — the course, its staff, its pools and its classrooms. */
  app.get("/app/api/courses/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const course = await accessibleCourse(app, req, reply);
    if (!course) return reply;
    const [staff, rooms, pools] = await Promise.all([
      app.db
        .select({
          userId: users.id,
          givenName: users.givenName,
          familyName: users.familyName,
          email: users.email,
        })
        .from(courseStaff)
        .innerJoin(users, eq(courseStaff.userId, users.id))
        .where(eq(courseStaff.courseId, course.id))
        .orderBy(asc(users.familyName), asc(users.givenName)),
      app.db
        .select()
        .from(classrooms)
        .where(eq(classrooms.courseId, course.id))
        .orderBy(asc(classrooms.createdAt)),
      poolsOfCourse(app.db, course.id),
    ]);
    const detail: CourseDetail = {
      course: { id: course.id, name: course.name, code: course.code },
      staff,
      pools: pools.map((p) => ({
        id: p.id,
        name: p.name,
        visibility: p.visibility,
        questionCount: p.questionCount,
      })),
      classrooms: rooms.map((r) => ({
        id: r.id,
        name: r.name,
        period: r.period,
        archivedAt: r.archivedAt?.toISOString() ?? null,
        joinCode: r.joinCode,
        joinCodeEnabled: r.joinCodeEnabled,
      })),
    };
    return detail;
  });

  /**
   * The whole set of pools the course draws from, replaced in one call.
   * Only pools the caller can already reach are linked — the write goes
   * through `pool/service.ts`, which owns `course_pools`.
   */
  app.put("/app/api/courses/:id/pools", { preHandler: requireTeacher }, async (req, reply) => {
    const course = await accessibleCourse(app, req, reply);
    if (!course) return reply;
    const body = CoursePoolsPut.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    const linked = await setCoursePools(
      app.db,
      course.id,
      body.data.poolIds,
      req.user!.role === "admin" ? undefined : poolAccess(req.user!.id),
    );
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "course.pools_update",
      subjectType: "course",
      subjectId: course.id,
      payload: { poolIds: linked.map((p) => p.id) },
    });
    publish("courses", [`course:${course.id}`, `teacher:${req.user!.id}`]);
    for (const pool of linked) publish("pool", [`pool:${pool.id}`]);
    return linked;
  });

  /**
   * `POST /app/api/join/:code` — the student side (F-ORG-06). Any session
   * may call it: the code IS the authorization, and a wrong or disabled one
   * is a plain 404, so the route says nothing about which codes exist.
   */
  app.post(
    "/app/api/join/:code",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = JoinParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const [row] = await app.db
        .select({ room: classrooms, course: courses })
        .from(classrooms)
        .innerJoin(courses, eq(classrooms.courseId, courses.id))
        .where(
          and(
            eq(classrooms.joinCode, params.data.code.trim().toUpperCase()),
            eq(classrooms.joinCodeEnabled, true),
          ),
        )
        .limit(1);
      if (!row || row.room.archivedAt) return reply.code(404).send({ error: "not_found" });

      const me = req.user!;
      const outcome = await joinClassroom(app.db, row.room.id, me);
      if (!outcome.ok) {
        return reply.code(409).send({
          error: "claimed_by_other",
          message: "This roster entry is already attached to another account",
        });
      }
      if (outcome.status === "joined") {
        await audit(app.db, {
          actorUserId: me.id,
          actorType: "user",
          action: "roster.join",
          subjectType: "classroom",
          subjectId: row.room.id,
          payload: { email: me.email },
        });
        publish(
          "roster",
          [`classroom:${row.room.id}`, `user:${me.id}`],
          { kind: "student_joined", message: `${me.givenName} ${me.familyName}`.trim() },
        );
      }
      const result: JoinResult = {
        classroomId: row.room.id,
        classroomName: row.room.name,
        courseCode: row.course.code,
        status: outcome.status,
      };
      return reply.code(outcome.status === "joined" ? 201 : 200).send(result);
    },
  );
}
