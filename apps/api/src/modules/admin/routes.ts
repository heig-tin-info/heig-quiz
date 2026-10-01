import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";

import {
  ScheduledTaskParams,
  ScheduledTaskPatch,
  SystemStatusQuery,
  TASK_INTERVAL_MAX_MINUTES,
  TASK_INTERVAL_MIN_MINUTES,
  TeacherGrantCreate,
  TeacherGrantParams,
  type TestMailResult,
} from "@quiz/contracts";

import { audit, tracer } from "../../audit.js";
import { Budget, BUDGET_RETRY_AFTER_S } from "../../budget.js";
import type { AppConfig } from "../../config.js";
import { avatars, courseStaff, teacherGrants, users } from "../../db/schema.js";
import { publish } from "../../events.js";
import { syncUserRole } from "../../roles.js";
import { shownAvatar } from "../avatar.js";
import { adminGuard } from "../guards.js";
import { sendTestMail } from "../notifications/service.js";
import {
  claimTaskNow,
  configureScheduledTask,
  dispatchScheduledTask,
  listScheduledTasks,
  scheduledTask,
  scheduledTaskRow,
  systemStatus,
} from "../system/service.js";
import { createTeacherGrant, listUsers } from "./service.js";

/**
 * Administration: the super admin (email in the environment) manages
 * teachers in the database. Granting is done by email; identity and last
 * login fill in at the first login. Grant and revoke take effect immediately
 * on an existing account (the role is also recomputed at every login).
 * The admin also sees and steers the scheduled tasks (F-ADMIN-06), whose
 * table the `system` module owns.
 */
export async function adminPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireAdmin = adminGuard(app);
  const trace = tracer(app);

  // Every account, with its role, why, and its teaching footprint (F-ADMIN-01).
  app.get("/app/api/admin/users", { preHandler: requireAdmin }, async () =>
    listUsers(app.db, config),
  );

  app.get("/app/api/admin/teachers", { preHandler: requireAdmin }, async () => {
    const rows = await app.db
      .select({
        id: teacherGrants.id,
        email: teacherGrants.email,
        grantedAt: teacherGrants.createdAt,
        givenName: users.givenName,
        familyName: users.familyName,
        lastLoginAt: users.lastLoginAt,
        userId: users.id,
        pictureUrl: users.pictureUrl,
        avatarAt: avatars.updatedAt,
        signedUp: sql<boolean>`${users.id} IS NOT NULL`,
        courses: sql<number>`coalesce((SELECT count(*) FROM ${courseStaff} cs WHERE cs.user_id = ${users.id}), 0)::int`,
      })
      .from(teacherGrants)
      .leftJoin(users, sql`lower(${users.email}) = ${teacherGrants.email}`)
      .leftJoin(avatars, eq(avatars.userId, users.id))
      .orderBy(teacherGrants.createdAt);
    return rows.map(({ userId, pictureUrl, avatarAt, ...r }) => ({
      ...r,
      avatarUrl: shownAvatar(userId, avatarAt, pictureUrl),
      grantedAt: r.grantedAt.toISOString(),
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
    }));
  });

  app.post("/app/api/admin/teachers", { preHandler: requireAdmin }, async (req, reply) => {
    const body = TeacherGrantCreate.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", message: "A valid e-mail is required" });
    }
    const email = body.data.email.trim().toLowerCase();
    if (email === config.SUPER_ADMIN_EMAIL) {
      return reply
        .code(409)
        .send({ error: "is_admin", message: "This e-mail is the administrator" });
    }
    const created = await createTeacherGrant(app.db, { email, createdBy: req.user!.id });
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
    // The teacher list is shared by every administrator, not just the actor:
    // the `admin` topic is what the topic grammar has for that, and it is
    // what the deleted `onResponse` fallback never reached.
    publish("admin", ["admin"]);
    return reply.code(201).send(created);
  });

  app.delete("/app/api/admin/teachers/:gid", { preHandler: requireAdmin }, async (req, reply) => {
    const params = TeacherGrantParams.safeParse(req.params);
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
    publish("admin", ["admin"]);
    return reply.code(204).send();
  });

  // --- System status (N-OPS-03, ADR-055): every check of the registry,
  // behind a short cache; `?fresh=1` is the screen's Refresh.
  app.get("/app/api/admin/system", { preHandler: requireAdmin }, async (req, reply) => {
    const query = SystemStatusQuery.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "validation" });
    return systemStatus(app, config, { fresh: query.data.fresh === "1" });
  });

  // --- "Send me a test e-mail" (ADR-055 §6): to the calling admin, through
  // the mailer alone. One per minute per admin (`budget.ts`): a guard
  // against a double click or a script, not a quota.
  const testMails = new Budget();
  app.post("/app/api/admin/system/test-mail", { preHandler: requireAdmin }, async (req, reply) => {
    const user = req.user!;
    if (!user.email) return reply.code(409).send({ error: "no_email", message: "Your account has no e-mail address" });
    if (!testMails.spend(`test-mail:${user.id}`, 1, app.clock.now())) {
      return reply
        .code(429)
        .header("retry-after", String(BUDGET_RETRY_AFTER_S))
        .send({ error: "rate_limited", message: "One test e-mail per minute" });
    }
    const result: TestMailResult = await sendTestMail(config, req.log, { email: user.email, locale: user.locale });
    await trace(req, "system.test_mail", "user", user.id, result);
    return result;
  });

  // --- Scheduled tasks (F-ADMIN-06, D10): the catalog is code, the rows are
  // its configuration and last state (`modules/system`, seeded at boot). A
  // key the catalog does not hold is a 404, like any missing entity.
  const taskOf = (params: unknown) => {
    const parsed = ScheduledTaskParams.safeParse(params);
    return parsed.success ? scheduledTask(parsed.data.key) : undefined;
  };

  app.get("/app/api/admin/tasks", { preHandler: requireAdmin }, async () =>
    listScheduledTasks(app.db),
  );

  app.patch("/app/api/admin/tasks/:key", { preHandler: requireAdmin }, async (req, reply) => {
    const task = taskOf(req.params);
    if (!task) return reply.code(404).send({ error: "not_found" });
    const body = ScheduledTaskPatch.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "validation",
        message: `The period is a whole number of minutes, ${TASK_INTERVAL_MIN_MINUTES} to ${TASK_INTERVAL_MAX_MINUTES}`,
      });
    }
    if (!(await configureScheduledTask(app.db, task, body.data))) {
      return reply.code(404).send({ error: "not_found" });
    }
    await trace(req, "task.configure", "scheduled_task", task.key, body.data);
    publish("admin", ["admin"]);
    return scheduledTaskRow(app.db, task);
  });

  // Claimed here, atomically, then run: the ticker's claim and this one
  // exclude each other, so a task never runs twice at once (409 while it
  // runs). 200 with the outcome when it ran inline (no queue), 202 when it
  // was enqueued and its outcome is still to come.
  app.post("/app/api/admin/tasks/:key/run", { preHandler: requireAdmin }, async (req, reply) => {
    const task = taskOf(req.params);
    if (!task) return reply.code(404).send({ error: "not_found" });
    if (!(await claimTaskNow(app.db, task))) {
      return reply.code(409).send({ error: "task_running", message: "This task is already running" });
    }
    await trace(req, "task.run_now", "scheduled_task", task.key);
    publish("admin", ["admin"]);
    const how = await dispatchScheduledTask(app, config, task);
    return reply.code(how === "inline" ? 200 : 202).send(await scheduledTaskRow(app.db, task));
  });
}
