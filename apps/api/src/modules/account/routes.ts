/**
 * HTTP surface of the `account` module (ADR-117 §5, §6): the two doors to
 * `pseudonymizeUser` a person reaches. The lifecycle's own is the daily job
 * (`jobs.ts`). Refusals are `AccountError`'s codes, the contract's
 * `PSEUDONYMIZE_REFUSALS`, which the screens word.
 */
import type { FastifyInstance } from "fastify";

import { ADMIN_PSEUDONYMIZE_ROUTE, IdParam, SELF_PSEUDONYMIZE_PATH } from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { publish } from "../../events.js";
import { adminGuard, ownSessionGuard, superPowersGuard } from "../guards.js";
import { notFound, sendFailure } from "../http.js";
import { pseudonymizeUser } from "./service.js";

export async function accountPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;

  /**
   * The caller pseudonymizes their own account (ADR-117 §5): their own
   * `portal` session only (`ownSessionGuard`: never an impersonation, a
   * `seb` or `kiosk` session, an API token or an OAuth grant), a student
   * account only (`409 staff`: the administrator does it). The wipe ends
   * every session of the account; this one's cookies go with the answer.
   */
  app.post(SELF_PSEUDONYMIZE_PATH, { preHandler: ownSessionGuard(app) }, async (req, reply) => {
    const now = app.clock.now();
    try {
      await pseudonymizeUser(app.db, req.user!.id, { by: "self", actor: actorOf(req), config, log: req.log, now });
    } catch (error) {
      return sendFailure(reply, error, now);
    }
    app.clearSessionCookies(reply);
    // The administration's list loses a row.
    publish("admin", ["admin"]);
    return reply.code(204).send();
  });

  /**
   * An administrator, Super Powers on (ADR-054), pseudonymizes any account,
   * student or staff (ADR-117 §6); a staff account's pools pass on inside
   * (ADR-013 §5). The administrator's own account answers as missing: the
   * act would end the very session that asks.
   */
  app.post(
    ADMIN_PSEUDONYMIZE_ROUTE,
    { preHandler: [adminGuard(app), superPowersGuard()] },
    async (req, reply) => {
      const params = IdParam.safeParse(req.params);
      if (!params.success || params.data.id === req.user!.id) return notFound(reply);
      const now = app.clock.now();
      try {
        await pseudonymizeUser(app.db, params.data.id, { by: "admin", actor: actorOf(req), config, log: req.log, now });
      } catch (error) {
        return sendFailure(reply, error, now);
      }
      publish("admin", ["admin"]);
      return reply.code(204).send();
    },
  );
}
