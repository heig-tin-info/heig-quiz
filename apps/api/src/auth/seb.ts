/**
 * Safe Exam Browser launch (ADR-027, #139; D21, M6-07): the `.seb` file a
 * student downloads from the portal, and the route it starts on, which
 * trades the one-time ticket in its URL for a `seb` session confined to ONE
 * activity — an evaluation, or an `online_seb` project's page and workspace.
 *
 * The file format, the Config Key and the hashes are `@quiz/seb` (D21,
 * M6-02); this module adds what is Quiz's own: the platform builds every
 * `.seb` (D21 point 2) — Quiz's host, the workspace portal's for a project,
 * `SEB_EXTRA_ALLOWED_HOSTS` — and the start route trades the ticket.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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
import { sebProjectSeat } from "../modules/codespace/service.js";
import { sebSeat } from "../modules/live/service.js";
import { consumeLaunchTicket, issueLaunchTicket } from "./launch.js";
import { activityOf, delegated, type Activity } from "./session.js";
// Where the `.seb` starts; the ticket secret is the last segment, which the
// request log masks (`redact.ts`).
import { LAUNCH_PATH } from "./paths.js";

// The renderer the routes use, re-exported for the snapshot that pins its bytes.
export { toPlistXml };

// --- The file --------------------------------------------------------------

/**
 * The hosts a launch file of `activity` lets SEB reach beside Quiz's own:
 * the workspace portal's for a project (D21 point 2), then
 * `SEB_EXTRA_ALLOWED_HOSTS`. Empty for an evaluation by default, whose file
 * is then the one ADR-027 pinned.
 */
export function sebAllowedHosts(
  config: Pick<AppConfig, "CODESPACE_URL" | "SEB_EXTRA_ALLOWED_HOSTS">,
  activity: Activity,
): string[] {
  const portal = activity === "project" && config.CODESPACE_URL !== "" ? [new URL(config.CODESPACE_URL).host] : [];
  return [...portal, ...config.SEB_EXTRA_ALLOWED_HOSTS];
}

/** The configuration of one launch: Quiz's host, then `allowedHosts`. */
export const sebConfig = (startUrl: string, allowedHosts: readonly string[] = []): SebValue =>
  buildSebConfig({ startUrl, allowedHosts });

/**
 * Whether `header` is the Config Key hash of `absoluteUrl` under the key
 * `configKeyHex` (constant time, `hashesEqual`).
 */
export const configKeyHashMatches = (absoluteUrl: string, configKeyHex: string, header: unknown): boolean =>
  typeof header === "string" && hashesEqual(expectedHash(absoluteUrl, configKeyHex), header);

/** The Config Key of the launch that starts at `url`: what a `seb` session stores. */
export const launchConfigKey = (url: string, allowedHosts: readonly string[] = []): string =>
  configKey(sebConfig(url, allowedHosts));

/** What SEB sends on the launch that starts at `url` (the tests send it too). */
export const configKeyHeaderFor = (url: string, allowedHosts: readonly string[] = []): string =>
  expectedHash(url, launchConfigKey(url, allowedHosts));

/** The one activity a `seb` launch is for: exactly one of the two is set. */
export type SebActivity = { evaluationId: string; projectId: null } | { evaluationId: null; projectId: string };

/**
 * The `.seb` of one activity for `req`'s user (D21 point 2: the platform
 * builds every `.seb`): a fresh one-time ticket — the previous unused one
 * revoked —, `auth.seb_launch` in the audit, and the file, never cached.
 * The caller has loaded the seat; the session is the user's own portal one.
 */
export async function sendLaunchFile(
  app: FastifyInstance,
  config: AppConfig,
  req: FastifyRequest,
  reply: FastifyReply,
  activity: SebActivity,
): Promise<FastifyReply> {
  const secret = await issueLaunchTicket(
    app.db,
    { kind: "seb", userId: req.user!.id, actorUserId: null, ...activity },
    app.clock.now(),
  );
  const subject = activityOf(activity);
  await tracer(app)(req, "auth.seb_launch", subject, (activity.projectId ?? activity.evaluationId)!);
  const startUrl = new URL(`${LAUNCH_PATH}${secret}`, config.PUBLIC_URL).href;
  return reply
    .header("content-type", "application/seb")
    .header("content-disposition", `attachment; filename="${subject === "project" ? "workspace" : "exam"}.seb"`)
    .header("cache-control", "no-store")
    .send(toPlistXml(sebConfig(startUrl, sebAllowedHosts(config, subject))));
}

// --- The routes ----------------------------------------------------------------

/** The two activities a `.seb` may be for, in the order the start route tries their files. */
const ACTIVITIES: readonly Activity[] = ["evaluation", "project"];

export async function sebRoutes(app: FastifyInstance, config: AppConfig) {
  /**
   * The `.seb` of one evaluation, for a student holding a seat in it. A
   * portal session only (the route declares no other kind): a `seb` session
   * cannot mint the next ticket. A GET, like the CSV export, so the card is a
   * plain download link; forcing one from another site only revokes an
   * unused file, which the student downloads again. A project's is the
   * `codespace` module's (`GET /app/api/projects/:id/seb`).
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
      return sendLaunchFile(app, config, req, reply, { evaluationId: evaluation.id, projectId: null });
    },
  );

  /**
   * The start URL of the `.seb`. The Config Key header is checked BEFORE the
   * ticket is consumed: a copied file opened in an ordinary browser is
   * refused and leaves the ticket for SEB. The file is a function of its
   * start URL and of its activity's hosts, so the header is checked against
   * either file first, then against the ticket's own once it is consumed.
   * Every refusal looks the same to the client; the audit log keeps the
   * reason.
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
    const header = req.headers[CONFIG_KEY_HEADER];
    const keyOf = (activity: Activity) => launchConfigKey(url, sebAllowedHosts(config, activity));
    if (!ACTIVITIES.some((activity) => configKeyHashMatches(url, keyOf(activity), header))) return refuse("config_key");
    const ticket = await consumeLaunchTicket(app.db, "seb", req.params.secret, now);
    if (!ticket) return refuse("ticket");
    const activity = activityOf(ticket.auth);
    const sebConfigKey = keyOf(activity);
    if (!configKeyHashMatches(url, sebConfigKey, header)) return refuse("config_key", ticket.id);
    // The ticket is a few minutes old: the seat, and the requirement, are checked again now.
    const seat =
      activity === "project"
        ? await sebProjectSeat(app.db, ticket.userId, ticket.auth.projectId!)
        : await sebSeat(app.db, ticket.userId, ticket.auth.evaluationId!);
    const [user] = await app.db.select().from(users).where(eq(users.id, ticket.userId));
    if (!seat || !user) return refuse("seat", ticket.id);
    await app.openSession(reply, user, { ...ticket.auth, sebConfigKey });
    await audit(app.db, {
      actorUserId: ticket.auth.actorUserId ?? user.id,
      actorType: "user",
      action: "auth.seb_login",
      subjectType: activity,
      subjectId: seat.id,
      payload: { ticketId: ticket.id },
    });
    // A project's session lands on its student page, whose *Open workspace*
    // goes on to the portal (D21 point 4).
    return reply.redirect(activity === "project" ? `/projects/${seat.id}` : `/take/${seat.id}`, 303);
  });
}
