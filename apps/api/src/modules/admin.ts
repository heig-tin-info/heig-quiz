import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { courseStaff, teacherGrants, users } from "../db/schema.js";
import { syncUserRole } from "../roles.js";
import { adminGuard } from "./guards.js";

/**
 * Administration: the super admin (email in the environment) manages
 * teachers in the database. Granting is done by email; identity and last
 * login fill in at the first login. Grant and revoke take effect immediately
 * on an existing account (the role is also recomputed at every login).
 */
export async function adminPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireAdmin = adminGuard(app);

  app.get("/app/api/admin/teachers", { preHandler: requireAdmin }, async () => {
    const rows = await app.db
      .select({
        id: teacherGrants.id,
        email: teacherGrants.email,
        grantedAt: teacherGrants.createdAt,
        givenName: users.givenName,
        familyName: users.familyName,
        lastLoginAt: users.lastLoginAt,
        signedUp: sql<boolean>`${users.id} IS NOT NULL`,
        courses: sql<number>`coalesce((SELECT count(*) FROM ${courseStaff} cs WHERE cs.user_id = ${users.id}), 0)::int`,
      })
      .from(teacherGrants)
      .leftJoin(users, sql`lower(${users.email}) = ${teacherGrants.email}`)
      .orderBy(teacherGrants.createdAt);
    return rows.map((r) => ({
      ...r,
      grantedAt: r.grantedAt.toISOString(),
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
    }));
  });

  const GrantBody = z.object({ email: z.email() });

  app.post("/app/api/admin/teachers", { preHandler: requireAdmin }, async (req, reply) => {
    const body = GrantBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", message: "A valid e-mail is required" });
    }
    const email = body.data.email.trim().toLowerCase();
    if (email === config.SUPER_ADMIN_EMAIL) {
      return reply
        .code(409)
        .send({ error: "is_admin", message: "This e-mail is the administrator" });
    }
    const [created] = await app.db
      .insert(teacherGrants)
      .values({ id: randomUUID(), email, createdBy: req.user!.id })
      .onConflictDoNothing({ target: teacherGrants.email })
      .returning();
    if (!created) {
      return reply
        .code(409)
        .send({ error: "already_teacher", message: "This e-mail is already a teacher" });
    }
    // Immediate effect if the account already exists (otherwise: at login).
    await syncUserRole(app.db, config, email);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "teacher.grant",
      subjectType: "teacher_grant",
      subjectId: created.id,
      payload: { email },
    });
    return reply.code(201).send(created);
  });

  const GrantParam = z.object({ gid: z.uuid() });

  app.delete("/app/api/admin/teachers/:gid", { preHandler: requireAdmin }, async (req, reply) => {
    const params = GrantParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const [grant] = await app.db
      .select()
      .from(teacherGrants)
      .where(eq(teacherGrants.id, params.data.gid))
      .limit(1);
    if (!grant) return reply.code(404).send({ error: "not_found" });
    await app.db.delete(teacherGrants).where(eq(teacherGrants.id, grant.id));
    // Recomputed, not forced: a member of a course staff keeps the role.
    await syncUserRole(app.db, config, grant.email);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "teacher.revoke",
      subjectType: "teacher_grant",
      subjectId: grant.id,
      payload: { email: grant.email },
    });
    return reply.code(204).send();
  });
}
