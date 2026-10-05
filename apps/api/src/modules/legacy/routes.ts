/**
 * `GET /legacy/classroom/*` (merge task M8-02, docs/merge/06 §6.6): where
 * Caddy sends what a human clicked on `classroom.chevallier.io`. It is not
 * under `/app/api`: a browser navigates to it, so the answer is a redirect,
 * never a payload. The old path is read by `legacyRule` (`@quiz/domain`,
 * pure); the ids go through the import's id map (`service.ts`).
 *
 * - a fixed row: 302 to the Quiz equivalent, whoever asks;
 * - a dead API: 410 `{ error: "moved", to }`, whoever asks;
 * - a row that points at an entity: 302 to the entity's Quiz page when the
 *   caller's OWN portal session reaches it (the staff through `staffAccess`,
 *   a student through their seat; invariant 6), else the 404 of a missing
 *   entity, whatever the reason: unmapped, absent, off the caller's reach,
 *   or a session that is not a portal one. The avatar answers 410 instead
 *   of 404, as the table says, and equally for every reason;
 * - nobody signed in (a `seb` or `kiosk` session counts as nobody): a 302 to
 *   the login that comes back to this very URL. It is the same answer for a
 *   real entity and a made-up one, so the login leaks nothing.
 */
import type { FastifyInstance } from "fastify";

import { LegacyClassroomParams, type LegacyGone } from "@quiz/contracts";
import { LEGACY_HOME, legacyRule } from "@quiz/domain";

import { callerOf, ownPortalSession } from "../guards.js";
import { resolve } from "./service.js";

/** What the login's signed stash cookie can carry (it must stay well under 4 KB). */
const NEXT_MAX = 1500;

export async function legacyPlugin(app: FastifyInstance) {
  app.get("/legacy/classroom/*", async (req, reply) => {
    const params = LegacyClassroomParams.safeParse(req.params);
    // The SPA's own not-found handling for a navigation, the one answer for every refusal.
    const notFound = () => reply.callNotFound();
    if (!params.success) return notFound();
    const gone = () => reply.code(410).send({ error: "moved", to: LEGACY_HOME } satisfies LegacyGone);
    const rule = legacyRule(`/${params.data["*"]}`);
    // The avatar answers 410 where the other entity rows answer 404.
    const deny = () => (rule.kind === "avatar" ? gone() : notFound());

    switch (rule.kind) {
      case "redirect":
        return reply.redirect(rule.to, 302);
      case "gone":
        return gone();
      case "not_found":
        return notFound();
      default: {
        // What these answers say depends on who asks: never stored by a cache.
        reply.header("cache-control", "no-store");
        if (!req.user) {
          if (rule.kind === "avatar") return gone();
          // A URL too long for the stash is sent without its way back.
          const next = encodeURIComponent(req.url);
          return reply.redirect(next.length <= NEXT_MAX ? `/app/auth/login?next=${next}` : "/app/auth/login", 302);
        }
        if (!req.auth || !ownPortalSession(req.auth)) return deny();
        const to = await resolve(app.db, callerOf(req), req.auth, rule);
        return to ? reply.redirect(to, 302) : deny();
      }
    }
  });
}
