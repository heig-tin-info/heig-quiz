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
 * Two Teams routes are PUBLIC, and nothing else here is: the bot's
 * messaging endpoint, which Microsoft calls with its own signed token (no
 * session, so no CSRF check either), and the Teams app package, which holds
 * no secret.
 */
import type { FastifyInstance } from "fastify";

import {
  IdParam,
  NotificationPreferencePut,
  NotificationQuery,
  TeamsActivity,
  TeamsLinkBody,
  type TeamsLinkPreview,
} from "@quiz/contracts";

import { tracer } from "../../audit.js";
import { teamsEnabled, type AppConfig } from "../../config.js";
import { accountName, handleActivity, type BotDeps } from "./bot.js";
import { BotAuthError, createBotTokenVerifier, type BotClaims } from "./botAuth.js";
import * as service from "./service.js";
import { allowedServiceUrl, createTeamsClient, TeamsError } from "./teams.js";
import { teamsAppPackage } from "./teamsApp.js";
import { consumeLinkToken, previewLinkToken, type AllowedTenants } from "./teamsLink.js";
import { botText, mailLocale } from "./templates.js";

const TEAMS_PATH = "/app/api/notifications/teams";
/** An activity is a few kilobytes; Teams caps a message at 28 KB of text. */
const ACTIVITY_BODY_LIMIT = 64 * 1024;

declare module "fastify" {
  interface FastifyRequest {
    /** The claims of the Bot Connector token of a messaging call; null elsewhere. */
    botClaims: BotClaims | null;
  }
}

export async function notificationsPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const trace = tracer(app);
  const teamsOn = teamsEnabled(config);
  const teams = teamsOn ? createTeamsClient(config) : null;
  const verifier = teamsOn ? createBotTokenVerifier({ appId: config.TEAMS_CLIENT_ID }) : null;
  const tenants: AllowedTenants = config.TEAMS_ALLOWED_TENANTS;
  app.decorateRequest("botClaims", null);

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

  app.get("/app/api/notifications/settings", { preHandler: requireSession }, async (req) =>
    service.notificationSettings(app.db, req.user!.id, teamsOn),
  );

  /** One toggle of the kinds × channels grid; answers with the whole settings. */
  app.put("/app/api/notifications/preferences", { preHandler: requireSession }, async (req, reply) => {
    const body = NotificationPreferencePut.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation" });
    await service.setPreference(app.db, req.user!.id, body.data);
    return service.notificationSettings(app.db, req.user!.id, teamsOn);
  });

  // --- Microsoft Teams: the bot ------------------------------------------

  /**
   * The Bot Framework messaging endpoint (the Azure Bot's "Messaging
   * endpoint"). The token is checked in `onRequest`, BEFORE the body is read
   * (`botAuth.ts`; jose's key-set cooldown bounds what forged tokens cost).
   * The body then has to be an activity whose `serviceUrl` is the one the
   * token vouches for and an allowed Teams host. A failure while answering
   * in the chat is logged and still a 200: Microsoft would only retry the
   * activity, and the bot would answer twice.
   */
  app.post(
    `${TEAMS_PATH}/messages`,
    {
      bodyLimit: ACTIVITY_BODY_LIMIT,
      onRequest: async (req, reply) => {
        if (!verifier) return reply.code(404).send({ error: "not_found" });
        try {
          req.botClaims = await verifier.verify(req.headers.authorization);
        } catch (err) {
          const status = err instanceof BotAuthError ? err.status : 401;
          req.log.warn({ reason: err instanceof Error ? err.message : "?" }, "teams activity refused");
          return reply.code(status).send({ error: "unauthorized" });
        }
        return undefined;
      },
    },
    async (req, reply) => {
      // Reached only when `onRequest` let the call through: Teams is on and
      // the token verified.
      const claims = req.botClaims!;
      const parsed = TeamsActivity.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "validation" });
      const activity = parsed.data;
      if (activity.serviceUrl !== claims.serviceUrl) {
        req.log.warn({}, "teams activity refused: serviceUrl differs from the token's");
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (!allowedServiceUrl(activity.serviceUrl)) {
        req.log.warn({ serviceUrl: activity.serviceUrl }, "teams activity refused: serviceUrl not allowed");
        return reply.code(403).send({ error: "forbidden" });
      }
      const deps: BotDeps = {
        db: app.db,
        teams: teams!,
        webUrl: config.WEB_URL,
        tenants,
        now: () => app.clock.now(),
        log: req.log,
      };
      try {
        await handleActivity(deps, activity);
      } catch (err) {
        if (!(err instanceof TeamsError)) throw err;
        req.log.warn({ err, type: activity.type }, "teams reply failed");
      }
      return reply.code(200).send();
    },
  );

  /**
   * The Teams app package a user uploads into their own Teams. Public: it
   * holds the bot's application id, which Teams shows anyway, and nothing
   * else. Built once, on first request.
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
        tenantId: pending.tenantId,
        expiresAt: pending.expiresAt.toISOString(),
      };
      return preview;
    },
  );

  /**
   * Links the chat to the signed-in account (the CSRF check of
   * `requireSession` applies). The token is consumed in the transaction that
   * writes the link — and only if its tenant is still allowed; the bot's
   * confirmation in Teams comes after the commit, best effort — the page
   * already says it worked.
   */
  app.post(`${TEAMS_PATH}/link`, { preHandler: requireSession }, async (req, reply) => {
    if (!teams) return reply.code(404).send({ error: "not_found" });
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

    // In the account's language: the page that asked is the account's.
    const { link } = outcome;
    const confirmation = botText(mailLocale(req.user!.locale), "bot.confirmed", {
      name: await accountName(app.db, userId),
    });
    teams
      .send({ serviceUrl: link.serviceUrl, conversationId: link.conversationId }, confirmation)
      .catch((err: unknown) => req.log.warn({ err }, "teams link confirmation not sent"));

    return service.notificationSettings(app.db, userId, teamsOn);
  });

  /** Forgets the link. Nothing is uninstalled at Microsoft: the user owns their Teams. */
  app.delete(TEAMS_PATH, { preHandler: requireSession }, async (req, reply) => {
    if (!teams) return reply.code(503).send({ error: "teams_unavailable" });
    const removed = await service.unlinkTeams(app.db, { userId: req.user!.id });
    if (removed) await trace(req, "teams.unlink", "user", req.user!.id);
    return service.notificationSettings(app.db, req.user!.id, teamsOn);
  });
}
