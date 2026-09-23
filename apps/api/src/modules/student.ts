import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import type { StudentClassroom } from "@quiz/contracts";

import { classrooms, courseStaff, courses, enrollments, users } from "../db/schema.js";

/**
 * Student surface. A student sees the classrooms whose roster entry they
 * claimed, and nothing else — no course listing, no roster of their peers.
 */
export async function studentPlugin(app: FastifyInstance) {
  app.get(
    "/app/api/student/classrooms",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req): Promise<StudentClassroom[]> => {
      const rows = await app.db
        .select({
          id: classrooms.id,
          name: classrooms.name,
          period: classrooms.period,
          courseId: courses.id,
          courseName: courses.name,
          courseCode: courses.code,
          timeBonusPercent: enrollments.timeBonusPercent,
        })
        .from(enrollments)
        .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
        .innerJoin(courses, eq(classrooms.courseId, courses.id))
        .where(eq(enrollments.userId, req.user!.id))
        .orderBy(courses.code, classrooms.name);
      if (rows.length === 0) return [];
      const staff = await app.db
        .select({
          courseId: courseStaff.courseId,
          givenName: users.givenName,
          familyName: users.familyName,
        })
        .from(courseStaff)
        .innerJoin(users, eq(courseStaff.userId, users.id))
        .orderBy(users.familyName);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        period: r.period,
        courseName: r.courseName,
        courseCode: r.courseCode,
        teachers: staff
          .filter((s) => s.courseId === r.courseId)
          .map((s) => `${s.givenName} ${s.familyName}`.trim()),
        timeBonusPercent: r.timeBonusPercent,
      }));
    },
  );
}
