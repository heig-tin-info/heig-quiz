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
 *     workspaces, live from the portal;
 *   - `POST /app/api/projects/:id/repos/:rid/workspace/review` — a review
 *     session of one repository (ADR-129), described on the route;
 *   - `POST /app/api/projects/:id/workspace/distribution` — an owner's review
 *     session of the distribution repository (ADR-147), described on the route;
 *   - a course's workspace images and a project's choice (ADR-146),
 *     `imageRoutes.ts`.
 *
 * The student's: `GET /app/api/projects/:id/seb`, the `.seb` of an
 * `online_seb` project (D21 point 2), and `POST
 * /app/api/projects/:id/workspace/start`, the launch, both described on the
 * route.
 *
 * The portal's (ADR-078, M6-10): `POST /app/codespace/git-token` and
 * `POST /app/codespace/relay-heads`, signed service calls (`relay.ts`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  GIT_TOKEN_PATH,
  IdParam,
  ProjectRepoParams,
  ProjectWorkModeBody,
  ProjectWorkspaceSyncAccepted,
  RELAY_HEADS_PATH,
  WORKSPACE_DISTRIBUTION_ROUTE,
  WORKSPACE_REVIEW_ROUTE,
  WORKSPACE_START_ROUTE,
  type WorkspaceReview,
  type WorkspaceStart,
} from "@quiz/contracts";
import { isOnlineMode, projectIsLive, workSettingOf } from "@quiz/domain";

import { actorOf, audit } from "../../audit.js";
import { sendLaunchFile } from "../../auth/seb.js";
import { PROJECT_CONFINED } from "../../auth/session.js";
import { kioskProjectsOn, type AppConfig } from "../../config.js";
import {
  accessibleProject,
  accessibleProjectRepo,
  callerOf,
  findStudentProjectView,
  isCourseOwner,
  ownPortalSession,
  confinedProjectSession,
  withCourseRole,
  userOf,
} from "../guards.js";
import { DomainError, notFound, teacherRoute } from "../http.js";
import * as project from "../project/service.js";
import { registerImageRoutes } from "./imageRoutes.js";
import { declareRelayHeads, issueGitToken } from "./relay.js";
import {
  hasGrant,
  projectSessions,
  projectWorkspace,
  requestCodespaceSync,
  sebProjectSeat,
  startDistributionReview,
  startReview,
  startWorkspace,
  type LaunchVia,
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
    teacher(onProject, async ({ req, scope }) => {
      const caller = callerOf(req);
      return projectWorkspace(app.db, config, scope.project, scope.course.id, {
        userId: caller.id,
        owner: await isCourseOwner(app.db, scope.course.id, caller),
      });
    }),
  );

  app.put(
    "/app/api/projects/:id/workspace/mode",
    session,
    teacher({ ...onOwnedProject, body: ProjectWorkModeBody }, async ({ req, body, scope }) => {
      const granted = await hasGrant(app.db, callerOf(req).id);
      const to = workSettingOf(body);
      const caller = { owner: true, granted, kioskOffered: kioskProjectsOn(config) };
      const row = await project.setWorkMode(app.db, scope.project.id, to, caller, actorOf(req));
      await requestCodespaceSync(app, config, row.id);
      project.projectsChanged([scope.course.id]);
      return projectWorkspace(app.db, config, row, scope.course.id, { userId: callerOf(req).id, owner: true });
    }),
  );

  /**
   * The staff's review session (ADR-129 §5): a session write (double-submit
   * CSRF), no body. Before the route, the auth plugin: no session `401`, an
   * impersonation `403 impersonation_read_only`, a token whose scope does
   * not reach it N-SEC-22's `403`; a `seb` or `kiosk` session is not served
   * here (ADR-027: anonymous, the `401`). Then the loader: the caller's own
   * portal session, `staffAccess` on the project's course (or Super Powers),
   * and the repository by its id WITHIN that project — anyone and anything
   * else, an `api`-scope token included, the 404 of a missing project
   * (invariant 6). Then `staffReviewRefusal`, `409 { error }`; otherwise
   * `{ url }`, the portal's `/review?token=…`, `no-store`. The token is never
   * logged, stored nor audited (its `jti` is).
   */
  app.post(
    WORKSPACE_REVIEW_ROUTE,
    session,
    teacher({ params: ProjectRepoParams, load: accessibleProjectRepo.bind(null, app) }, async ({ req, reply, now, scope }) => {
      const review = await startReview(app.db, config, scope, { user: userOf(req), reach: callerOf(req).reach, actor: actorOf(req) }, now);
      if (typeof review === "string") return reply.code(409).send({ error: review });
      const started: WorkspaceReview = { url: `${config.CODESPACE_URL}/review?token=${encodeURIComponent(review.token)}` };
      return reply.header("cache-control", "no-store").send(started);
    }),
  );

  /**
   * An owner's review session of the project's distribution repository
   * (ADR-147 §4): a session write, no body. The auth plugin as for a
   * repository's review; then the loader: the caller's own portal session,
   * `staffAccess` on the course (or Super Powers), anyone else the 404 of a
   * missing project; then `requireCourseRole(owner)`, an assistant the `403
   * owner_required`. Then `distributionReviewRefusal`, `409 { error }`; in
   * any state of the project, a draft or a scheduled one included. Otherwise
   * `{ url }`, the portal's `/review?token=…`, `no-store`; the token is never
   * logged, stored nor audited (its `jti` is).
   */
  app.post(
    WORKSPACE_DISTRIBUTION_ROUTE,
    session,
    teacher(onOwnedProject, async ({ req, reply, now, scope }) => {
      const row = { project: scope.project, courseId: scope.course.id, classroomArchivedAt: scope.room.archivedAt };
      const review = await startDistributionReview(app.db, config, row, { user: userOf(req), reach: callerOf(req).reach, actor: actorOf(req) }, now);
      if (typeof review === "string") return reply.code(409).send({ error: review });
      const started: WorkspaceReview = { url: `${config.CODESPACE_URL}/review?token=${encodeURIComponent(review.token)}` };
      return reply.header("cache-control", "no-store").send(started);
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

  registerImageRoutes(app, config, { teacher, session, onProject });

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
   * The student's *Open workspace* (ADR-047 §6, as amended for audit L7): a
   * POST of the project page, under the double-submit CSRF check of every
   * session write — a launch freezes the work mode and mints a credential, so
   * a cross-site navigation must not be able to trigger it. In order:
   *
   *   1. a session (`401` without: the project page is behind the sign-in;
   *      an impersonation writes nothing, `403` before the route, ADR-034),
   *      the caller's OWN portal session, or a session confined to THIS
   *      project (`confinedProjectSession`: a `seb` one, D21 point 3, or a
   *      kiosk station's, ADR-089 §4; `PROJECT_CONFINED`) — a Bearer token,
   *      another project's confined session: the 404; an evaluation's is not
   *      served here at all —, and the project through its classroom's
   *      student branch (`findStudentProjectView`: published, not archived)
   *      with a claimed seat of theirs — anyone else, the 404 of a missing
   *      project. A station's request also needs an attestation under two
   *      minutes old (`freshAttestation`, else `423
   *      kiosk_attestation_stale`), and a suspended station's is the `423
   *      kiosk_suspended` (ADR-051 §6), both before the route;
   *   2. the refusals a student can read (`workspaceStartRefusal` of
   *      `@quiz/domain`, in `startWorkspace`'s transaction), `409 { error }`:
   *      `not_online`, `seb_required` / `kiosk_required` (an `online_seb`
   *      project opens from the trusted clients of its level only),
   *      `not_accepted`, `closed`;
   *   3. the first launch marked (the mode frozen from then on; never by a
   *      staff seat, ADR-077: a teacher testing it freezes nothing), a 5-minute
   *      launch token with a random `jti` — and, from a `seb` session, its
   *      Config Key in the `seb` claim, which the portal checks SEB's header
   *      against (D21 point 4); from a station, the `kiosk` claim: the
   *      station and the sitting —, audited `codespace.launch_issued` by its
   *      `jti` alone, and `{ url }`, the portal's `/launch?token=…`, which
   *      the page navigates to. The answer is `no-store`; the token is never
   *      logged, stored nor audited, and the request log never sees a body.
   *
   * A full quota is the portal's to refuse (its 429): Quiz cannot count the
   * live workspaces.
   */
  app.post(WORKSPACE_START_ROUTE, { ...session, config: { ...PROJECT_CONFINED, freshAttestation: true } }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const kind = confinedProjectSession(req.auth, params.data.id);
    if (!ownPortalSession(req.auth) && kind === null) return notFound(reply);
    // The trusted client's claim (D21 point 4, ADR-089 §4); a `seb` session with no stored Config Key carries none.
    const auth = req.auth!;
    let via: LaunchVia = kind === "seb" && auth.sebConfigKey !== null ? { kind, configKey: auth.sebConfigKey } : null;
    if (kind === "kiosk") {
      // A type guard: a station's session always names its station and its sitting, which the claim needs.
      if (auth.deviceId === null || auth.kioskPairingId === null) return notFound(reply);
      via = { kind, deviceId: auth.deviceId, sitting: auth.kioskPairingId };
    }
    const scope = await findStudentProjectView(app.db, callerOf(req), req.auth, params.data.id);
    // A project not open yet (scheduled, ADR-127) is a 404 before any test of its mode (N-SEC-20).
    if (scope === null || scope.seat === null || !projectIsLive(scope.project.state)) return notFound(reply);
    const launch = await startWorkspace(
      app.db,
      config,
      params.data.id,
      {
        user: userOf(req),
        staffSeat: scope.seat.staff,
        classroomArchived: scope.room.archivedAt !== null,
        actor: actorOf(req),
        via,
      },
      app.clock.now(),
    );
    if (launch === null) return notFound(reply);
    if (typeof launch === "string") return reply.code(409).send({ error: launch });
    const started: WorkspaceStart = { url: `${config.CODESPACE_URL}/launch?token=${encodeURIComponent(launch.token)}` };
    return reply.header("cache-control", "no-store").send(started);
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
