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
 *
 * The COURSE's components of the mean (ADR-131) load the course through
 * `staffAccess` (`accessibleCourse`: anyone off its staff gets the 404 of a
 * missing course); reading them is any member's, writing them the owner's
 * (`403 owner_required` from the loader, before the body; ADR-068 §3). Each
 * write answers the list.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  GradebookColumnParams,
  GradebookColumnPatch,
  GradebookComponentCreate,
  GradebookComponentParams,
  GradebookComponentPatch,
  GradebookMarkParams,
  GradebookMarkPut,
  GradebookSettingsPatch,
  IdParam,
} from "@quiz/contracts";

import { csvFilename } from "../../csv.js";
import { actorOf } from "../../audit.js";
import {
  accessibleClassroom,
  accessibleCourse,
  callerOf,
  isCourseOwner,
  readableClassroom,
  teacherGuard,
  withCourseRole,
} from "../guards.js";
import { sendCsv, studentRoute, teacherRoute } from "../http.js";
import { ownHints } from "../realtime/bus.js";
import { gradebookCsv } from "./csv.js";
import * as service from "./service.js";

export async function gradebookPlugin(app: FastifyInstance) {
  // Its hints are its own, never `classroom:` (`gradebook/events.ts`).
  app.addHook("onRoute", ownHints);
  const requireTeacher = teacherGuard(app);
  const teacher = teacherRoute(app);
  const student = studentRoute(app);
  const onClassroom = { params: IdParam, load: accessibleClassroom.bind(null, app) };
  const ctx = async (req: Parameters<typeof actorOf>[0], now: Date, courseId: string): Promise<service.WriteContext> => ({
    actor: actorOf(req),
    userId: callerOf(req).id,
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
      return sendCsv(reply, csvFilename(`${scope.room.name} gradebook`, "gradebook"), gradebookCsv(table));
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

  /** F-GBOOK-06: a column's weight, whether it counts, its position, its component of the mean (ADR-131). */
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

  // --- The course's components of the mean (ADR-131) ---

  const loadCourse = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) => accessibleCourse(app, req, reply, p);
  const ownedCourse = withCourseRole(app, loadCourse, (course) => course.id, "owner");
  const courseCtx = (req: Parameters<typeof actorOf>[0], now: Date): service.CourseWriteContext => ({
    actor: actorOf(req),
    userId: callerOf(req).id,
    now,
  });

  app.get(
    "/app/api/courses/:id/gradebook/components",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: loadCourse }, async ({ scope: course }) => service.listComponents(app.db, course.id)),
  );

  app.post(
    "/app/api/courses/:id/gradebook/components",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: ownedCourse, body: GradebookComponentCreate }, async ({ req, reply, now, body, scope: course }) => {
      await service.createComponent(app.db, course.id, body, courseCtx(req, now));
      return reply.code(201).send(await service.listComponents(app.db, course.id));
    }),
  );

  app.patch(
    "/app/api/courses/:id/gradebook/components/:componentId",
    { preHandler: requireTeacher },
    teacher({ params: GradebookComponentParams, load: ownedCourse, body: GradebookComponentPatch }, async ({ req, now, params, body, scope: course }) => {
      await service.updateComponent(app.db, course.id, params.componentId, body, courseCtx(req, now));
      return service.listComponents(app.db, course.id);
    }),
  );

  app.delete(
    "/app/api/courses/:id/gradebook/components/:componentId",
    { preHandler: requireTeacher },
    teacher({ params: GradebookComponentParams, load: ownedCourse }, async ({ req, now, params, scope: course }) => {
      await service.deleteComponent(app.db, course.id, params.componentId, courseCtx(req, now));
      return service.listComponents(app.db, course.id);
    }),
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
