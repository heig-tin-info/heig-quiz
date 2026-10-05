/**
 * HTTP surface of the notifications: the bell (F-POOL-05), the per-kind
 * channel preferences and the Microsoft Teams link (ADR-030).
 *
 * `requireSession`, not `teacherGuard`: a notification is addressed to an
 * ACCOUNT, and the kinds a student receives (a released result) belong to
 * the same inbox and the same settings.
 *
 * Ownership is never checked after the fact — it is part of every query
 * (invariant 6), so `POST /notifications/:id/read` on somebody else's row is
 * a 404 indistinguishable from a row that never existed.
 *
 * Two Teams routes are PUBLIC, and nothing else here is: the tab's
 * endpoint, which the HEIG Quiz tab inside Teams calls with the user's Teams
 * SSO token (there is no Quiz session inside Teams — the cookies are
 * SameSite=Lax — so no CSRF check either: nothing here reads a cookie), and
 * the Teams app package, which holds no secret.
 */
import type { FastifyInstance } from "fastify";

import {
  IdParam,
  NotificationPreferencePut,
  NotificationQuery,
  TeamsLinkBody,
  type TeamsLinkPreview,
  type TeamsTabState,
} from "@quiz/contracts";

import { tracer } from "../../audit.js";
import { teamsEnabled, type AppConfig } from "../../config.js";
import { githubApp } from "../../github/app.js";
import * as service from "./service.js";
import { createSsoTokenVerifier, SsoAuthError } from "./ssoAuth.js";
import { teamsAppPackage } from "./teamsApp.js";
import {
  accountName,
  consumeLinkToken,
  issueLinkToken,
  previewLinkToken,
  teamsLinkOf,
  type AllowedTenants,
} from "./teamsLink.js";

const TEAMS_PATH = "/app/api/notifications/teams";

export async function notificationsPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const trace = tracer(app);
  const teamsOn = teamsEnabled(config);
  const tenants: AllowedTenants = config.TEAMS_ALLOWED_TENANTS;
  const verifier = teamsOn ? createSsoTokenVerifier({ appId: config.TEAMS_CLIENT_ID, tenants }) : null;

  /** Any signed-in account; the inbox is per user, whatever their role. */
  const requireSession = (
    req: Parameters<FastifyInstance["requireSession"]>[0],
    reply: Parameters<FastifyInstance["requireSession"]>[1],
  ) => app.requireSession(req, reply);

  app.get("/app/api/notifications", { preHandler: requireSession }, async (req, reply) => {
    const query = NotificationQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "validation" });
    return service.listNotifications(app.db, req.user!.id, query.data.limit);
  });

  app.post("/app/api/notifications/:id/read", { preHandler: requireSession }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const found = await service.markRead(app.db, req.user!.id, params.data.id);
    if (!found) return reply.code(404).send({ error: "not_found" });
    return service.listNotifications(app.db, req.user!.id);
  });

  app.post("/app/api/notifications/read-all", { preHandler: requireSession }, async (req) => {
    await service.markAllRead(app.db, req.user!.id);
    return service.listNotifications(app.db, req.user!.id);
  });

  // --- Channels and preferences ------------------------------------------

  // The project kinds are listed only where Quiz's App can send them (F-NOTIF-13).
  const githubOn = githubApp(config) !== null;
  app.get("/app/api/notifications/settings", { preHandler: requireSession }, async (req) =>
    service.notificationSettings(app.db, req.user!.id, teamsOn, githubOn),
  );

  /** One toggle of the kinds × channels grid; answers with the whole settings. */
  app.put("/app/api/notifications/preferences", { preHandler: requireSession }, async (req, reply) => {
    const body = NotificationPreferencePut.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation" });
    await service.setPreference(app.db, req.user!.id, body.data);
    return service.notificationSettings(app.db, req.user!.id, teamsOn, githubOn);
  });

  // --- Microsoft Teams: the tab ------------------------------------------

  /**
   * The HEIG Quiz tab in Teams asks who its user is linked to. No session:
   * the caller is the Teams account of the SSO token (`ssoAuth.ts`), and the
   * answer only ever concerns that account. Linked: the Quiz account's name.
   * Not linked: a new single-use link to `/teams/link`, to open in the
   * browser, where the Quiz session is — its unspent predecessors are gone.
   * `no-store`: the answer holds a secret, and changes on every call.
   */
  app.post(`${TEAMS_PATH}/tab`, { bodyLimit: 1024 }, async (req, reply) => {
    if (!verifier) return reply.code(404).send({ error: "not_found" });
    reply.header("cache-control", "no-store");
    let who;
    try {
      who = await verifier.verify(req.headers.authorization);
    } catch (err) {
      const status = err instanceof SsoAuthError ? err.status : 401;
      req.log.warn({ reason: err instanceof Error ? err.message : "?" }, "teams tab refused");
      return reply.code(status).send({ error: status === 403 ? "tenant_not_allowed" : "unauthorized" });
    }
    const link = await teamsLinkOf(app.db, who);
    if (link) {
      const linked: TeamsTabState = { state: "linked", accountName: await accountName(app.db, link.userId) };
      return linked;
    }
    const token = await issueLinkToken(app.db, who, app.clock.now());
    const unlinked: TeamsTabState = {
      state: "unlinked",
      // `WEB_URL` has no trailing slash: `config.ts` normalizes it once.
      linkUrl: `${config.WEB_URL}/teams/link?token=${token}`,
    };
    return unlinked;
  });

  /**
   * The Teams app package a user uploads into their own Teams. Public: it
   * holds the application id, which Teams shows anyway, and nothing else.
   * Built once, on first request.
   */
  let appPackage: Buffer | null = null;
  app.get(`${TEAMS_PATH}/app.zip`, async (_req, reply) => {
    if (!teamsOn) return reply.code(404).send({ error: "not_found" });
    appPackage ??= teamsAppPackage({ appId: config.TEAMS_CLIENT_ID, publicUrl: config.PUBLIC_URL });
    return reply
      .type("application/zip")
      .header("content-disposition", 'attachment; filename="heig-quiz-teams.zip"')
      .header("cache-control", "no-cache")
      .send(appPackage);
  });

  // --- Microsoft Teams: the link page -----------------------------------
  //
  // The token travels in a BODY, never in an API path: a path is what every
  // log line and proxy writes down.

  /** What the link would do, for the confirmation page; consumes nothing. */
  app.post(
    `${TEAMS_PATH}/link/preview`,
    { preHandler: requireSession, config: { readOnly: true } },
    async (req, reply) => {
      if (!teamsOn) return reply.code(404).send({ error: "not_found" });
      // Like `/link`: a person in a browser, never a personal API token.
      if (req.authVia !== "session") return reply.code(403).send({ error: "forbidden" });
      const body = TeamsLinkBody.safeParse(req.body);
      const pending = body.success
        ? await previewLinkToken(app.db, body.data.token, app.clock.now(), tenants)
        : null;
      if (!pending) return reply.code(404).send({ error: "link_invalid" });
      const preview: TeamsLinkPreview = {
        teamsName: pending.teamsName,
        teamsUsername: pending.teamsUsername || null,
        tenantId: pending.tenantId,
        expiresAt: pending.expiresAt.toISOString(),
      };
      return preview;
    },
  );

  /**
   * Links the Teams account to the signed-in account (the CSRF check of
   * `requireSession` applies). The token is consumed in the transaction that
   * writes the link — and only if its tenant is still allowed.
   */
  app.post(`${TEAMS_PATH}/link`, { preHandler: requireSession }, async (req, reply) => {
    if (!teamsOn) return reply.code(404).send({ error: "not_found" });
    // A person in a browser, never a personal API token (ADR-022) nor an assistant.
    if (req.authVia !== "session") return reply.code(403).send({ error: "forbidden" });
    const body = TeamsLinkBody.safeParse(req.body);
    if (!body.success) return reply.code(404).send({ error: "link_invalid" });
    const userId = req.user!.id;
    const outcome = await consumeLinkToken(app.db, userId, body.data.token, app.clock.now(), tenants);
    if (!outcome) return reply.code(404).send({ error: "link_invalid" });
    if (outcome.displaced) {
      await trace(req, "teams.unlink", "user", outcome.displaced, { via: "moved", to: userId });
    }
    await trace(req, "teams.link", "user", userId, { tenantId: outcome.link.tenantId });
    return service.notificationSettings(app.db, userId, teamsOn, githubOn);
  });

  /** Forgets the link. Nothing is uninstalled at Microsoft: the user owns their Teams. */
  app.delete(TEAMS_PATH, { preHandler: requireSession }, async (req, reply) => {
    if (!teamsOn) return reply.code(503).send({ error: "teams_unavailable" });
    const removed = await service.unlinkTeams(app.db, { userId: req.user!.id });
    if (removed) await trace(req, "teams.unlink", "user", req.user!.id);
    return service.notificationSettings(app.db, req.user!.id, teamsOn, githubOn);
  });
}
