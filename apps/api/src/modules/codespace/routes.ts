/**
 * HTTP surface of the `codespace` module (ADR-047 as amended 2026-10-07,
 * merge task M6-06). Registered only when the portal is configured
 * (`CODESPACE_URL`) and Quiz's App is (projects need it): otherwise none of
 * these routes exists, a 404 like any missing entity (ADR-047 §5). Every
 * body is a schema of `@quiz/contracts`' `codespace.ts` (invariant 7).
 *
 * The staff's, on a project they reach (`accessibleProject`: the course's
 * `staffAccess`, their own portal session; anyone else the 404):
 *   - `GET  /app/api/projects/:id/workspace` — the mode, what the caller may
 *     set, the last sync;
 *   - `PUT  /app/api/projects/:id/workspace/mode` — the mode, an owner's
 *     (`403 owner_required` in the loader, before the body, ADR-068), with
 *     the grant to go online (`403 codespace_not_granted`), until a
 *     workspace was launched (`409 work_mode_frozen`);
 *   - `POST /app/api/projects/:id/workspace/sync` — *Resync*: the job sent
 *     again (202);
 *   - `GET  /app/api/projects/:id/workspace/sessions` — the project's
 *     workspaces, live from the portal.
 *
 * The student's: `GET /app/codespace/start/:id`, a navigable GET (it is
 * also Safe Exam Browser's `startURL`, M6-07), described on the route.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { IdParam, ProjectWorkModeBody, ProjectWorkspaceSyncAccepted, workspaceStartPath } from "@quiz/contracts";
import { syncsToPortal } from "@quiz/domain";

import { actorOf, audit } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import {
  accessibleProject,
  callerOf,
  findStudentProjectView,
  isCourseOwner,
  ownPortalSession,
  withCourseRole,
} from "../guards.js";
import { DomainError, notFound, teacherRoute } from "../http.js";
import * as project from "../project/service.js";
import { grantOf, projectSessions, projectWorkspace, requestCodespaceSync, startWorkspace } from "./service.js";

export async function codespacePlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const teacher = teacherRoute(app);
  const session = { preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply) };
  const onProject = { params: IdParam, load: accessibleProject.bind(null, app) };
  const onOwnedProject = {
    params: IdParam,
    load: withCourseRole(app, accessibleProject.bind(null, app), (scope) => scope.course.id, "owner"),
  };

  // ------------------------------------------------------------ the staff's

  app.get(
    "/app/api/projects/:id/workspace",
    session,
    teacher(onProject, async ({ req, scope }) =>
      projectWorkspace(app.db, scope.project, {
        userId: req.user!.id,
        owner: await isCourseOwner(app.db, scope.course.id, callerOf(req)),
      }),
    ),
  );

  app.put(
    "/app/api/projects/:id/workspace/mode",
    session,
    teacher({ ...onOwnedProject, body: ProjectWorkModeBody }, async ({ req, body, scope }) => {
      const granted = (await grantOf(app.db, req.user!.id))?.enabled === true;
      const row = await project.setWorkMode(app.db, scope.project.id, body.mode, { owner: true, granted }, actorOf(req));
      await requestCodespaceSync(app, config, row.id);
      project.projectsChanged([scope.course.id]);
      return projectWorkspace(app.db, row, { userId: req.user!.id, owner: true });
    }),
  );

  app.post(
    "/app/api/projects/:id/workspace/sync",
    session,
    teacher(onProject, async ({ req, reply, now, scope }) => {
      if (!syncsToPortal(scope.project.workMode)) {
        // An exam's sync carries its Browser Exam Keys, which come with M6-07.
        throw scope.project.workMode === "free"
          ? new DomainError("not_online", 409, "This project does not use the online workspace")
          : new DomainError("seb_required", 409, "A Safe Exam Browser project is synced from M6-07 on");
      }
      await audit(app.db, { ...actorOf(req), action: "codespace.sync_requested", subjectType: "project", subjectId: scope.project.id });
      await requestCodespaceSync(app, config, scope.project.id);
      return reply.code(202).send(ProjectWorkspaceSyncAccepted.parse({ requestedAt: now.toISOString() }));
    }),
  );

  app.get(
    "/app/api/projects/:id/workspace/sessions",
    session,
    teacher(onProject, async ({ scope }) => projectSessions(app, config, scope.project)),
  );

  // ------------------------------------------------------------ the student's start

  /**
   * The student's *Open workspace* (ADR-047 §6). A navigable GET: an
   * anonymous visitor — or a confined session, which this route does not
   * serve (ADR-027's default deny), so a `seb` or `kiosk` session until
   * M6-07 — goes through the sign-in and comes back. Then, in order:
   *
   *   1. the caller's OWN portal session (an impersonation, a Bearer token:
   *      the 404), and the project through its classroom's student branch
   *      (`findStudentProjectView`: published, not archived) with a claimed
   *      seat of theirs — anyone else, the 404 of a missing project;
   *   2. the refusals a student can read (`workspaceStartRefusal` of
   *      `@quiz/domain`, in `startWorkspace`'s transaction), sent back to
   *      their project page as `?workspace=<code>`: `not_online`,
   *      `seb_required` (an `online_seb` project opens from SEB only,
   *      M6-07), `not_accepted`, `closed`;
   *   3. the first launch marked (the mode frozen from then on; never by a
   *      staff seat, ADR-077: a teacher testing it freezes nothing), a 5-minute
   *      launch token with a random `jti`, audited
   *      `codespace.launch_issued` by its `jti` alone, and a 303 to
   *      `${CODESPACE_URL}/launch?token=…`. The token is never logged,
   *      stored nor audited; the request log never sees a response header.
   *
   * A full quota is the portal's to refuse (its 429): Quiz cannot count the
   * live workspaces.
   */
  app.get("/app/codespace/start/:id", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    // A Bearer token is read on the JSON API only (ADR-022) and never launches: the 404, not the sign-in.
    if (req.headers.authorization !== undefined) return notFound(reply);
    if (!req.user) {
      const next = workspaceStartPath(params.data.id);
      return reply.redirect(`/app/auth/login?next=${encodeURIComponent(next)}`, 303);
    }
    if (!ownPortalSession(req.auth)) return notFound(reply);
    const scope = await findStudentProjectView(app.db, callerOf(req), req.auth, params.data.id);
    if (scope === null || scope.seat === null) return notFound(reply);
    const launch = await startWorkspace(
      app.db,
      config,
      params.data.id,
      { user: req.user, staffSeat: scope.seat.staff, classroomArchived: scope.room.archivedAt !== null, actor: actorOf(req) },
      app.clock.now(),
    );
    if (launch === null) return notFound(reply);
    if (typeof launch === "string") {
      return reply.redirect(`/projects/${encodeURIComponent(params.data.id)}?workspace=${launch}`, 303);
    }
    return reply.redirect(`${config.CODESPACE_URL}/launch?token=${encodeURIComponent(launch.token)}`, 303);
  });
}
