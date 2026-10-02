/**
 * Acting as a student (ADR-034, #201): an admin copies a one-time link from a
 * roster row (the route is the `org` module's) and opens it in a private
 * window, where it becomes an `impersonation` session of that student — what
 * the student sees, for an hour, read-only in production.
 *
 * A link and not a new tab: the session cookie is one for the whole origin,
 * so a session opened in a tab of the admin's own browser would replace the
 * admin's in every tab. Only another browser profile keeps the two apart.
 */
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { LaunchSecretParams, type ImpersonationLink } from "@quiz/contracts";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { enrollments, users } from "../db/schema.js";
import { consumeLaunchTicket, issueLaunchTicket } from "./launch.js";
import { IMPERSONATION_PATH } from "./paths.js";

/** Where the link lands; the secret is the last segment, which the request log masks (`redact.ts`). */
export { IMPERSONATION_PATH } from "./paths.js";

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

/**
 * The link that opens a session as the holder of `entry`, for `actorId` (an
 * admin: the route's guard). Null when the entry is not a claimed student
 * seat, which the route answers with its 404.
 */
export async function issueImpersonationLink(
  db: Db,
  config: AppConfig,
  entry: { userId: string | null; staff: boolean },
  actorId: string,
  now: Date,
): Promise<ImpersonationLink | null> {
  const student = entry.userId && !entry.staff ? await impersonable(db, entry.userId) : null;
  if (!student) return null;
  const secret = await issueLaunchTicket(
    db,
    { kind: "impersonation", userId: student.id, actorUserId: actorId, evaluationId: null },
    now,
  );
  return { url: new URL(`${IMPERSONATION_PATH}${secret}`, config.PUBLIC_URL).href };
}

export async function impersonationRoutes(app: FastifyInstance) {
  /**
   * The link itself. The ticket is minutes old: the actor must still be an
   * admin and the student still a student, checked again now (and the actor
   * on every request after, `findSessionUser`). Every refusal looks the same.
   */
  app.get(`${IMPERSONATION_PATH}:secret`, async (req, reply) => {
    const refuse = () => reply.redirect("/?impersonation=invalid", 303);
    const params = LaunchSecretParams.safeParse(req.params);
    if (!params.success) return refuse();
    const ticket = await consumeLaunchTicket(app.db, "impersonation", params.data.secret, app.clock.now());
    const actorId = ticket?.auth.actorUserId ?? null;
    const [actor] = actorId
      ? await app.db.select({ role: users.role }).from(users).where(eq(users.id, actorId))
      : [];
    const student = ticket && actor?.role === "admin" ? await impersonable(app.db, ticket.userId) : null;
    if (!ticket || !student) return refuse();
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
