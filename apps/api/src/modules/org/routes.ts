/**
 * HTTP surface of the `org` module (PLAN-MVP §4.1): courses, their staff and
 * pools, classrooms, the roster, the join code (F-ORG-06), and the student's
 * own list of classrooms.
 *
 * Every statement lives in `./service.ts` (audit B-12). The teacher routes
 * that act on one entity run on `teacherRoute`: params (404), then the entity
 * under `staffAccess` (404, invariant 6), then the body — so a caller off the
 * staff learns nothing, not even that their body was malformed.
 *
 * Their 400 is still the raw zod `issues` shape (`invalidIssues` below, B-03's
 * second shape), not the `details` of `invalid()`: aligning it is a wire
 * change with its own look at the web error rendering, so the body is parsed
 * inside the handler rather than by the wrapper.
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
  JoinParams,
  type CourseDetail,
  type JoinResult,
  type StudentClassroom,
} from "@quiz/contracts";
import type { Cell } from "@quiz/domain";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { publish } from "../../events.js";
import { ownersOf } from "../../identity.js";
import { syncRoleOfUser } from "../../roles.js";
import {
  accessWhere,
  accessibleClassroom,
  accessibleCourse,
  accessibleEnrollment,
  poolAccess,
  staffAccess,
  teacherGuard,
} from "../guards.js";
import { teacherRoute } from "../http.js";
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
const EntryParam = z.object({ id: z.uuid(), eid: z.uuid() });

/** The 400 these routes have always sent: the raw zod issues (B-03's second shape). */
function invalidIssues(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "validation", issues: error.issues });
}

export async function orgPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);
  const trace = tracer(app);

  /** The module's error tail: nothing it expects, so every failure is a logged 500. */
  function failure(reply: FastifyReply, error: unknown): FastifyReply {
    reply.log.error({ err: error, cause: (error as Error)?.cause }, "org route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  const teacher = teacherRoute(app, failure);
  /** The loaders of invariant 6: each answers its own 404 and returns null. */
  const loadCourse = (req: FastifyRequest, reply: FastifyReply) => accessibleCourse(app, req, reply);
  const onCourse = { params: IdParam, load: loadCourse };
  const onClassroom = {
    params: IdParam,
    load: (req: FastifyRequest, reply: FastifyReply) => accessibleClassroom(app, req, reply),
  };
  const onEntry = {
    params: EntryParam,
    load: (req: FastifyRequest, reply: FastifyReply) => accessibleEnrollment(app, req, reply),
  };

  // --- Courses ---

  app.get("/app/api/courses", { preHandler: requireTeacher }, async (req) =>
    service.listCourses(app.db, accessWhere(req.user!, staffAccess(req.user!.id))),
  );

  app.post("/app/api/courses", { preHandler: requireTeacher }, async (req, reply) => {
    const body = CourseCreate.safeParse(req.body);
    if (!body.success) return invalidIssues(reply, body.error);
    const code = body.data.code.trim().toUpperCase();
    const created = await service.createCourse(
      app.db,
      { name: body.data.name.trim(), code },
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
          archivedAt: r.archivedAt?.toISOString() ?? null,
          joinCode: r.joinCode,
          joinCodeEnabled: r.joinCodeEnabled,
        })),
      };
      return detail;
    }),
  );

  app.patch(
    "/app/api/courses/:id",
    { preHandler: requireTeacher },
    teacher(onCourse, async ({ req, reply, scope: course }) => {
      const body = CoursePatch.safeParse(req.body);
      if (!body.success) return invalidIssues(reply, body.error);
      const updated = await service.updateCourse(app.db, course.id, body.data);
      await trace(req, "course.update", "course", course.id, body.data);
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
   * The whole set of pools the course draws from, replaced in one call.
   * Only pools the caller can already reach are linked — the write goes
   * through `pool/service.ts`, which owns `course_pools`.
   */
  app.put(
    "/app/api/courses/:id/pools",
    { preHandler: requireTeacher },
    teacher(onCourse, async ({ req, reply, scope: course }) => {
      const body = CoursePoolsPut.safeParse(req.body);
      if (!body.success) return invalidIssues(reply, body.error);
      const linked = await setCoursePools(
        app.db,
        course.id,
        body.data.poolIds,
        accessWhere(req.user!, poolAccess(req.user!.id)),
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
    teacher(onCourse, async ({ req, reply, scope: course }) => {
      const body = ClassroomCreate.safeParse(req.body);
      if (!body.success) return invalidIssues(reply, body.error);
      const room = await service.createClassroom(app.db, course.id, body.data);
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
      archivedAt: scope.room.archivedAt?.toISOString() ?? null,
      course: { id: scope.course.id, name: scope.course.name, code: scope.course.code },
      roster: await rosterView(app.db, scope.room.id),
    })),
  );

  app.patch(
    "/app/api/classrooms/:id",
    { preHandler: requireTeacher },
    teacher(onClassroom, async ({ req, reply, scope }) => {
      const body = ClassroomPatch.safeParse(req.body);
      if (!body.success) return invalidIssues(reply, body.error);
      // Self-enrolment is a switch of its own: turning it on mints the code
      // when there is none (F-ORG-06).
      if (body.data.joinCodeEnabled !== undefined) {
        const state = await service.setJoinCode(app.db, scope.room.id, body.data.joinCodeEnabled);
        await trace(req, "classroom.join_code", "classroom", scope.room.id, {
          enabled: state.joinCodeEnabled,
        });
      }
      const updated = await service.updateClassroom(app.db, scope.room.id, body.data);
      if (body.data.name !== undefined || body.data.period !== undefined) {
        await trace(req, "classroom.rename", "classroom", scope.room.id, {
          from: scope.room.name,
          to: updated!.name,
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
      await claimForExistingUsers(app.db, scope.room.id);
      return reply.code(200).send({ rows: parse.rows.length, ...summary });
    }),
  );

  app.patch(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    teacher(onEntry, async ({ req, reply, scope: entry }) => {
      const body = EnrollmentPatch.safeParse(req.body);
      if (!body.success) return invalidIssues(reply, body.error);
      const email = body.data.email?.trim().toLowerCase();
      const emailChanged = email !== undefined && email !== entry.email;
      try {
        const updated = await service.updateEnrollment(
          app.db,
          entry.id,
          body.data,
          email,
          emailChanged,
        );
        await trace(req, "roster.update", "enrollment", entry.id, { ...body.data, emailChanged });
        if (emailChanged) await claimForExistingUsers(app.db, entry.classroomId);
        return updated;
      } catch {
        // UNIQUE(classroom_id, email)
        return reply
          .code(409)
          .send({ error: "duplicate_email", message: "This e-mail is already in the roster" });
      }
    }),
  );

  app.post(
    "/app/api/classrooms/:id/roster/:eid/unclaim",
    { preHandler: requireTeacher },
    teacher(onEntry, async ({ req, scope: entry }) => {
      const updated = await service.unclaimEnrollment(app.db, entry.id);
      await trace(req, "roster.unclaim", "enrollment", entry.id, { previousUserId: entry.userId });
      return updated;
    }),
  );

  app.delete(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    teacher(onEntry, async ({ req, reply, scope: entry }) => {
      await service.removeEnrollment(app.db, entry.id);
      await trace(req, "roster.remove", "enrollment", entry.id, {
        nom: entry.nom,
        prenom: entry.prenom,
        email: entry.email,
      });
      return reply.code(204).send();
    }),
  );

  // --- Students ---

  /**
   * `POST /app/api/join/:code` — the student side (F-ORG-06). Any session
   * may call it: the code IS the authorization, and a wrong or disabled one
   * is a plain 404, so the route says nothing about which codes exist.
   */
  app.post(
    "/app/api/join/:code",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = JoinParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const row = await service.classroomByJoinCode(
        app.db,
        params.data.code.trim().toUpperCase(),
      );
      if (!row || row.room.archivedAt) return reply.code(404).send({ error: "not_found" });

      const me = req.user!;
      const outcome = await service.joinClassroom(app.db, row.room.id, me);
      if (!outcome.ok) {
        return reply.code(409).send({
          error: "claimed_by_other",
          message: "This roster entry is already attached to another account",
        });
      }
      if (outcome.status === "joined") {
        await trace(req, "roster.join", "classroom", row.room.id, { email: me.email });
        publish(
          "roster",
          [`classroom:${row.room.id}`, `user:${me.id}`],
          { kind: "student_joined", message: `${me.givenName} ${me.familyName}`.trim() },
        );
      }
      const result: JoinResult = {
        classroomId: row.room.id,
        classroomName: row.room.name,
        courseCode: row.course.code,
        status: outcome.status,
      };
      return reply.code(outcome.status === "joined" ? 201 : 200).send(result);
    },
  );

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
