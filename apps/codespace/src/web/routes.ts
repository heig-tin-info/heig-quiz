/**
 * The portal's own HTML: a landing page and nothing else.
 *
 * The portal has no login (ADR-047, amendment of M6-03): a student arrives
 * through the platform's launch token (`classroom/routes.ts`), and a teacher
 * sees the sessions in the platform, which calls the service API. There is no
 * page here that needs a user.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

import { requestLang } from "./i18n.js";
import { landingPage } from "./pages.js";

/**
 * Attributes of the codespace session cookie. `Path=/s/<id>`: the browser only
 * sends this cookie to that session, so two sessions open in the same browser
 * do not step on each other.
 */
export function sessionCookieOptions(sessionId: string, secure: boolean) {
  return {
    path: `/s/${sessionId}`,
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
  };
}

async function webRoutesImpl(app: FastifyInstance): Promise<void> {
  app.get("/", async (req, reply) =>
    reply.type("text/html; charset=utf-8").send(landingPage(requestLang(req))),
  );
}

export const webRoutes = fp(webRoutesImpl, { fastify: "5.x", name: "web-routes" });
