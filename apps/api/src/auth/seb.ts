/**
 * Safe Exam Browser launch (ADR-027, #139): the `.seb` file a student
 * downloads from the portal, and the route it starts on, which trades the
 * one-time ticket in its URL for a `seb` session confined to one evaluation.
 *
 * The file format, the Config Key and the hashes are `@quiz/seb` (D21,
 * M6-02); this module adds what is Quiz's own: an evaluation's launch file
 * allows Quiz's host only, and the start route trades the ticket.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { IdParam } from "@quiz/contracts";
import {
  CONFIG_KEY_HEADER,
  absoluteRequestUrl,
  buildSebConfig,
  configKey,
  expectedHash,
  hashesEqual,
  toPlistXml,
  type SebValue,
} from "@quiz/seb";

import { audit, tracer } from "../audit.js";
import type { AppConfig } from "../config.js";
import { users } from "../db/schema.js";
import { sebSeat } from "../modules/live/service.js";
import { consumeLaunchTicket, issueLaunchTicket } from "./launch.js";
import { delegated } from "./session.js";
// Where the `.seb` starts; the ticket secret is the last segment, which the
// request log masks (`redact.ts`).
import { LAUNCH_PATH } from "./paths.js";

// The renderer the routes use, re-exported for the snapshot that pins its bytes.
export { toPlistXml };

// --- The file --------------------------------------------------------------

/** The configuration of one evaluation's launch: Quiz's host, nothing else. */
export const sebConfig = (startUrl: string): SebValue => buildSebConfig({ startUrl, allowedHosts: [] });

/**
 * Whether `header` is the Config Key hash of `absoluteUrl` under the key
 * `configKeyHex` (constant time, `hashesEqual`).
 */
export const configKeyHashMatches = (absoluteUrl: string, configKeyHex: string, header: unknown): boolean =>
  typeof header === "string" && hashesEqual(expectedHash(absoluteUrl, configKeyHex), header);

/** The Config Key of the launch that starts at `url`: what a `seb` session stores. */
export const launchConfigKey = (url: string): string => configKey(sebConfig(url));

/** What SEB sends on the launch that starts at `url` (the tests send it too). */
export const configKeyHeaderFor = (url: string): string => expectedHash(url, launchConfigKey(url));

// --- The routes ----------------------------------------------------------------

export async function sebRoutes(app: FastifyInstance, config: AppConfig) {
  const trace = tracer(app);
  /**
   * The `.seb` of one evaluation, for a student holding a seat in it. A
   * portal session only (the route declares no other kind): a `seb` session
   * cannot mint the next ticket. A GET, like the CSV export, so the card is a
   * plain download link; forcing one from another site only revokes an
   * unused file, which the student downloads again.
   */
  app.get(
    "/app/api/evaluations/:id/seb",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = IdParam.safeParse(req.params);
      // Nobody acting as a student mints the student's `.seb` (ADR-034):
      // a SEB exam stays out of an impersonation's reach.
      const evaluation =
        params.success && !delegated(req.auth) && (await sebSeat(app.db, req.user!.id, params.data.id));
      if (!evaluation) return reply.code(404).send({ error: "not_found" });
      const secret = await issueLaunchTicket(
        app.db,
        { kind: "seb", userId: req.user!.id, actorUserId: null, evaluationId: evaluation.id },
        app.clock.now(),
      );
      await trace(req, "auth.seb_launch", "evaluation", evaluation.id);
      const startUrl = new URL(`${LAUNCH_PATH}${secret}`, config.PUBLIC_URL).href;
      return reply
        .header("content-type", "application/seb")
        .header("content-disposition", 'attachment; filename="exam.seb"')
        .header("cache-control", "no-store")
        .send(toPlistXml(sebConfig(startUrl)));
    },
  );

  /**
   * The start URL of the `.seb`. The Config Key header is checked BEFORE the
   * ticket is consumed: a copied file opened in an ordinary browser is
   * refused and leaves the ticket for SEB. Every refusal looks the same to
   * the client; the audit log keeps the reason.
   */
  app.get<{ Params: { secret: string } }>(`${LAUNCH_PATH}:secret`, async (req, reply) => {
    const refuse = async (reason: string, ticketId = "unknown") => {
      await audit(app.db, {
        actorType: "system",
        action: "auth.seb_refused",
        subjectType: "launch_ticket",
        subjectId: ticketId,
        payload: { reason, ip: req.ip },
      });
      return reply.redirect("/?seb=invalid", 303);
    };
    const now = app.clock.now();
    // The start URL of the `.seb` IS this request's URL; its Config Key is
    // kept on the session, to check every later request (ADR-051 §3).
    const url = absoluteRequestUrl(config.PUBLIC_URL, req.raw.url ?? req.url);
    const sebConfigKey = launchConfigKey(url);
    if (!configKeyHashMatches(url, sebConfigKey, req.headers[CONFIG_KEY_HEADER])) return refuse("config_key");
    const ticket = await consumeLaunchTicket(app.db, "seb", req.params.secret, now);
    if (!ticket) return refuse("ticket");
    // The ticket is a few minutes old: the seat, and the requirement, are checked again now.
    const evaluation = await sebSeat(app.db, ticket.userId, ticket.auth.evaluationId!);
    const [user] = await app.db.select().from(users).where(eq(users.id, ticket.userId));
    if (!evaluation || !user) return refuse("seat", ticket.id);
    await app.openSession(reply, user, { ...ticket.auth, sebConfigKey });
    await audit(app.db, {
      actorUserId: ticket.auth.actorUserId ?? user.id,
      actorType: "user",
      action: "auth.seb_login",
      subjectType: "evaluation",
      subjectId: evaluation.id,
      payload: { ticketId: ticket.id },
    });
    return reply.redirect(`/take/${evaluation.id}`, 303);
  });
}
