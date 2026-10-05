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
 * settings), but a mark replacing a released grade is an owner's (`403 owner_required`); what makes a grade final is the activity's own release.
 *
 * The STUDENT's route loads the classroom through `readableClassroom` with
 * the student payload forced: a student, a teacher in the student view and
 * an impersonation session all read the caller's own cells; a `seb` or
 * `kiosk` session and anyone off the classroom get the 404.
 *
 * The CSV export (F-GBOOK-04, M5-03b) is a staff read like the table, in the
 * format of F-RES-02; like the results export it audits nothing.
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

import { csvFilename } from "../../csv.js";
import { actorOf } from "../../audit.js";
import { accessibleClassroom, callerOf, isCourseOwner, readableClassroom, teacherGuard } from "../guards.js";
import { studentRoute, teacherRoute } from "../http.js";
import { gradebookCsv } from "./csv.js";
import * as service from "./service.js";

export async function gradebookPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const teacher = teacherRoute(app);
  const student = studentRoute(app);
  const onClassroom = { params: IdParam, load: accessibleClassroom.bind(null, app) };
  const ctx = async (req: Parameters<typeof actorOf>[0], now: Date, courseId: string): Promise<service.WriteContext> => ({
    actor: actorOf(req),
    userId: req.user!.id,
    owner: await isCourseOwner(app.db, courseId, callerOf(req)),
    now,
  });

  app.get(
    "/app/api/classrooms/:id/gradebook",
    { preHandler: requireTeacher },
    teacher(onClassroom, async ({ scope }) => service.staffGradebook(app.db, scope.room)),
  );

  /** F-GBOOK-04: the table as a file for Excel (UTF-8 BOM, `;`), the absence written `a1.0`. */
  app.get(
    "/app/api/classrooms/:id/gradebook.csv",
    { preHandler: requireTeacher },
    teacher(onClassroom, async ({ reply, scope }) => {
      const table = await service.staffGradebook(app.db, scope.room);
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${csvFilename(`${scope.room.name} gradebook`, "gradebook")}"`)
        .send(gradebookCsv(table));
    }),
  );

  /** F-GBOOK-05, F-GBOOK-06: publish the mean to the students, or stop. */
  app.patch(
    "/app/api/classrooms/:id/gradebook",
    { preHandler: requireTeacher },
    teacher({ ...onClassroom, body: GradebookSettingsPatch }, async ({ req, now, body, scope }) => {
      await service.patchSettings(app.db, scope, body, await ctx(req, now, scope.course.id));
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
        await service.patchColumn(app.db, scope, params, body, await ctx(req, now, scope.course.id));
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
        await service.setMark(app.db, scope, params, body, await ctx(req, now, scope.course.id));
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
        await service.clearMark(app.db, scope, params, await ctx(req, now, scope.course.id));
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
