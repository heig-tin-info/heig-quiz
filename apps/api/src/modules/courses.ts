import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ClassroomCreate,
  ClassroomPatch,
  CoursePatch,
  CourseCreate,
  EnrollmentPatch,
} from "@quiz/contracts";
import type { Cell } from "@quiz/domain";

import { tracer } from "../audit.js";
import { publish } from "../events.js";
import type { AppConfig } from "../config.js";
import { avatars, classrooms, courseStaff, courses, enrollments, users } from "../db/schema.js";
import { ownersOf } from "../identity.js";
import { syncRoleOfUser } from "../roles.js";
import {
  accessibleClassroom,
  accessibleCourse,
  accessibleEnrollment,
  accessWhere,
  staffAccess,
  teacherGuard,
} from "./guards.js";
import { setJoinCode } from "./org/service.js";
import { claimForExistingUsers, importRoster, rosterView } from "./roster.js";

const RowsBody = z.object({
  rows: z
    .array(z.array(z.union([z.string(), z.number(), z.null()])))
    .min(1)
    .max(5000),
});

/** Staff of a set of courses, for the course cards. */
async function staffOf(app: FastifyInstance, courseIds: string[]) {
  if (courseIds.length === 0) return [];
  return app.db
    .select({
      courseId: courseStaff.courseId,
      userId: users.id,
      givenName: users.givenName,
      familyName: users.familyName,
      email: users.email,
      pictureUrl: users.pictureUrl,
      avatarAt: avatars.updatedAt,
    })
    .from(courseStaff)
    .innerJoin(users, eq(courseStaff.userId, users.id))
    .leftJoin(avatars, eq(avatars.userId, users.id))
    .where(inArray(courseStaff.courseId, courseIds))
    .orderBy(users.familyName, users.givenName);
}

export async function coursesPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);
  const trace = tracer(app);

  // --- Courses ---

  app.get("/app/api/courses", { preHandler: requireTeacher }, async (req) => {
    const rows = await app.db
      .select({ id: courses.id, name: courses.name, code: courses.code, createdAt: courses.createdAt })
      .from(courses)
      .where(accessWhere(req.user!, staffAccess(req.user!.id)))
      .orderBy(asc(courses.code));
    const ids = rows.map((r) => r.id);
    const rooms = ids.length
      ? await app.db
          .select({
            id: classrooms.id,
            name: classrooms.name,
            period: classrooms.period,
            courseId: classrooms.courseId,
            createdAt: classrooms.createdAt,
            archivedAt: classrooms.archivedAt,
            students: sql<number>`count(${enrollments.id}) filter (where not ${enrollments.staff})::int`,
            claimed: sql<number>`count(${enrollments.id}) filter (where ${enrollments.userId} is not null and not ${enrollments.staff})::int`,
          })
          .from(classrooms)
          .leftJoin(enrollments, eq(enrollments.classroomId, classrooms.id))
          .where(and(inArray(classrooms.courseId, ids), isNull(classrooms.archivedAt)))
          .groupBy(classrooms.id)
          .orderBy(classrooms.createdAt)
      : [];
    const staff = await staffOf(app, ids);
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      createdAt: c.createdAt.toISOString(),
      classrooms: rooms
        .filter((r) => r.courseId === c.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          period: r.period,
          courseId: c.id,
          courseName: c.name,
          courseCode: c.code,
          createdAt: r.createdAt.toISOString(),
          archivedAt: r.archivedAt?.toISOString() ?? null,
          students: r.students,
          claimed: r.claimed,
        })),
      staff: staff
        .filter((s) => s.courseId === c.id)
        .map((s) => ({
          userId: s.userId,
          givenName: s.givenName,
          familyName: s.familyName,
          email: s.email,
          avatarUrl: s.avatarAt
            ? `/app/api/users/${s.userId}/avatar?v=${s.avatarAt.getTime()}`
            : s.pictureUrl,
        })),
    }));
  });

  app.post("/app/api/courses", { preHandler: requireTeacher }, async (req, reply) => {
    const body = CourseCreate.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    const code = body.data.code.trim().toUpperCase();
    const id = randomUUID();
    const [created] = await app.db
      .insert(courses)
      .values({ id, name: body.data.name.trim(), code })
      .onConflictDoNothing({ target: courses.code })
      .returning();
    if (!created) {
      return reply
        .code(409)
        .send({ error: "duplicate_code", message: "A course already uses this code" });
    }
    // The creator is the first member of the staff: a course without a staff
    // would be reachable by nobody but an admin.
    await app.db.insert(courseStaff).values({ courseId: id, userId: req.user!.id });
    await trace(req, "course.create", "course", id, { name: created.name, code });
    publish("courses", [`teacher:${req.user!.id}`]);
    return reply.code(201).send({ ...created, createdAt: created.createdAt.toISOString() });
  });

  app.patch("/app/api/courses/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const course = await accessibleCourse(app, req, reply);
    if (!course) return reply;
    const body = CoursePatch.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    const [updated] = await app.db
      .update(courses)
      .set({
        ...(body.data.name ? { name: body.data.name.trim() } : {}),
        ...(body.data.code ? { code: body.data.code.trim().toUpperCase() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(courses.id, course.id))
      .returning();
    await trace(req, "course.update", "course", course.id, body.data);
    return updated;
  });

  app.delete("/app/api/courses/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const course = await accessibleCourse(app, req, reply);
    if (!course) return reply;
    await app.db.delete(courses).where(eq(courses.id, course.id));
    await trace(req, "course.delete", "course", course.id, {
      name: course.name,
      code: course.code,
    });
    return reply.code(204).send();
  });

  // --- Course staff ---

  const StaffBody = z.object({ email: z.email() });

  app.post("/app/api/courses/:id/staff", { preHandler: requireTeacher }, async (req, reply) => {
    const course = await accessibleCourse(app, req, reply);
    if (!course) return reply;
    const body = StaffBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", message: "A valid e-mail is required" });
    }
    // A seat is held by an ACCOUNT, not by an address: the identity of a
    // person is a set of addresses, so the invitee must have signed in once.
    const owners = await ownersOf(app.db, body.data.email);
    if (owners.length !== 1) {
      return reply.code(409).send({
        error: owners.length === 0 ? "unknown_account" : "ambiguous_account",
        message:
          owners.length === 0
            ? "No account has signed in with this address yet"
            : "Several accounts hold this address",
      });
    }
    const userId = owners[0]!;
    await app.db
      .insert(courseStaff)
      .values({ courseId: course.id, userId })
      .onConflictDoNothing();
    // Immediate effect: a colleague added mid-session sees the course
    // without signing out and in again.
    await syncRoleOfUser(app.db, config, userId);
    await trace(req, "course.staff_add", "course", course.id, { userId, email: body.data.email });
    publish("courses", [`teacher:${userId}`, `course:${course.id}`]);
    return reply.code(201).send({ userId });
  });

  const StaffParam = z.object({ id: z.uuid(), uid: z.uuid() });

  app.delete(
    "/app/api/courses/:id/staff/:uid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const course = await accessibleCourse(app, req, reply);
      if (!course) return reply;
      const params = StaffParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const [seats] = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(courseStaff)
        .where(eq(courseStaff.courseId, course.id));
      // Emptying the staff would orphan the course: refuse the last seat.
      if ((seats?.count ?? 0) <= 1) {
        return reply
          .code(409)
          .send({ error: "last_staff", message: "A course keeps at least one staff member" });
      }
      await app.db
        .delete(courseStaff)
        .where(
          and(eq(courseStaff.courseId, course.id), eq(courseStaff.userId, params.data.uid)),
        );
      await syncRoleOfUser(app.db, config, params.data.uid);
      await trace(req, "course.staff_remove", "course", course.id, { userId: params.data.uid });
      publish("courses", [`teacher:${params.data.uid}`, `course:${course.id}`]);
      return reply.code(204).send();
    },
  );

  // --- Classrooms ---

  app.post("/app/api/courses/:id/classrooms", { preHandler: requireTeacher }, async (req, reply) => {
    const course = await accessibleCourse(app, req, reply);
    if (!course) return reply;
    const body = ClassroomCreate.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    const [room] = await app.db
      .insert(classrooms)
      .values({
        id: randomUUID(),
        courseId: course.id,
        name: body.data.name.trim(),
        period: body.data.period.trim(),
      })
      .returning();
    await trace(req, "classroom.create", "classroom", room!.id, {
      name: room!.name,
      courseId: course.id,
    });
    publish("classrooms", [`course:${course.id}`, `teacher:${req.user!.id}`]);
    return reply.code(201).send(room);
  });

  app.get("/app/api/classrooms/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleClassroom(app, req, reply);
    if (!scope) return reply;
    return {
      id: scope.room.id,
      name: scope.room.name,
      period: scope.room.period,
      archivedAt: scope.room.archivedAt?.toISOString() ?? null,
      course: { id: scope.course.id, name: scope.course.name, code: scope.course.code },
      roster: await rosterView(app.db, scope.room.id),
    };
  });

  app.patch("/app/api/classrooms/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleClassroom(app, req, reply);
    if (!scope) return reply;
    const body = ClassroomPatch.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    // Self-enrolment is a switch of its own: turning it on mints the code
    // when there is none, which `org/service.ts` owns (F-ORG-06).
    if (body.data.joinCodeEnabled !== undefined) {
      const state = await setJoinCode(app.db, scope.room.id, body.data.joinCodeEnabled);
      await trace(req, "classroom.join_code", "classroom", scope.room.id, {
        enabled: state.joinCodeEnabled,
      });
    }
    const [updated] = await app.db
      .update(classrooms)
      .set({
        ...(body.data.name !== undefined ? { name: body.data.name.trim() } : {}),
        ...(body.data.period !== undefined ? { period: body.data.period.trim() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(classrooms.id, scope.room.id))
      .returning();
    if (body.data.name !== undefined || body.data.period !== undefined) {
      await trace(req, "classroom.rename", "classroom", scope.room.id, {
        from: scope.room.name,
        to: updated!.name,
      });
    }
    return updated;
  });

  for (const [path, action, value] of [
    ["archive", "classroom.archive", true],
    ["unarchive", "classroom.unarchive", false],
  ] as const) {
    app.post(
      `/app/api/classrooms/:id/${path}`,
      { preHandler: requireTeacher },
      async (req, reply) => {
        const scope = await accessibleClassroom(app, req, reply);
        if (!scope) return reply;
        await app.db
          .update(classrooms)
          .set({ archivedAt: value ? new Date() : null, updatedAt: new Date() })
          .where(eq(classrooms.id, scope.room.id));
        await trace(req, action, "classroom", scope.room.id, { name: scope.room.name });
        return reply.code(204).send();
      },
    );
  }

  app.delete("/app/api/classrooms/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleClassroom(app, req, reply);
    if (!scope) return reply;
    await app.db.delete(classrooms).where(eq(classrooms.id, scope.room.id));
    await trace(req, "classroom.delete", "classroom", scope.room.id, { name: scope.room.name });
    return reply.code(204).send();
  });

  // Self-enroll: a teacher takes a (staff) seat in their own classroom to
  // exercise the student flow without a second account. The seat is claimed
  // immediately and flagged `staff` so it stays out of the headcount.
  app.post(
    "/app/api/classrooms/:id/self-enroll",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleClassroom(app, req, reply);
      if (!scope) return reply;
      const me = req.user!;
      try {
        await app.db
          .insert(enrollments)
          .values({
            id: randomUUID(),
            classroomId: scope.room.id,
            nom: me.familyName,
            prenom: me.givenName,
            email: me.email.trim().toLowerCase(),
            userId: me.id,
            claimedAt: new Date(),
            staff: true,
          })
          .onConflictDoUpdate({
            target: [enrollments.classroomId, enrollments.email],
            set: { userId: me.id, claimedAt: new Date(), staff: true },
          });
      } catch {
        // UNIQUE(classroom_id, user_id): already enrolled under another address.
        return reply.code(409).send({ error: "already_enrolled" });
      }
      await trace(req, "roster.self_enroll", "classroom", scope.room.id);
      publish("roster", [`classroom:${scope.room.id}`, `user:${me.id}`]);
      return reply.code(201).send({ ok: true });
    },
  );

  // --- Roster ---

  app.post("/app/api/classrooms/:id/roster", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleClassroom(app, req, reply);
    if (!scope) return reply;
    // Two forms: raw CSV (text/csv) or tabular {rows} lines (JSON),
    // typically extracted from an Excel file client-side.
    let source: { csv: string } | { rows: Cell[][] };
    if (typeof req.body === "string" && req.body.length > 0) {
      source = { csv: req.body };
    } else {
      const parsed = RowsBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation",
          message: "Expected body: text/csv, or JSON { rows: Cell[][] }",
        });
      }
      source = { rows: parsed.data.rows };
    }
    const { parse, summary } = await importRoster(app.db, scope.room.id, source);
    if (!parse.ok) {
      // Atomic import: nothing was written.
      return reply.code(400).send({ error: "roster_invalid", errors: parse.errors });
    }
    await trace(req, "roster.import", "classroom", scope.room.id, { rows: parse.rows.length });
    // Students already registered on the platform are attached immediately.
    await claimForExistingUsers(app.db, scope.room.id);
    return reply.code(200).send({ rows: parse.rows.length, ...summary });
  });

  app.patch(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const entry = await accessibleEnrollment(app, req, reply);
      if (!entry) return reply;
      const body = EnrollmentPatch.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "validation", issues: body.error.issues });
      }
      const email = body.data.email?.trim().toLowerCase();
      const emailChanged = email !== undefined && email !== entry.email;
      try {
        const [updated] = await app.db
          .update(enrollments)
          .set({
            ...(body.data.nom ? { nom: body.data.nom } : {}),
            ...(body.data.prenom ? { prenom: body.data.prenom } : {}),
            ...(email ? { email } : {}),
            ...(body.data.timeBonusPercent !== undefined
              ? { timeBonusPercent: body.data.timeBonusPercent }
              : {}),
            ...(body.data.note !== undefined ? { note: body.data.note } : {}),
            // Changing the email invalidates the attachment: the entry is
            // again claimable by the holder of the new address.
            ...(emailChanged
              ? { userId: null, claimedAt: null, conflictFlag: false }
              : {}),
          })
          .where(eq(enrollments.id, entry.id))
          .returning();
        await trace(req, "roster.update", "enrollment", entry.id, { ...body.data, emailChanged });
        if (emailChanged) await claimForExistingUsers(app.db, entry.classroomId);
        return updated;
      } catch {
        // UNIQUE(classroom_id, email)
        return reply
          .code(409)
          .send({ error: "duplicate_email", message: "This e-mail is already in the roster" });
      }
    },
  );

  app.post(
    "/app/api/classrooms/:id/roster/:eid/unclaim",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const entry = await accessibleEnrollment(app, req, reply);
      if (!entry) return reply;
      const [updated] = await app.db
        .update(enrollments)
        .set({ userId: null, claimedAt: null, conflictFlag: false })
        .where(eq(enrollments.id, entry.id))
        .returning();
      await trace(req, "roster.unclaim", "enrollment", entry.id, { previousUserId: entry.userId });
      return updated;
    },
  );

  app.delete(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const entry = await accessibleEnrollment(app, req, reply);
      if (!entry) return reply;
      await app.db.delete(enrollments).where(eq(enrollments.id, entry.id));
      await trace(req, "roster.remove", "enrollment", entry.id, {
        nom: entry.nom,
        prenom: entry.prenom,
        email: entry.email,
      });
      return reply.code(204).send();
    },
  );
}
