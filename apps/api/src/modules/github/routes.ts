/**
 * HTTP surface of the `github` module (spec 05 §5.11, F-GH-01 to F-GH-04):
 * the organizations where Quiz's App is installed, a classroom's link to one
 * of them, the App's setup return, and an organization's avatar.
 *
 * Registered only when Quiz's App is configured (`githubApp(config)`,
 * `app.ts`): without it none of these routes exists, so each is a 404 and
 * nothing calls GitHub.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { GithubConnectBody, GithubSetupQuery, IdParam } from "@quiz/contracts";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { FixedWindowLimiter } from "../../limiter.js";
import { accessibleClassroom, teacherGuard } from "../guards.js";
import { notFound, teacherRoute } from "../http.js";
import { INERT_IMAGE_HEADERS } from "../pool/assets.js";
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
   */
  app.get("/setup/github/installed", async (req, reply) => {
    // Public, and each call reaches GitHub: counted per address.
    const wait = setups.hit(req.ip, app.clock.now().getTime());
    if (wait !== null) {
      return reply.code(429).header("retry-after", String(wait)).send({ error: "rate_limited" });
    }
    const query = GithubSetupQuery.parse(req.query ?? {});
    try {
      await service.completeSetup(app.db, config, query, req.log);
    } catch (err) {
      // The teacher still lands back; the healing resolves it on the next open.
      req.log.error({ err }, "recording an installation failed");
    }
    return reply.redirect(
      query.state === undefined ? "/" : `/classrooms/${query.state}/settings`,
      303,
    );
  });
}
