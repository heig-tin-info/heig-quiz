/**
 * HTTP surface of the `github` module (spec 05 §5.11, F-GH-01 to F-GH-04):
 * the organizations where Quiz's App is installed, a classroom's link to one
 * of them, the App's setup return, an organization's avatar, and the
 * webhook intake (M2-04).
 *
 * Registered only when Quiz's App is configured (`githubApp(config)`,
 * `app.ts`): without it none of these routes exists, so each is a 404 and
 * nothing calls GitHub.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  GithubConnectBody,
  GithubSetupQuery,
  GithubWebhookBody,
  GithubWebhookHeaders,
  IdParam,
} from "@quiz/contracts";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { SETUP_PATH, WEBHOOK_PATH } from "../../github/manifest.js";
import { verifySignature } from "../../github/signature.js";
import { redactTokens } from "../../redact.js";
import { FixedWindowLimiter } from "../../limiter.js";
import { accessibleClassroom, teacherGuard } from "../guards.js";
import { notFound, rateLimited, teacherRoute } from "../http.js";
import { INERT_IMAGE_HEADERS } from "../pool/assets.js";
import { dispatchDelivery, storeDelivery } from "./deliveries.js";
import { registerGithubHandlers } from "./handlers.js";
import * as service from "./service.js";

/** The setup return, per address: an install or two a minute is the real use. */
export const SETUPS_PER_WINDOW = 20;
const SETUP_WINDOW_MS = 10 * 60_000;

export async function githubPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const trace = tracer(app);
  const teacher = teacherRoute(app);
  const requireTeacher = teacherGuard(app);
  const requireSession = (req: FastifyRequest, reply: FastifyReply) =>
    app.requireSession(req, reply);
  const setups = new FixedWindowLimiter(SETUPS_PER_WINDOW, SETUP_WINDOW_MS);

  registerGithubHandlers();
  // Its own child context: the raw-body parser reaches no other route.
  await app.register(webhookIntake, { config });

  /**
   * A classroom of the caller's staff (invariant 6): a student, a teacher
   * off the course's staff and a missing classroom all get the same 404.
   */
  const onClassroom = {
    params: IdParam,
    load: (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
      accessibleClassroom(app, req, reply, p),
  };

  /** The organizations the connect sheet offers (F-GH-02). */
  app.get("/app/api/github/orgs", { preHandler: requireTeacher }, async (req) =>
    service.installedOrgs(app.db, config, req.log),
  );

  /**
   * An organization's avatar, fetched and cached by the server and served
   * from here: the browser never loads it from GitHub, and is never
   * redirected there. The staff's, like the listing that names it: a
   * student gets 403.
   */
  app.get(
    "/app/api/github/orgs/:id/avatar",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const params = IdParam.safeParse(req.params);
      if (!params.success) return notFound(reply);
      const image = await service.orgAvatar(app.db, params.data.id, app.clock.now(), req.log);
      if (!image) return notFound(reply);
      return reply
        .type(image.mime)
        .header("cache-control", "private, max-age=86400")
        .headers(INERT_IMAGE_HEADERS)
        .send(image.bytes);
    },
  );

  app.get(
    "/app/api/classrooms/:id/github",
    { preHandler: requireSession },
    teacher(onClassroom, async ({ req, now, scope }) =>
      service.classroomGithub(app.db, config, scope.room, now, req.log),
    ),
  );

  /** Connect, or change the organization (F-GH-01); 409 while a journal holds it (D28). */
  app.put(
    "/app/api/classrooms/:id/github",
    { preHandler: requireSession },
    teacher({ ...onClassroom, body: GithubConnectBody }, async ({ req, now, body, scope }) => {
      const changed = await service.connectClassroom(app.db, {
        classroomId: scope.room.id,
        orgId: body.orgId,
        userId: req.user!.id,
        now,
      });
      if (changed) {
        await trace(req, "github_org.link", "classroom", scope.room.id, {
          orgId: changed.org.id,
          login: changed.org.login,
          previousOrgId: changed.previousOrgId,
        });
      }
      return service.classroomGithub(app.db, config, scope.room, now, req.log);
    }),
  );

  /** Disconnect (F-GH-04): nothing is deleted on GitHub; 409 while a journal holds it (D28). */
  app.delete(
    "/app/api/classrooms/:id/github",
    { preHandler: requireSession },
    teacher(onClassroom, async ({ req, reply, scope }) => {
      const orgId = await service.disconnectClassroom(app.db, scope.room.id);
      if (orgId) await trace(req, "github_org.unlink", "classroom", scope.room.id, { orgId });
      return reply.code(204).send();
    }),
  );

  /**
   * The App's Setup URL: GitHub sends the browser here after an install,
   * with no session. The installation is verified with the App's JWT before
   * anything is stored (service), and `state` is read as a classroom id
   * only, so the redirect is always an in-app path: never an open redirect.
   * It is the same tab's round trip (the install link opens in place): the
   * redirect lands on the connect sheet, `installed` naming the organization.
   */
  app.get(SETUP_PATH, async (req, reply) => {
    // Public, and each call reaches GitHub: counted per address.
    const wait = setups.hit(req.ip, app.clock.now().getTime());
    if (wait !== null) {
      return rateLimited(reply, wait);
    }
    const query = GithubSetupQuery.parse(req.query ?? {});
    let installed: string | null = null;
    try {
      installed = await service.completeSetup(app.db, config, query, req.log);
    } catch (err) {
      // The teacher still lands back; the healing resolves it on the next open.
      req.log.error({ err }, "recording an installation failed");
    }
    // Back in the tab the teacher left, on the connect sheet; `installed`
    // only preselects an organization the sheet's own list must contain. The
    // id in Location is no secret: it grants nothing without a staff session.
    return reply.redirect(
      query.state === undefined
        ? "/"
        : `/classrooms/${query.state}/settings?connect=1${installed === null ? "" : `&installed=${installed}`}`,
      303,
    );
  });
}

/**
 * `POST /webhooks/github` (N-SEC-17, spec 05 §5.11; the sequence is in
 * `deliveries.ts`). Public, and served to no session at all (`sessions:
 * []`): a cookie sent along is ignored, so whoever calls answers the same.
 *
 * Registered as a child plugin, without `fastify-plugin`: its parser
 * replaces every body parser in this context only, so the route reads the
 * exact bytes GitHub signed and the JSON parsing of every other route is
 * untouched. Nothing is parsed, nor stored, before the HMAC holds. The body
 * limit is Fastify's default, 1 MB, as in classroom.
 */
async function webhookIntake(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.post(WEBHOOK_PATH, { config: { sessions: [] } }, async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.headers["x-hub-signature-256"];
    if (
      !verifySignature(
        config.GITHUB_WEBHOOK_SECRET,
        raw,
        typeof signature === "string" ? signature : undefined,
      )
    ) {
      req.log.warn("webhook signature rejected");
      return reply.code(401).send({ error: "bad_signature" });
    }
    const headers = GithubWebhookHeaders.safeParse(req.headers);
    if (!headers.success) return reply.code(400).send({ error: "bad_headers" });
    const body = GithubWebhookBody.safeParse(parseJson(raw));
    if (!body.success) return reply.code(400).send({ error: "bad_body" });

    const payload = body.data;
    const deliveryId = headers.data["x-github-delivery"];
    const stored = await storeDelivery(app.db, config, {
      deliveryId,
      event: headers.data["x-github-event"],
      action: typeof payload.action === "string" ? payload.action : null,
      payload,
      receivedAt: app.clock.now(),
    });
    // A delivery seen before is acknowledged, and nothing runs again.
    if (!stored) return reply.code(200).send({ ok: true, duplicate: true });
    try {
      await dispatchDelivery(app, config, deliveryId);
    } catch (err) {
      // Stored, its receipt too: the reconciliation replays it. GitHub gets
      // its 200, or its redelivery would only be a duplicate.
      req.log.error(
        { deliveryId, error: redactTokens(String(err)) },
        "queueing a GitHub delivery failed",
      );
    }
    return reply.code(200).send({ ok: true });
  });
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}
