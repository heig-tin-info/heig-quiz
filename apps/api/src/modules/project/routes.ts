/**
 * HTTP surface of the `project` module, the staff's lifecycle (spec 05
 * §5.11, merge task M3-02): a classroom's projects and their creation, the
 * organization's repository browser, one project's summary, patch, delete,
 * publish, archive and unarchive. Every body and payload is a schema of
 * `packages/contracts/src/project.ts` (invariant 7).
 *
 * From M3-08a, the staff's reads: the project page (`GET
 * /app/api/projects/:id`, `ProjectDetail`) and a repository's runs. From
 * M3-08b, the staff's writes: the release, and on one repository the
 * teacher's score, the protection re-enabled, an invitation resent.
 *
 * Registered only when Quiz's App is configured (`app.ts`), like the
 * `github` module: without it none of these routes exists. Open to every
 * member of a course's staff (D26 addendum, 2026-10-02).
 *
 * Access is loaded, never checked afterwards (invariant 6): a classroom or
 * a project is reached through its course's `staffAccess`, by the caller's
 * own portal session only (`projectsClassroom`, `accessibleProject`); a
 * student, a teacher off the staff, an impersonation, a `seb` or `kiosk`
 * session get the 404 of a missing entity.
 *
 * The student's side: Accept (M3-03) and their own resend of an invitation
 * (M3-09a), on a project of a classroom where the caller holds a claimed
 * student seat (`studentProject`), by their own portal session only; the
 * project's student view (M3-09a, `GET /app/api/student/projects/:id`),
 * through the classroom's student branch (`studentProjectView`): the ONE
 * exit of a project towards a student (N-SEC-20). The student's cards on
 * the home and the classroom page are the `activity` module's, drawn from
 * the same `studentView.ts`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  IdParam,
  ProjectAcceptance,
  ProjectCheckpointParams,
  ProjectCreate,
  ProjectGroupResync,
  ProjectListQuery,
  ProjectPatch,
  ProjectRepoDeadline,
  ProjectRepoParams,
  ProjectSourceParams,
  ReviewCheckpointCreate,
  ScoreOverride,
} from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import {
  accessibleProject,
  accessibleProjectRepo,
  callerOf,
  projectsClassroom,
  studentProject,
  studentProjectView,
  withCourseRole,
} from "../guards.js";
import { notFound, studentRoute, teacherRoute } from "../http.js";
import * as service from "./service.js";
import { registerProjectHandlers } from "./webhooks.js";

export async function projectPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  // GitHub's events on projects (M3-04), on the `github` module's registry.
  registerProjectHandlers();
  const teacher = teacherRoute(app);
  const student = studentRoute(app);
  const session = { preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply) };
  const onClassroom = { params: IdParam, load: projectsClassroom.bind(null, app) };
  const onProject = { params: IdParam, load: accessibleProject.bind(null, app) };
  // What reaches the students — the release — is the course owner's call
  // (ADR-068): an assistant gets `403 owner_required`.
  const onOwnedProject = {
    params: IdParam,
    load: withCourseRole(app, accessibleProject.bind(null, app), (scope) => scope.course.id, "owner"),
  };

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

  /**
   * F-PROJ-13: the project page — the summary, the counts, the primary
   * action, one row per student. Staff only, never a student's (N-SEC-20).
   */
  app.get(
    "/app/api/projects/:id",
    session,
    teacher(onProject, async ({ req, now, scope }) =>
      service.projectDetail(app.db, config, scope.project, now, { log: req.log }),
    ),
  );

  app.patch(
    "/app/api/projects/:id",
    session,
    teacher({ ...onProject, body: ProjectPatch }, async ({ req, now, body, scope }) => {
      const row = await service.patchProject(app.db, scope.project.id, body, actorOf(req), now);
      // A reopen's locks are lifted by the deadline job, never by 100 calls here (M3-05a).
      if (body.deadlineAt !== undefined) await service.requestDeadlineWork(app, config, row.id);
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

  /**
   * F-PROJ-14: the release, the course owner's (ADR-068) — every live repository frozen for good (`409
   * not_frozen`), the project graded (`409 grading_none`); a release again
   * rewrites the snapshots. `releaseProject` sends `project_grade_final`
   * to the students when `first` is true, and never on a release again.
   */
  app.post(
    "/app/api/projects/:id/release",
    session,
    teacher(onOwnedProject, async ({ req, now, scope }) =>
      service.releaseProject(app.db, scope.project.id, actorOf(req), req.user!.id, now),
    ),
  );

  /**
   * F-PROJ-12 (M3-07): the source's sync — the distribution repository
   * updated in the request, the pass over the repositories (the
   * `sync/<branch>` refs, the pull requests) queued: 202. A draft syncs its
   * distribution only; an archived project is refused.
   */
  app.post(
    "/app/api/projects/:id/sync",
    session,
    teacher(onProject, async ({ req, reply, now, scope }) =>
      reply.code(202).send(await service.requestSync(app, config, scope.project, actorOf(req), now, req.log)),
    ),
  );

  /**
   * ADR-070 §4, §6 (M3-15b-2b): *Resync with the set* — the copy brought
   * back in step with its set, stops lifted, its consequences confirmed by
   * digest (`409 needs_confirmation`); the GitHub part sent to the
   * `group.sync` job. 204, also when there is nothing to resync.
   */
  app.post(
    "/app/api/projects/:id/groups/resync",
    session,
    teacher({ ...onProject, body: ProjectGroupResync }, async ({ req, reply, now, body, scope }) => {
      const done = await service.resyncGroups(app.db, scope.project.id, { confirm: body.confirm, actor: actorOf(req), userId: req.user!.id, now });
      if (done) {
        service.projectsChanged([scope.course.id]);
        if (done.due) await service.requestGroupSync(app, config, [scope.project.id]);
      }
      return reply.code(204).send();
    }),
  );

  // ------------------------------------------------------------ one repository (M3-05a)

  const onRepo = { params: ProjectRepoParams, load: accessibleProjectRepo.bind(null, app) };

  /** F-PROJ-13: a repository's runs, the newest first, and its three slots. Database only. */
  app.get(
    "/app/api/projects/:id/repos/:rid/runs",
    session,
    teacher(onRepo, async ({ scope }) => service.repoRuns(app.db, scope.repo)),
  );

  /** D13 as amended: the repository's own deadline (an individual extension), or the project's again. */
  app.put(
    "/app/api/projects/:id/repos/:rid/deadline",
    session,
    teacher({ ...onRepo, body: ProjectRepoDeadline }, async ({ req, now, body, scope }) => {
      const at = body.deadlineAt === null ? null : new Date(body.deadlineAt);
      await service.setRepoDeadline(app.db, scope.project.id, scope.repo.id, at, actorOf(req), now);
      await service.requestDeadlineWork(app, config, scope.project.id);
      return service.repoDeadline(app.db, scope.repo.id);
    }),
  );

  /** F-PROJ-09: the staff lock or unlock one repository by hand; the deadline job makes GitHub hold it. */
  for (const action of ["lock", "unlock"] as const) {
    app.post(
      `/app/api/projects/:id/repos/:rid/${action}`,
      session,
      teacher(onRepo, async ({ req, scope }) => {
        await service.setStaffLock(app.db, scope.project.id, scope.repo.id, action === "lock", actorOf(req));
        await service.requestDeadlineWork(app, config, scope.project.id);
        return service.repoDeadline(app.db, scope.repo.id);
      }),
    );
  }

  // ------------------------------------------------------------ one repository's writes (M3-08b)

  /** F-PROJ-14: the teacher's score, after the repository's definitive freeze; null clears it. */
  app.patch(
    "/app/api/projects/:id/repos/:rid/score",
    session,
    teacher({ ...onRepo, body: ScoreOverride }, async ({ req, now, body, scope }) =>
      service.overrideScore(app.db, scope.project.id, scope.repo.id, body, actorOf(req), req.user!.id, now),
    ),
  );

  /** F-PROJ-08: the protected files restored again; only the restores from now on count toward the cap. */
  app.post(
    "/app/api/projects/:id/repos/:rid/protection",
    session,
    teacher(onRepo, async ({ req, now, scope }) =>
      service.reenableProtection(app.db, scope.project.id, scope.repo.id, actorOf(req), now),
    ),
  );

  /** F-PROJ-07: a pending invitation sent again with `push`, once a minute at most. */
  app.post(
    "/app/api/projects/:id/repos/:rid/invite",
    session,
    teacher(onRepo, async ({ req, now, scope }) =>
      service.resendInvitation(app.db, config, scope.project.id, scope.repo.id, actorOf(req), now, req.log),
    ),
  );

  // ------------------------------------------------------------ review checkpoints (M3-05b)

  /** F-PROJ-11: the project's review checkpoints, the earliest first. */
  app.get(
    "/app/api/projects/:id/checkpoints",
    session,
    teacher(onProject, async ({ scope }) => service.listCheckpoints(app.db, scope.project.id)),
  );

  /** A checkpoint: a name and a date, absolute or J−n of the deadline; dispatched by the `project.dispatch` job. */
  app.post(
    "/app/api/projects/:id/checkpoints",
    session,
    teacher({ ...onProject, body: ReviewCheckpointCreate }, async ({ req, reply, now, body, scope }) =>
      reply.code(201).send(await service.createCheckpoint(app.db, scope.project.id, body, actorOf(req), now)),
    ),
  );

  /** Refused once a dispatch of it was claimed for any repository (409 `checkpoint_dispatched`). */
  app.delete(
    "/app/api/projects/:id/checkpoints/:cid",
    session,
    teacher({ params: ProjectCheckpointParams, load: accessibleProject.bind(null, app) }, async ({ req, reply, params, scope }) => {
      if (!(await service.deleteCheckpoint(app.db, scope.project.id, params.cid, actorOf(req)))) return notFound(reply);
      return reply.code(204).send();
    }),
  );

  // ------------------------------------------------------------ the student's side (M3-03, M3-09a)

  /**
   * F-PROJ-15: the project as its student reads it — the one exit
   * (N-SEC-20). Through the classroom's student branch: a claimed seat, a
   * teacher in the student view (their staff seat's own test repository,
   * ADR-077; none without a seat), an impersonation session through the seat (ADR-034); anyone
   * else, a `seb` or `kiosk` session, gets the 404 of a missing project.
   */
  app.get(
    "/app/api/student/projects/:id",
    session,
    student({ params: IdParam, load: studentProjectView.bind(null, app) }, async ({ req, now, scope }) =>
      service.studentProject(app.db, scope, callerOf(req).id, now),
    ),
  );

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
          userId: req.user!.id,
          enrollmentId: scope.seat.id,
          actor: actorOf(req),
          now,
          log: req.log,
        }),
      ),
    ),
  );

  /**
   * F-PROJ-07: the student's own resend of their pending invitation — the
   * staff's rule and minute (`resendInvitation`), through the student's
   * loader, never the staff's route.
   */
  app.post(
    "/app/api/student/projects/:id/invite",
    session,
    student({ params: IdParam, load: studentProject.bind(null, app) }, async ({ req, now, scope }) =>
      service.studentResendInvitation(app.db, config, scope.project, scope.seat.id, actorOf(req), now, req.log),
    ),
  );
}
