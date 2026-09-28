/**
 * Acting as a student (ADR-034, #201): an admin copies a one-time link from a
 * roster row and opens it in a private window, where it becomes an
 * `impersonation` session of that student — what the student sees, for an
 * hour, read-only in production.
 *
 * A link and not a new tab: the session cookie is one for the whole origin,
 * so a session opened in a tab of the admin's own browser would replace the
 * admin's in every tab. Only another browser profile keeps the two apart.
 */
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { RosterEntryParams, type ImpersonationLink } from "@quiz/contracts";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { enrollments, users } from "../db/schema.js";
import { accessibleEnrollment } from "../modules/guards.js";
import { notFound } from "../modules/http.js";
import { consumeLaunchTicket, issueLaunchTicket } from "./launch.js";

/** Where the link lands; the secret is the last segment, which the request log masks (`redact.ts`). */
export const IMPERSONATION_PATH = "/app/auth/as/";

/**
 * The account `userId` if it may be acted as: a student, holding a student
 * seat somewhere. A teacher or an admin — even one with a seat of their own —
 * is never impersonated (ADR-034).
 */
async function impersonable(db: Db, userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.role, "student"),
        sql`EXISTS (SELECT 1 FROM ${enrollments} WHERE ${enrollments.userId} = ${users.id} AND NOT ${enrollments.staff})`,
      ),
    )
    .limit(1);
  return user ?? null;
}

export async function impersonationRoutes(app: FastifyInstance, config: AppConfig) {
  /**
   * The link for one roster entry. Admins only in v1: an impersonated session
   * reads everything the student reads, other courses included, and only an
   * admin already reaches every course (invariant 6). Anyone else, and any
   * entry that is not a claimed student seat, gets the 404 of a missing one.
   */
  app.post(
    "/app/api/classrooms/:id/roster/:eid/impersonation",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = RosterEntryParams.safeParse(req.params);
      if (!params.success || req.user!.role !== "admin") return notFound(reply);
      const entry = await accessibleEnrollment(app, req, reply, params.data);
      if (!entry) return reply;
      const student = entry.userId && !entry.staff ? await impersonable(app.db, entry.userId) : null;
      if (!student) return notFound(reply);
      const secret = await issueLaunchTicket(
        app.db,
        { kind: "impersonation", userId: student.id, actorUserId: req.user!.id, evaluationId: null },
        app.clock.now(),
      );
      const link: ImpersonationLink = {
        url: new URL(`${IMPERSONATION_PATH}${secret}`, config.PUBLIC_URL).href,
      };
      return link;
    },
  );

  /**
   * The link itself. The ticket is minutes old: the actor must still be an
   * admin and the student still a student, checked again now. Every refusal
   * looks the same.
   */
  app.get<{ Params: { secret: string } }>(`${IMPERSONATION_PATH}:secret`, async (req, reply) => {
    const ticket = await consumeLaunchTicket(app.db, "impersonation", req.params.secret, app.clock.now());
    const actorId = ticket?.auth.actorUserId ?? null;
    const [actor] = actorId
      ? await app.db.select({ role: users.role }).from(users).where(eq(users.id, actorId))
      : [];
    const student = ticket && actor?.role === "admin" ? await impersonable(app.db, ticket.userId) : null;
    if (!ticket || !student) return reply.redirect("/?impersonation=invalid", 303);
    await app.openSession(reply, student, ticket.auth);
    await audit(app.db, {
      actorUserId: actorId,
      actorType: "user",
      action: "impersonation.started",
      subjectType: "user",
      subjectId: student.id,
      payload: { ticketId: ticket.id },
    });
    return reply.redirect("/", 303);
  });
}
