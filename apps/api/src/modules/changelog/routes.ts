/**
 * HTTP surface of What's new (ADR-087): every entry the reader may see (the
 * history page), and the unseen ones (the dialog after an update). The
 * acknowledgement writes `users`, so it is the auth plugin's
 * (`POST /app/api/me/changelog`).
 *
 * The history is the same text for everyone of a role: any session reads it.
 * "Unseen" is the account's own state, so it is the own portal session's
 * only, like the acknowledgement (`ownSessionGuard`: an impersonation or a
 * Bearer token gets `403 session_required`). A `seb` or `kiosk` session
 * reaches neither (ADR-027's default deny).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ownSessionGuard } from "../guards.js";
import { bundledChangelog } from "./bundle.js";
import { changelogFor } from "./service.js";

export async function changelogPlugin(app: FastifyInstance) {
  const read = (unseen: boolean) => (req: FastifyRequest) =>
    changelogFor(app.db, bundledChangelog(), req.user!, unseen);
  app.get(
    "/app/api/changelog",
    { preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply) },
    read(false),
  );
  app.get("/app/api/changelog/unseen", { preHandler: ownSessionGuard(app) }, read(true));
}
