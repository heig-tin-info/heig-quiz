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
 */
import type { FastifyInstance } from "fastify";

import {
  IdParam,
  NotificationPreferencePut,
  NotificationQuery,
  TeamsCallbackQuery,
  type TeamsConnectStart,
} from "@quiz/contracts";

import { tracer } from "../../audit.js";
import { teamsEnabled, type AppConfig } from "../../config.js";
import * as service from "./service.js";
import { createTeamsClient } from "./teams.js";

/** The signed cookie that carries one Teams linking attempt to its callback. */
const TEAMS_STASH_COOKIE = "quiz_teams";
const TEAMS_PATH = "/app/api/notifications/teams";

export async function notificationsPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const trace = tracer(app);
  const teamsOn = teamsEnabled(config);
  const teams = teamsOn ? createTeamsClient(config) : null;
  const secure = config.NODE_ENV === "production";
  // Registered in the Entra application as its redirect URI (docs/development/teams.md).
  const redirectUri = new URL(`${TEAMS_PATH}/callback`, config.PUBLIC_URL).href;

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

  // --- Microsoft Teams ---------------------------------------------------

  /**
   * Starts the link: a POST (so the CSRF check applies) that answers with
   * the Microsoft URL the browser then navigates to. The PKCE verifier, the
   * state, the nonce and the account they belong to travel in a SIGNED,
   * short-lived cookie scoped to the callback — never in the `state`, which
   * Microsoft echoes back.
   */
  app.post(`${TEAMS_PATH}/connect`, { preHandler: requireSession }, async (req, reply) => {
    if (!teams) return reply.code(503).send({ error: "teams_unavailable" });
    const start = teams.beginLink(redirectUri);
    reply.setCookie(
      TEAMS_STASH_COOKIE,
      JSON.stringify({
        state: start.state,
        nonce: start.nonce,
        codeVerifier: start.codeVerifier,
        userId: req.user!.id,
      }),
      { path: TEAMS_PATH, httpOnly: true, sameSite: "lax", secure, signed: true, maxAge: 600 },
    );
    const answer: TeamsConnectStart = { url: start.url };
    return answer;
  });

  /**
   * Microsoft's redirect. A browser lands here, so every outcome is a
   * redirect to the settings page with `?teams=linked|error`, never a JSON
   * body in a tab. The stash must be intact, carry the same state, and
   * belong to the account whose session came back with it.
   */
  app.get(`${TEAMS_PATH}/callback`, async (req, reply) => {
    if (!teams) return reply.code(404).send({ error: "not_found" });
    const back = (outcome: "linked" | "error") => reply.redirect(`/settings?teams=${outcome}`, 303);

    const raw = req.cookies[TEAMS_STASH_COOKIE];
    reply.clearCookie(TEAMS_STASH_COOKIE, { path: TEAMS_PATH });
    const unsigned = raw ? req.unsignCookie(raw) : { valid: false as const, value: null };
    const query = TeamsCallbackQuery.safeParse(req.query);
    if (!req.user || !unsigned.valid || !unsigned.value || !query.success) return back("error");
    let stash: { state?: unknown; nonce?: unknown; codeVerifier?: unknown; userId?: unknown };
    try {
      stash = JSON.parse(unsigned.value) as typeof stash;
    } catch {
      return back("error");
    }
    const { code, state, error } = query.data;
    if (
      error ||
      !code ||
      typeof stash.state !== "string" ||
      typeof stash.nonce !== "string" ||
      typeof stash.codeVerifier !== "string" ||
      state !== stash.state ||
      stash.userId !== req.user.id
    ) {
      if (error) req.log.warn({ error }, "Teams link refused at Microsoft");
      return back("error");
    }

    let identity: { tenantId: string; objectId: string };
    try {
      identity = await teams.completeLink({
        code,
        redirectUri,
        codeVerifier: stash.codeVerifier,
        nonce: stash.nonce,
      });
    } catch (err) {
      req.log.warn({ err }, "Teams link: code exchange failed");
      return back("error");
    }
    await service.linkTeams(app.db, req.user.id, identity, app.clock.now());
    await trace(req, "teams.link", "user", req.user.id, { tenantId: identity.tenantId });
    return back("linked");
  });

  /** Forgets the link. Nothing is uninstalled at Microsoft: the user owns their Teams. */
  app.delete(TEAMS_PATH, { preHandler: requireSession }, async (req, reply) => {
    if (!teams) return reply.code(503).send({ error: "teams_unavailable" });
    const removed = await service.unlinkTeams(app.db, req.user!.id);
    if (removed) await trace(req, "teams.unlink", "user", req.user!.id);
    return service.notificationSettings(app.db, req.user!.id, teamsOn);
  });
}
