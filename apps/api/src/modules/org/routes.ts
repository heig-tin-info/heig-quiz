/**
 * HTTP surface of the `org` module (PLAN-MVP §4.1): courses, their staff and
 * pools, classrooms, the roster, and the student's own list of classrooms.
 *
 * Every database statement lives in `./service.ts` or in the module-local
 * helpers it re-exports (`./roster.ts`, the shared role and pool helpers) —
 * never in a handler (audit B-12). The teacher routes
 * that act on one entity run on `teacherRoute`: params (404), then the entity
 * under `staffAccess` (404, invariant 6), then the body — so a caller off the
 * staff learns nothing, not even that their body was malformed. Their 400
 * is the wrapper's `invalid()`, `{ error: "validation", details }`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ClassroomCreate,
  ClassroomPatch,
  CoursePatch,
  CourseCreate,
  CoursePoolsPut,
  EnrollmentPatch,
  IdParam,
  RosterEntryParams,
  type CourseDetail,
  type StudentClassroom,
} from "@quiz/contracts";
import type { Cell } from "@quiz/domain";

import { tracer } from "../../audit.js";
import { issueImpersonationLink } from "../../auth/impersonation.js";
import type { AppConfig } from "../../config.js";
import { publish } from "../../events.js";
import { ownersOf } from "../../identity.js";
import { syncRoleOfUser } from "../../roles.js";
import {
  accessibleClassroom,
  accessibleCourse,
  accessibleEnrollment,
  accessWhere,
  adminGuard,
  callerOf,
  poolAccess,
  staffAccess,
  superPowersGuard,
  teacherGuard,
} from "../guards.js";
import { invalid, notFound, teacherRoute } from "../http.js";
import { poolsOfCourse, setCoursePools } from "../pool/service.js";
import { claimForExistingUsers, importRoster, rosterView } from "./roster.js";
import * as service from "./service.js";

const RowsBody = z.object({
  rows: z
    .array(z.array(z.union([z.string(), z.number(), z.null()])))
    .min(1)
    .max(5000),
});

const StaffBody = z.object({ email: z.email() });
const StaffParam = z.object({ id: z.uuid(), uid: z.uuid() });

export async function orgPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);
  const requireAdmin = adminGuard(app, { hidden: true });
  const trace = tracer(app);

  const teacher = teacherRoute(app);
  /** The loaders of invariant 6: each answers its own 404 and returns null. */
  const loadCourse = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    accessibleCourse(app, req, reply, p);
  const onCourse = { params: IdParam, load: loadCourse };
  const onClassroom = {
    params: IdParam,
    load: (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
      accessibleClassroom(app, req, reply, p),
  };
  const onEntry = {
    params: RosterEntryParams,
    load: (req: FastifyRequest, reply: FastifyReply, p: { id: string; eid: string }) =>
      accessibleEnrollment(app, req, reply, p),
  };

  // --- Courses ---

  app.get("/app/api/courses", { preHandler: requireTeacher }, async (req) =>
    service.listCourses(app.db, accessWhere(callerOf(req), staffAccess(req.user!.id)), req.user!.id),
  );

  app.post("/app/api/courses", { preHandler: requireTeacher }, async (req, reply) => {
    const body = CourseCreate.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const code = body.data.code.trim().toUpperCase();
    const created = await service.createCourse(
      app.db,
      { name: body.data.name, code },
      req.user!.id,
    );
    if (!created) {
      return reply
        .code(409)
        .send({ error: "duplicate_code", message: "A course already uses this code" });
    }
    await trace(req, "course.create", "course", created.id, { name: created.name, code });
    publish("courses", [`teacher:${req.user!.id}`]);
    return reply.code(201).send({ ...created, createdAt: created.createdAt.toISOString() });
  });

  /** `GET /courses/:id` — the course, its staff, its pools and its classrooms. */
  app.get(
    "/app/api/courses/:id",
    { preHandler: requireTeacher },
    teacher(onCourse, async ({ scope: course }) => {
      const [staff, rooms, pools] = await Promise.all([
        service.staffOfCourse(app.db, course.id),
        service.classroomsOfCourse(app.db, course.id),
        poolsOfCourse(app.db, course.id),
      ]);
      const detail: CourseDetail = {
        course: { id: course.id, name: course.name, code: course.code },
        staff,
        pools: pools.map((p) => ({
          id: p.id,
          name: p.name,
          visibility: p.visibility,
          questionCount: p.questionCount,
        })),
        classrooms: rooms.map((r) => ({
          id: r.id,
          name: r.name,
          period: r.period,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          archivedAt: r.archivedAt?.toISOString() ?? null,
        })),
      };
      return detail;
    }),
  );

  app.patch(
    "/app/api/courses/:id",
    { preHandler: requireTeacher },
    teacher({ ...onCourse, body: CoursePatch }, async ({ req, body, scope: course }) => {
      const updated = await service.updateCourse(app.db, course.id, body);
      await trace(req, "course.update", "course", course.id, body);
      return updated;
    }),
  );

  app.delete(
    "/app/api/courses/:id",
    { preHandler: requireTeacher },
    teacher(onCourse, async ({ req, reply, scope: course }) => {
      await service.deleteCourse(app.db, course.id);
      await trace(req, "course.delete", "course", course.id, {
        name: course.name,
        code: course.code,
      });
      return reply.code(204).send();
    }),
  );

  /**
   * Hide a course from the caller's own navigation, or show it again (#155,
   * ADR-032). Loaded under `staffAccess` like every course route, so an
   * admin may hide too and anyone off the staff gets the 404. Personal
   * display state: no audit event; the `onResponse` hook of `app.ts` already
   * tells the caller's other tabs to refetch.
   */
  for (const [path, hidden] of [
    ["hide", true],
    ["unhide", false],
  ] as const) {
    app.post(
      `/app/api/courses/:id/${path}`,
      { preHandler: requireTeacher },
      teacher(onCourse, async ({ req, reply, scope: course }) => {
        await service.setCourseHidden(app.db, req.user!.id, course.id, hidden);
        return reply.code(204).send();
      }),
    );
  }

  /**
   * The whole set of pools the course draws from, replaced in one call.
   * Only pools the caller can already reach are linked, and a NEW link needs
   * contributor access to the pool (ADR-013) — the write goes through
   * `pool/service.ts`, which owns `course_pools`.
   */
  app.put(
    "/app/api/courses/:id/pools",
    { preHandler: requireTeacher },
    teacher({ ...onCourse, body: CoursePoolsPut }, async ({ req, body, scope: course }) => {
      // A pool the caller only reads is `PoolLinkForbidden`'s 403 (ADR-013).
      const linked = await setCoursePools(
        app.db,
        course.id,
        body.poolIds,
        accessWhere(callerOf(req), poolAccess(req.user!.id)),
        callerOf(req),
      );
      await trace(req, "course.pools_update", "course", course.id, {
        poolIds: linked.map((p) => p.id),
      });
      publish("courses", [`course:${course.id}`, `teacher:${req.user!.id}`]);
      for (const pool of linked) publish("pool", [`pool:${pool.id}`]);
      return linked;
    }),
  );

  // --- Course staff ---

  app.post(
    "/app/api/courses/:id/staff",
    { preHandler: requireTeacher },
    teacher(onCourse, async ({ req, reply, scope: course }) => {
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
      await service.addStaff(app.db, course.id, userId);
      // Immediate effect: a colleague added mid-session sees the course
      // without signing out and in again.
      await syncRoleOfUser(app.db, config, userId);
      await trace(req, "course.staff_add", "course", course.id, { userId, email: body.data.email });
      publish("courses", [`teacher:${userId}`, `course:${course.id}`]);
      return reply.code(201).send({ userId });
    }),
  );

  app.delete(
    "/app/api/courses/:id/staff/:uid",
    { preHandler: requireTeacher },
    teacher({ params: StaffParam, load: loadCourse }, async ({ req, reply, params, scope: course }) => {
      const { uid } = params;
      // Emptying the staff would orphan the course: refuse the last seat.
      if ((await service.staffSeatCount(app.db, course.id)) <= 1) {
        return reply
          .code(409)
          .send({ error: "last_staff", message: "A course keeps at least one staff member" });
      }
      await service.removeStaff(app.db, course.id, uid);
      await syncRoleOfUser(app.db, config, uid);
      await trace(req, "course.staff_remove", "course", course.id, { userId: uid });
      publish("courses", [`teacher:${uid}`, `course:${course.id}`]);
      return reply.code(204).send();
    }),
  );

  // --- Classrooms ---

  app.post(
    "/app/api/courses/:id/classrooms",
    { preHandler: requireTeacher },
    teacher({ ...onCourse, body: ClassroomCreate }, async ({ req, reply, body, scope: course }) => {
      const room = await service.createClassroom(app.db, course.id, body);
      await trace(req, "classroom.create", "classroom", room.id, {
        name: room.name,
        courseId: course.id,
      });
      publish("classrooms", [`course:${course.id}`, `teacher:${req.user!.id}`]);
      return reply.code(201).send(room);
    }),
  );

  app.get(
    "/app/api/classrooms/:id",
    { preHandler: requireTeacher },
    teacher(onClassroom, async ({ scope }) => ({
      id: scope.room.id,
      name: scope.room.name,
      period: scope.room.period,
      periodStart: scope.room.periodStart,
      periodEnd: scope.room.periodEnd,
      archivedAt: scope.room.archivedAt?.toISOString() ?? null,
      drillEnabled: scope.room.drillEnabledAt !== null,
      course: { id: scope.course.id, name: scope.course.name, code: scope.course.code },
      roster: await rosterView(app.db, scope.room.id),
    })),
  );

  app.patch(
    "/app/api/classrooms/:id",
    { preHandler: requireTeacher },
    teacher({ ...onClassroom, body: ClassroomPatch }, async ({ req, body, scope }) => {
      const updated = await service.updateClassroom(app.db, scope.room.id, body);
      const { name, period, periodStart } = body;
      if (name !== undefined || period !== undefined || periodStart !== undefined) {
        // The period is part of what the classroom is called: its old and new
        // label and months ride on the same entry (#156).
        const periodOf = (r: typeof scope.room) => ({
          period: r.period,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
        });
        await trace(req, "classroom.rename", "classroom", scope.room.id, {
          from: scope.room.name,
          to: updated!.name,
          periodFrom: periodOf(scope.room),
          periodTo: periodOf(updated!),
        });
      }
      return updated;
    }),
  );

  for (const [path, action, value] of [
    ["archive", "classroom.archive", true],
    ["unarchive", "classroom.unarchive", false],
  ] as const) {
    app.post(
      `/app/api/classrooms/:id/${path}`,
      { preHandler: requireTeacher },
      teacher(onClassroom, async ({ req, reply, scope }) => {
        await service.setArchived(app.db, scope.room.id, value);
        await trace(req, action, "classroom", scope.room.id, { name: scope.room.name });
        return reply.code(204).send();
      }),
    );
  }

  app.delete(
    "/app/api/classrooms/:id",
    { preHandler: requireTeacher },
    teacher(onClassroom, async ({ req, reply, scope }) => {
      await service.deleteClassroom(app.db, scope.room.id);
      await trace(req, "classroom.delete", "classroom", scope.room.id, { name: scope.room.name });
      return reply.code(204).send();
    }),
  );

  // Self-enroll: a teacher takes a (staff) seat in their own classroom to
  // exercise the student flow without a second account. The seat is claimed
  // immediately and flagged `staff` so it stays out of the headcount.
  app.post(
    "/app/api/classrooms/:id/self-enroll",
    { preHandler: requireTeacher },
    teacher(onClassroom, async ({ req, reply, scope }) => {
      const me = req.user!;
      try {
        await service.selfEnroll(app.db, scope.room.id, me);
      } catch {
        // UNIQUE(classroom_id, user_id): already enrolled under another address.
        return reply.code(409).send({ error: "already_enrolled" });
      }
      await trace(req, "roster.self_enroll", "classroom", scope.room.id);
      publish("roster", [`classroom:${scope.room.id}`, `user:${me.id}`]);
      return reply.code(201).send({ ok: true });
    }),
  );

  // --- Roster ---

  app.post(
    "/app/api/classrooms/:id/roster",
    { preHandler: requireTeacher },
    teacher(onClassroom, async ({ req, reply, scope }) => {
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
      await claimForExistingUsers(app.db, scope.room.id, req.user!.id);
      return reply.code(200).send({ rows: parse.rows.length, ...summary });
    }),
  );

  app.patch(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    teacher({ ...onEntry, body: EnrollmentPatch }, async ({ req, reply, body, scope: entry }) => {
      const email = body.email?.trim().toLowerCase();
      const emailChanged = email !== undefined && email !== entry.email;
      let updated: Awaited<ReturnType<typeof service.updateEnrollment>>;
      try {
        updated = await service.updateEnrollment(app.db, entry, body, email, emailChanged);
      } catch {
        // UNIQUE(classroom_id, email) — and only that: the claim below runs
        // after the update committed, and its failure is not a duplicate.
        return reply
          .code(409)
          .send({ error: "duplicate_email", message: "This e-mail is already in the roster" });
      }
      await trace(req, "roster.update", "enrollment", entry.id, { ...body, emailChanged });
      if (emailChanged) await claimForExistingUsers(app.db, entry.classroomId, req.user!.id);
      return updated;
    }),
  );

  app.post(
    "/app/api/classrooms/:id/roster/:eid/unclaim",
    { preHandler: requireTeacher },
    teacher(onEntry, async ({ req, scope: entry }) => {
      const updated = await service.unclaimEnrollment(app.db, entry);
      await trace(req, "roster.unclaim", "enrollment", entry.id, { previousUserId: entry.userId });
      return updated;
    }),
  );

  app.delete(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    teacher(onEntry, async ({ req, reply, scope: entry }) => {
      await service.removeEnrollment(app.db, entry);
      await trace(req, "roster.remove", "enrollment", entry.id, {
        nom: entry.nom,
        prenom: entry.prenom,
        email: entry.email,
      });
      return reply.code(204).send();
    }),
  );

  /**
   * ADR-034: the one-time link that opens a session as this student. Admins
   * only in v1 — the session reads everything the student reads, beyond any
   * staff seat — and anyone else gets the 404 of a missing entry, as does an
   * entry that is not a claimed student seat. And only with Super Powers on
   * (ADR-054): an admin acting as a teacher on their own course creates no
   * link. The session the link opens then lives out its own fixed hour,
   * whatever becomes of the Super Powers that created it.
   */
  app.post(
    "/app/api/classrooms/:id/roster/:eid/impersonation",
    { preHandler: [requireAdmin, superPowersGuard()] },
    teacher(onEntry, async ({ req, reply, now, scope: entry }) =>
      (await issueImpersonationLink(app.db, config, entry, req.user!.id, now)) ?? notFound(reply),
    ),
  );

  // --- Students ---

  /**
   * Student surface. A student sees the classrooms whose roster entry they
   * claimed, and nothing else — no course listing, no roster of their peers.
   */
  app.get(
    "/app/api/student/classrooms",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req): Promise<StudentClassroom[]> => service.studentClassrooms(app.db, req.user!.id),
  );
}
