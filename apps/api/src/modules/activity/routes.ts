import type { FastifyInstance } from "fastify";

import { IdParam } from "@quiz/contracts";

import { callerOf, readableClassroom, teacherGuard } from "../guards.js";
import { studentRoute } from "../http.js";
import * as service from "./service.js";

export async function activityPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const student = studentRoute(app);

  /**
   * The Activities section (issue #190): every activity of the classrooms
   * the caller teaches, and their own anonymous polls, in one read. The
   * scope IS each kind's access predicate (invariant 6), without the admin
   * override: an admin sees their own activities, like any teacher. No
   * input, so no schema.
   */
  app.get("/app/api/activities", { preHandler: requireTeacher }, async (req) =>
    service.listForTeacher(app.db, callerOf(req), app.clock.now()),
  );

  /**
   * The summary of the Activities section: what the rows cannot count, the
   * students of what is open. Same caller, same scope as the list.
   */
  app.get("/app/api/activities/stats", { preHandler: requireTeacher }, async (req) =>
    service.statsForTeacher(app.db, callerOf(req), app.clock.now()),
  );

  /**
   * The student's classroom page (F-ORG-15). It serves the STUDENT payload
   * and nothing else, so it asks `readableClassroom` for it: a student with a
   * claimed seat, a teacher in the student view or not (the staff read their
   * classroom at `/classrooms/:id`), and an impersonation session all get the
   * same shape, drawn through the caller's own seat. Anyone else, and a `seb`
   * session (ADR-027: this route serves portal sessions only), gets the 404
   * of a missing classroom.
   */
  app.get(
    "/app/api/student/classrooms/:id",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    student(
      {
        params: IdParam,
        load: (req, reply, p) => readableClassroom(app, req, reply, p, { studentView: true }),
      },
      ({ req, now, scope }) => service.studentClassroomPage(app.db, callerOf(req), scope, now),
    ),
  );
}
