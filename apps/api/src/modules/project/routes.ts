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
 * session get the 404 of a missing entity. A classroom's projects, its
 * sources and the creation also take a personal or OAuth token
 * (`projectsAuthoringClassroom`), so the MCP server creates a draft through
 * them (ADR-022, addendum of 2026-10-13).
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
  CriterionCiLog,
  CriterionGradeWrite,
  ProjectCommitGraph,
  ProjectCreate,
  ProjectCriterionParams,
  ProjectDistributionAccess,
  ProjectGradingRepo,
  ProjectGradingView,
  ProjectGroupResync,
  ProjectValidated,
  ProjectListQuery,
  ProjectPatch,
  ProjectRegradeAccepted,
  ProjectRepoDeadline,
  ProjectRepoParams,
  ProjectSourceParams,
  ProjectSourceQuery,
  ReviewCheckpointCreate,
  ScoreOverride,
} from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import { PROJECT_SEB } from "../../auth/session.js";
import type { AppConfig } from "../../config.js";
import {
  accessibleProject,
  accessibleProjectRepo,
  callerOf,
  projectsAuthoringClassroom,
  projectsClassroom,
  seatOf,
  studentProject,
  studentProjectView,
  withCourseRole,
  withRoleStep,
} from "../guards.js";
import { codespaceOn, requestCodespaceSync } from "../codespace/service.js";
import { notFound, studentRoute, teacherRoute } from "../http.js";
import { ownHints } from "../realtime/bus.js";
import * as service from "./service.js";
import { registerProjectHandlers } from "./webhooks.js";

/** What the portal reads of a project (`CodespaceAssignmentSync`): a patch of any of them is synced. */
const PORTAL_FIELDS = ["name", "publishMode", "startAt", "deadlineAt", "durationMinutes"] as const;

export async function projectPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  // Its hints are its own, never `classroom:` (N-SEC-20, `project/events.ts`).
  app.addHook("onRoute", ownHints);
  // GitHub's events on projects (M3-04), on the `github` module's registry.
  registerProjectHandlers();
  const teacher = teacherRoute(app);
  const student = studentRoute(app);
  const session = { preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply) };
  const onClassroom = { params: IdParam, load: projectsAuthoringClassroom.bind(null, app) };
  const onProject = { params: IdParam, load: accessibleProject.bind(null, app) };
  // What reaches the students — the release — is the course owner's call
  // (ADR-068): an assistant gets `403 owner_required`.
  const onOwnedProject = {
    params: IdParam,
    load: withCourseRole(app, accessibleProject.bind(null, app), (scope) => scope.course.id, "owner"),
  };
  // A staff member's own access to the distribution (ADR-062, amendment of
  // 2026-10-26): a seat on the course staff, whatever its role; Super Powers
  // without one get `403 staff_seat_required` (`requireCourseRole` would
  // give them an effective role).
  const onSeatedProject = {
    params: IdParam,
    load: withRoleStep(accessibleProject.bind(null, app), async (req, reply, scope) => {
      if (await seatOf(app.db, scope.course.id, req.user!.id)) return true;
      await reply.code(403).send({ error: "staff_seat_required", message: "Only a seat on the course staff may ask for access" });
      return false;
    }),
  };
  // A grading write by criteria (ADR-106 §8, 05 §5.11): an owner or an assistant of the course.
  const onStaffedProject = {
    params: IdParam,
    load: withCourseRole(app, accessibleProject.bind(null, app), (scope) => scope.course.id, "assistant"),
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
        caller: callerOf(req),
        actor: actorOf(req),
        now,
        log: req.log,
      });
      // The other staff's lists re-read; the students hear of it only when it is published.
      service.projectsChanged([scope.course.id]);
      return reply.code(201).send(await service.projectSummary(app.db, row, now));
    }),
  );

  /** The organization's repositories a project may hand out (M3-11's picker). */
  app.get(
    "/app/api/classrooms/:id/projects/sources",
    session,
    teacher(onClassroom, async ({ req, scope }) => service.listSources(app.db, config, scope.room.id, callerOf(req))),
  );

  /**
   * One source, and what the students would receive from it (ADR-119 §9):
   * the handed-out tree and its `criteria.yml` parsed at schema 3. The
   * course's staff only (`staffAccess`): anyone else gets the 404 of a
   * missing classroom.
   */
  app.get(
    "/app/api/classrooms/:id/projects/sources/:repo",
    session,
    teacher(
      { params: ProjectSourceParams, query: ProjectSourceQuery, load: projectsClassroom.bind(null, app) },
      async ({ req, reply, params, query, scope }) =>
        (await service.sourceDetail(app.db, config, scope.room.id, params.repo, callerOf(req), query)) ?? notFound(reply),
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
    // A write of the settings: the course role (owner or assistant, ADR-068).
    teacher({ ...onStaffedProject, body: ProjectPatch }, async ({ req, now, body, scope }) => {
      // A switch to `criteria` reads the source's file first, outside the row's lock (ADR-106 §1).
      const criteria = await service.criteriaForSwitch(app.db, config, scope.project, body, now);
      const row = await service.patchProject(app.db, scope.project.id, body, actorOf(req), now, criteria);
      // A reopen's locks are lifted by the deadline job, never by 100 calls here (M3-05a).
      if (body.deadlineAt !== undefined) await service.requestDeadlineWork(app, config, row.id);
      // The portal reads the name and the dates of an online project (ADR-047 §6): nothing else moves it.
      if (PORTAL_FIELDS.some((field) => body[field] !== undefined)) await requestCodespaceSync(app, config, row.id);
      return service.projectSummary(app.db, row, now);
    }),
  );

  /**
   * Grading by criteria (ADR-106 §2): the snapshot of the source's
   * `criteria.yml` and the settings, and its reload from the distribution
   * repository's head (`409 criteria_invalid` keeps the last snapshot).
   * The project's staff, like its settings.
   */
  app.get(
    "/app/api/projects/:id/criteria",
    session,
    teacher(onProject, async ({ scope }) => service.criteriaView(app.db, scope.project)),
  );

  app.post(
    "/app/api/projects/:id/criteria/reload",
    session,
    teacher(onProject, async ({ req, now, scope }) => service.reloadCriteria(app.db, config, scope.project, actorOf(req), now)),
  );

  /**
   * ADR-106 §4: a Regrade of every repository frozen for good — 202 with
   * the counts the confirmation priced; `409 not_criteria`, `409
   * not_frozen`, `429 regrade_limit`. A write: the course role
   * (`requireCourseRole`, owner or assistant).
   */
  app.post(
    "/app/api/projects/:id/regrade",
    session,
    teacher(onStaffedProject, async ({ req, reply, now, scope }) =>
      reply.code(202).send(ProjectRegradeAccepted.parse(await service.regrade(app, config, scope.project, null, actorOf(req), now))),
    ),
  );

  /**
   * ADR-106 §8: the grading screen's payload (staff, `409 not_criteria`
   * off the mode), and *Validate the rest as proposed* — 202 with the
   * repositories validated, `409 criteria_incomplete` naming each
   * repository and criterion without a row, `409 not_frozen`. The write:
   * the course role.
   */
  app.get(
    "/app/api/projects/:id/grading",
    session,
    teacher(onProject, async ({ scope }) => ProjectGradingView.parse(await service.gradingView(app.db, scope.project))),
  );

  app.post(
    "/app/api/projects/:id/validate",
    session,
    teacher(onStaffedProject, async ({ req, reply, now, scope }) =>
      reply.code(202).send(ProjectValidated.parse(await service.validateProject(app.db, scope.project, actorOf(req), now))),
    ),
  );

  /** The caller's own `pull` on the distribution repository (ADR-062, amendment of 2026-10-26). */
  app.post(
    "/app/api/projects/:id/distribution/access",
    session,
    teacher(onSeatedProject, async ({ req, scope }) =>
      ProjectDistributionAccess.parse(
        await service.requestDistributionAccess(
          app.db,
          config,
          scope.project,
          req.user!.id,
          actorOf(req),
          req.log,
        ),
      ),
    ),
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
      await requestCodespaceSync(app, config, row.id);
      await service.refreshCriteria(app.db, config, row.id, "publish", actorOf(req), now, req.log);
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
  const onStaffedRepo = {
    params: ProjectRepoParams,
    load: withCourseRole(app, accessibleProjectRepo.bind(null, app), (scope) => scope.courseId, "assistant"),
  };

  /**
   * ADR-106 §6: the repository's criteria table for its staff — each
   * criterion's current row, source, rationale (plain text) and reason —
   * and its last evidence's summary, never its files.
   */
  app.get(
    "/app/api/projects/:id/repos/:rid/criteria",
    session,
    teacher(onRepo, async ({ scope }) => ProjectGradingRepo.parse(await service.gradingRepo(app.db, scope.project, scope.repo))),
  );

  /** ADR-119 §8: a criterion's CI log for its staff, read when its fold opens (a 404 for an unknown criterion). */
  app.get(
    "/app/api/projects/:id/repos/:rid/criteria/:criterionId/ci-log",
    session,
    teacher({ params: ProjectCriterionParams, load: onRepo.load }, async ({ params, scope }) =>
      CriterionCiLog.parse(await service.criterionCiLog(app.db, scope.project, scope.repo, params.criterionId)),
    ),
  );

  /**
   * ADR-119 §8: the repository's commit graph for its staff — the
   * handed-out branches read through the App, cached as the live state,
   * never stored; `unavailable` without a repository or an answer.
   */
  app.get(
    "/app/api/projects/:id/repos/:rid/commits",
    session,
    teacher(onRepo, async ({ req, scope }) =>
      ProjectCommitGraph.parse(await service.repoCommitGraph(app.db, config, scope.project, scope.repo, req.log)),
    ),
  );

  /**
   * ADR-106 §8: a teacher's points for one criterion — a `manual` row,
   * still proposed (`422 points_out_of_range`, a 404 for an unknown
   * criterion, `409 not_criteria`, `409 not_frozen`); and the validation of
   * the repository's proposals (`409 criteria_incomplete` while a criterion
   * has no row). Writes: the course role. Both answer the repository's
   * entry of the grading screen.
   */
  app.put(
    "/app/api/projects/:id/repos/:rid/criteria/:criterionId",
    session,
    teacher(
      { params: ProjectCriterionParams, body: CriterionGradeWrite, load: onStaffedRepo.load },
      async ({ req, now, params, body, scope }) =>
        ProjectGradingRepo.parse(
          await service.gradeCriterion(app.db, scope.project, scope.repo, params.criterionId, body, actorOf(req), req.user!.id, now),
        ),
    ),
  );

  app.post(
    "/app/api/projects/:id/repos/:rid/validate",
    session,
    teacher(onStaffedRepo, async ({ req, now, scope }) =>
      ProjectGradingRepo.parse(await service.validateRepo(app.db, scope.project, scope.repo, actorOf(req), now)),
    ),
  );

  /** ADR-106 §4: a Regrade of one repository frozen for good; as the project's, it counts toward the day's three. */
  app.post(
    "/app/api/projects/:id/repos/:rid/regrade",
    session,
    teacher(onStaffedRepo, async ({ req, reply, now, scope }) =>
      reply.code(202).send(ProjectRegradeAccepted.parse(await service.regrade(app, config, scope.project, scope.repo, actorOf(req), now))),
    ),
  );

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
   * ADR-077; none without a seat), an impersonation session through the seat (ADR-034), a `seb`
   * session confined to THIS project through its seat (D21, `PROJECT_SEB`); anyone else, any
   * other `seb` or `kiosk` session, gets the 404 of a missing project.
   */
  app.get(
    "/app/api/student/projects/:id",
    { ...session, config: PROJECT_SEB },
    student({ params: IdParam, load: studentProjectView.bind(null, app) }, async ({ req, now, scope }) =>
      service.studentProject(app.db, scope, callerOf(req).id, now, { codespace: codespaceOn(config) }),
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
