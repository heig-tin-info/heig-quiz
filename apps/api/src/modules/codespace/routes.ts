/**
 * HTTP surface of the `codespace` module (ADR-047 as amended 2026-10-07,
 * merge tasks M6-06 and M6-07). Registered only when the portal is
 * configured (`CODESPACE_URL`) and Quiz's App is (projects need it):
 * otherwise none of these routes exists, a 404 like any missing entity
 * (ADR-047 §5). Every body is a schema of `@quiz/contracts`' `codespace.ts`
 * (invariant 7).
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
 * The student's: `GET /app/api/projects/:id/seb`, the `.seb` of an
 * `online_seb` project (D21 point 2), and `GET /app/codespace/start/:id`, a
 * navigable GET, both described on the route.
 *
 * The portal's (ADR-078, M6-10): `POST /app/codespace/git-token` and
 * `POST /app/codespace/relay-heads`, signed service calls (`relay.ts`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  GIT_TOKEN_PATH,
  IdParam,
  ProjectWorkModeBody,
  ProjectWorkspaceSyncAccepted,
  RELAY_HEADS_PATH,
  workspaceStartPath,
} from "@quiz/contracts";
import { isOnlineMode } from "@quiz/domain";

import { actorOf, audit } from "../../audit.js";
import { sendLaunchFile } from "../../auth/seb.js";
import { PROJECT_SEB } from "../../auth/session.js";
import type { AppConfig } from "../../config.js";
import {
  accessibleProject,
  callerOf,
  findStudentProjectView,
  isCourseOwner,
  ownPortalSession,
  sebProjectSession,
  withCourseRole,
} from "../guards.js";
import { DomainError, notFound, teacherRoute } from "../http.js";
import * as project from "../project/service.js";
import { declareRelayHeads, issueGitToken } from "./relay.js";
import {
  grantOf,
  projectSessions,
  projectWorkspace,
  requestCodespaceSync,
  sebProjectSeat,
  startWorkspace,
} from "./service.js";

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
      if (!isOnlineMode(scope.project.workMode)) {
        throw new DomainError("not_online", 409, "This project does not use the online workspace");
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

  // ------------------------------------------------------------ the student's

  /**
   * The `.seb` of an `online_seb` project (D21 point 2), the twin of an
   * evaluation's (`auth/seb.ts`): the student's own portal session (an
   * impersonation, a confined session, a token: the 404), a claimed seat in
   * the project's classroom (`sebProjectSeat`), anyone else the 404. Its
   * start URL is Quiz's ticket route, so SEB needs no second sign-in; its
   * URL filter adds the portal's host. A GET, a plain download link.
   */
  app.get("/app/api/projects/:id/seb", session, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    const seat = params.success && ownPortalSession(req.auth) && (await sebProjectSeat(app.db, callerOf(req), params.data.id));
    if (!seat) return notFound(reply);
    return sendLaunchFile(app, config, req, reply, { evaluationId: null, projectId: seat.id });
  });

  /**
   * The student's *Open workspace* (ADR-047 §6). A navigable GET: an
   * anonymous visitor — or a confined session it does not serve (ADR-027's
   * default deny: an evaluation's, a kiosk) — goes through the sign-in and
   * comes back. Then, in order:
   *
   *   1. the caller's OWN portal session, or a `seb` session confined to
   *      THIS project (D21 point 3, `PROJECT_SEB`) — an impersonation, a
   *      Bearer token, another project's `seb` session: the 404 —, and the
   *      project through its classroom's student branch
   *      (`findStudentProjectView`: published, not archived) with a claimed
   *      seat of theirs — anyone else, the 404 of a missing project;
   *   2. the refusals a student can read (`workspaceStartRefusal` of
   *      `@quiz/domain`, in `startWorkspace`'s transaction), sent back to
   *      their project page as `?workspace=<code>`: `not_online`,
   *      `seb_required` (an `online_seb` project opens from its `seb`
   *      session only), `not_accepted`, `closed`;
   *   3. the first launch marked (the mode frozen from then on; never by a
   *      staff seat, ADR-077: a teacher testing it freezes nothing), a 5-minute
   *      launch token with a random `jti` — and, from a `seb` session, its
   *      Config Key in the `seb` claim, which the portal checks SEB's header
   *      against (D21 point 4) —, audited `codespace.launch_issued` by its
   *      `jti` alone, and a 303 to `${CODESPACE_URL}/launch?token=…`. The
   *      token is never logged, stored nor audited; the request log never
   *      sees a response header.
   *
   * A full quota is the portal's to refuse (its 429): Quiz cannot count the
   * live workspaces.
   */
  app.get("/app/codespace/start/:id", { config: PROJECT_SEB }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    // A Bearer token is read on the JSON API only (ADR-022) and never launches: the 404, not the sign-in.
    if (req.headers.authorization !== undefined) return notFound(reply);
    if (!req.user) {
      const next = workspaceStartPath(params.data.id);
      return reply.redirect(`/app/auth/login?next=${encodeURIComponent(next)}`, 303);
    }
    const fromSeb = sebProjectSession(req.auth, params.data.id);
    if (!ownPortalSession(req.auth) && !fromSeb) return notFound(reply);
    const scope = await findStudentProjectView(app.db, callerOf(req), req.auth, params.data.id);
    if (scope === null || scope.seat === null) return notFound(reply);
    const launch = await startWorkspace(
      app.db,
      config,
      params.data.id,
      {
        user: req.user,
        staffSeat: scope.seat.staff,
        classroomArchived: scope.room.archivedAt !== null,
        actor: actorOf(req),
        sebConfigKey: fromSeb ? req.auth!.sebConfigKey : null,
      },
      app.clock.now(),
    );
    if (launch === null) return notFound(reply);
    if (typeof launch === "string") {
      return reply.redirect(`/projects/${encodeURIComponent(params.data.id)}?workspace=${launch}`, 303);
    }
    return reply.redirect(`${config.CODESPACE_URL}/launch?token=${encodeURIComponent(launch.token)}`, 303);
  });

  // ------------------------------------------------------------ the portal's (ADR-078)

  /**
   * The git relay's two service routes, called by the portal and by nobody
   * else: no session, no personal API token (they are not under
   * `/app/api/`); the request IS the HS256 token of `Authorization`, over
   * `CODESPACE_LAUNCH_SECRET`, each with its own audience. The body is
   * empty. Every answer is `no-store`: a grant is a live credential, and
   * the request log never sees a response body.
   */
  app.post(GIT_TOKEN_PATH, async (req, reply) => {
    const outcome = await issueGitToken(app, config, req.headers.authorization, req.log);
    reply.header("cache-control", "no-store");
    if ("status" in outcome) return reply.code(outcome.status).send({ error: outcome.error });
    return reply.send(outcome);
  });

  app.post(RELAY_HEADS_PATH, async (req, reply) => {
    const refusal = await declareRelayHeads(app, config, req.headers.authorization, req.log);
    reply.header("cache-control", "no-store");
    if (refusal) return reply.code(refusal.status).send({ error: refusal.error });
    return reply.code(204).send();
  });
}
