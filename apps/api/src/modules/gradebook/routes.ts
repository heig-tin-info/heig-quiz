/**
 * HTTP surface of the `gradebook` module (F-GBOOK, ADR-074; merge task
 * M5-03a). Every body and payload is a schema of
 * `packages/contracts/src/gradebook.ts` (invariant 7).
 *
 * The STAFF's routes load the classroom through `staffAccess`
 * (`accessibleClassroom`, invariant 6): anyone else, a student included,
 * gets the 404 of a missing classroom. Every write answers the table as it
 * now stands (`GradebookStaff`). The settings and the marks are open to
 * every member of the staff, an assistant included (ADR-068: a classroom's
 * settings); what makes a grade final is the activity's own release.
 *
 * The STUDENT's route loads the classroom through `readableClassroom` with
 * the student payload forced: a student, a teacher in the student view and
 * an impersonation session all read the caller's own cells; a `seb` or
 * `kiosk` session and anyone off the classroom get the 404. The CSV export
 * (F-GBOOK-04) is M5-03b.
 */
import type { FastifyInstance } from "fastify";

import {
  GradebookColumnParams,
  GradebookColumnPatch,
  GradebookMarkParams,
  GradebookMarkPut,
  GradebookSettingsPatch,
  IdParam,
} from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import { accessibleClassroom, callerOf, readableClassroom, teacherGuard } from "../guards.js";
import { studentRoute, teacherRoute } from "../http.js";
import * as service from "./service.js";

export async function gradebookPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const teacher = teacherRoute(app);
  const student = studentRoute(app);
  const onClassroom = { params: IdParam, load: accessibleClassroom.bind(null, app) };
  const ctx = (req: Parameters<typeof actorOf>[0], now: Date): service.WriteContext => ({
    actor: actorOf(req),
    userId: req.user!.id,
    now,
  });

  app.get(
    "/app/api/classrooms/:id/gradebook",
    { preHandler: requireTeacher },
    teacher(onClassroom, async ({ scope }) => service.staffGradebook(app.db, scope.room)),
  );

  /** F-GBOOK-05, F-GBOOK-06: publish the mean to the students, or stop. */
  app.patch(
    "/app/api/classrooms/:id/gradebook",
    { preHandler: requireTeacher },
    teacher({ ...onClassroom, body: GradebookSettingsPatch }, async ({ req, now, body, scope }) => {
      await service.patchSettings(app.db, scope, body, ctx(req, now));
      return service.staffGradebook(app.db, scope.room);
    }),
  );

  /** F-GBOOK-06: a column's weight, whether it counts, its position. */
  app.patch(
    "/app/api/classrooms/:id/gradebook/columns/:kind/:activityId",
    { preHandler: requireTeacher },
    teacher(
      { params: GradebookColumnParams, load: (req, reply, p) => accessibleClassroom(app, req, reply, p), body: GradebookColumnPatch },
      async ({ req, now, params, body, scope }) => {
        await service.patchColumn(app.db, scope, params, body, ctx(req, now));
        return service.staffGradebook(app.db, scope.room);
      },
    ),
  );

  /** An absence, or the teacher's own score, on a student of a column; `409 grade_exists` without `override` over a real grade. */
  app.put(
    "/app/api/classrooms/:id/gradebook/columns/:kind/:activityId/marks/:eid",
    { preHandler: requireTeacher },
    teacher(
      { params: GradebookMarkParams, load: (req, reply, p) => accessibleClassroom(app, req, reply, p), body: GradebookMarkPut },
      async ({ req, now, params, body, scope }) => {
        await service.setMark(app.db, scope, params, body, ctx(req, now));
        return service.staffGradebook(app.db, scope.room);
      },
    ),
  );

  /** Clears a mark: the cell is the activity's own again. */
  app.delete(
    "/app/api/classrooms/:id/gradebook/columns/:kind/:activityId/marks/:eid",
    { preHandler: requireTeacher },
    teacher(
      { params: GradebookMarkParams, load: (req, reply, p) => accessibleClassroom(app, req, reply, p) },
      async ({ req, now, params, scope }) => {
        await service.clearMark(app.db, scope, params, ctx(req, now));
        return service.staffGradebook(app.db, scope.room);
      },
    ),
  );

  /**
   * The student's own cells (F-GBOOK-05). The STUDENT payload and nothing
   * else, so it asks `readableClassroom` for it, like the classroom page.
   */
  app.get(
    "/app/api/student/classrooms/:id/gradebook",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    student(
      { params: IdParam, load: (req, reply, p) => readableClassroom(app, req, reply, p, { studentView: true }) },
      ({ req, now, scope }) => service.studentGradebook(app.db, scope, callerOf(req).id, now),
    ),
  );
}
