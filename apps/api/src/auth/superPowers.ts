/**
 * Super Powers (ADR-054): an admin's portal session reaches every course and
 * pool for one fixed hour, then goes back to what a teacher reaches. Without
 * them, the admin role reaches its own functions (users, teachers, metrics)
 * and nothing of a colleague's content.
 *
 * The flag lives on the session row (`sessions.super_powers_until`), so it
 * dies with the session: signing out, or the session's own expiry. Whether a
 * request has them is `reachOf` in `modules/guards.ts`; this file only turns
 * them on and off.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { SuperPowersState } from "@quiz/contracts";

import { audit } from "../audit.js";
import { iso } from "../clock.js";
import { sessions } from "../db/schema.js";
import { adminGuard, ownSessionGuard } from "../modules/guards.js";
import { accessRevoked } from "../modules/realtime/bus.js";
import { SESSION_COOKIE, SUPER_POWERS_MS, hashToken, superPowersEnded } from "./session.js";

const PATH = "/app/api/me/super-powers";

export async function superPowersRoutes(app: FastifyInstance) {
  // An admin (`403 forbidden` otherwise), in a session that may hold Super
  // Powers (`mayHoldSuperPowers`): `403 session_required` for a Bearer
  // token, a delegated or a confined session.
  const guard = [adminGuard(app), ownSessionGuard(app)];
  const thisSession = (req: FastifyRequest) =>
    eq(sessions.sidHash, hashToken(req.cookies[SESSION_COOKIE] ?? ""));

  /**
   * On, for one hour by the server's clock. Never extended: while they run,
   * a second enable is refused (409) — the admin switches them off and on
   * again, which the audit then shows as two grants.
   */
  app.post(PATH, { preHandler: guard }, async (req, reply) => {
    const now = app.clock.now();
    const until = new Date(now.getTime() + SUPER_POWERS_MS);
    const [row] = await app.db
      .update(sessions)
      .set({ superPowersUntil: until })
      // An hour already past was expired by this very request (`findSessionUser`).
      .where(and(thisSession(req), isNull(sessions.superPowersUntil)))
      .returning({ userId: sessions.userId });
    if (!row) {
      return reply.code(409).send({
        error: "super_powers_active",
        message: "Super Powers are already on",
      });
    }
    await audit(app.db, {
      actorUserId: row.userId,
      actorType: "user",
      action: "superpowers.enabled",
      subjectType: "user",
      subjectId: row.userId,
      payload: { until: iso(until) },
    });
    // The open streams hold the topics of the old reach: closed, they come
    // back with every course and pool (invariant 6, #248).
    accessRevoked([row.userId]);
    return { superPowersUntil: iso(until) } satisfies SuperPowersState;
  });

  /** Off, now. Idempotent: switching off what is off writes nothing. */
  app.delete(PATH, { preHandler: guard }, async (req) => {
    const [row] = await app.db
      .update(sessions)
      .set({ superPowersUntil: null })
      // One past its hour was already expired by this very request
      // (`findSessionUser`), so what is still set here is live.
      .where(and(thisSession(req), isNotNull(sessions.superPowersUntil)))
      .returning({ userId: sessions.userId });
    if (row) await superPowersEnded(app.db, row.userId, "manual");
    return { superPowersUntil: null } satisfies SuperPowersState;
  });
}
