/**
 * HTTP surface of the `project` module, the staff's lifecycle (spec 05
 * §5.11, merge task M3-02): a classroom's projects and their creation, the
 * organization's repository browser, one project's summary, patch, delete,
 * publish, archive and unarchive. Every body and payload is a schema of
 * `packages/contracts/src/project.ts` (invariant 7).
 *
 * Registered only when Quiz's App is configured (`app.ts`), like the
 * `github` module: without it none of these routes exists. Open to every
 * member of a course's staff (D26 addendum, 2026-10-02); the students see
 * nothing of projects until M3-09 but Accept (below).
 *
 * Access is loaded, never checked afterwards (invariant 6): a classroom or
 * a project is reached through its course's `staffAccess`, by the caller's
 * own portal session only (`projectsClassroom`, `accessibleProject`); a
 * student, a teacher off the staff, an impersonation, a `seb` or `kiosk`
 * session get the 404 of a missing entity.
 *
 * The student's side (M3-03): Accept, on a project of a classroom where the
 * caller holds a claimed student seat (`studentProject`), by their own
 * portal session only. Nothing else of a project reaches a student until
 * the project's student view (M3-09).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { IdParam, ProjectAcceptance, ProjectCreate, ProjectListQuery, ProjectPatch, ProjectSourceParams } from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { accessibleProject, projectsClassroom, studentProject } from "../guards.js";
import { notFound, studentRoute, teacherRoute } from "../http.js";
import * as service from "./service.js";

export async function projectPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const teacher = teacherRoute(app);
  const student = studentRoute(app);
  const session = { preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply) };
  const onClassroom = { params: IdParam, load: projectsClassroom.bind(null, app) };
  const onProject = { params: IdParam, load: accessibleProject.bind(null, app) };

  // ------------------------------------------------------------ a classroom's projects

  app.get(
    "/app/api/classrooms/:id/projects",
    session,
    teacher({ ...onClassroom, query: ProjectListQuery }, async ({ query, scope }) =>
      service.classroomProjects(app.db, scope.room.id, query.archived === "1"),
    ),
  );

  app.post(
    "/app/api/classrooms/:id/projects",
    session,
    teacher({ ...onClassroom, body: ProjectCreate }, async ({ req, reply, now, body, scope }) => {
      const row = await service.createProject(app.db, config, {
        classroomId: scope.room.id,
        body,
        userId: req.user!.id,
        actor: actorOf(req),
        now,
        log: req.log,
      });
      return reply.code(201).send(await service.projectSummary(app.db, row, now));
    }),
  );

  /** The organization's repositories a project may hand out (M3-11's picker). */
  app.get(
    "/app/api/classrooms/:id/projects/sources",
    session,
    teacher(onClassroom, async ({ scope }) => service.listSources(app.db, config, scope.room.id)),
  );

  app.get(
    "/app/api/classrooms/:id/projects/sources/:repo",
    session,
    teacher(
      { params: ProjectSourceParams, load: projectsClassroom.bind(null, app) },
      async ({ reply, params, scope }) =>
        (await service.sourceDetail(app.db, config, scope.room.id, params.repo)) ?? notFound(reply),
    ),
  );

  // ------------------------------------------------------------ one project

  app.get(
    "/app/api/projects/:id",
    session,
    teacher(onProject, async ({ now, scope }) => service.projectSummary(app.db, scope.project, now)),
  );

  app.patch(
    "/app/api/projects/:id",
    session,
    teacher({ ...onProject, body: ProjectPatch }, async ({ req, now, body, scope }) => {
      const row = await service.patchProject(app.db, scope.project.id, body, actorOf(req), now);
      return service.projectSummary(app.db, row, now);
    }),
  );

  /** D19, F-PROJ-16: the rows only, in any state; nothing is deleted on GitHub. */
  app.delete(
    "/app/api/projects/:id",
    session,
    teacher(onProject, async ({ req, reply, scope }) => {
      await service.deleteProject(app.db, scope.project, actorOf(req));
      return reply.code(204).send();
    }),
  );

  app.post(
    "/app/api/projects/:id/publish",
    session,
    teacher(onProject, async ({ req, now, scope }) => {
      const row = await service.publishProject(app.db, scope.project.id, now, actorOf(req));
      return service.projectSummary(app.db, row, now);
    }),
  );

  app.post(
    "/app/api/projects/:id/archive",
    session,
    teacher(onProject, async ({ req, now, scope }) => {
      const row = await service.setProjectArchived(app.db, scope.project, true, actorOf(req), now);
      return service.projectSummary(app.db, row, now);
    }),
  );

  app.post(
    "/app/api/projects/:id/unarchive",
    session,
    teacher(onProject, async ({ req, now, scope }) => {
      const row = await service.setProjectArchived(app.db, scope.project, false, actorOf(req), now);
      return service.projectSummary(app.db, row, now);
    }),
  );

  // ------------------------------------------------------------ the student's side (M3-03)

  /**
   * F-PROJ-05: the caller's own repository, provisioned in the request.
   * The answer names that repository only (`ProjectAcceptance`, N-SEC-20).
   */
  app.post(
    "/app/api/student/projects/:id/accept",
    session,
    student({ params: IdParam, load: studentProject.bind(null, app) }, async ({ req, now, scope }) =>
      ProjectAcceptance.parse(
        await service.acceptProject(app.db, config, {
          project: scope.project,
          org: scope.org,
          userId: req.user!.id,
          actor: actorOf(req),
          now,
          log: req.log,
        }),
      ),
    ),
  );
}
