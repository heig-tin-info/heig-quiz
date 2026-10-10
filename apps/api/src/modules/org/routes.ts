/**
 * HTTP surface of the `org` module (PLAN-MVP §4.1): courses, their staff and
 * pools, classrooms, the roster, and the student's own list of classrooms.
 *
 * Every database statement lives in `./service.ts` or in the module-local
 * helpers it re-exports (`./roster.ts`, the shared role and pool helpers) —
 * never in a handler (audit B-12). The teacher routes
 * that act on one entity run on `teacherRoute`: params (404), then the entity
 * under `staffAccess` (404, invariant 6), then — for what only an owner of
 * the course may do (ADR-068) — the caller's role (403 `owner_required`),
 * then the body — so a caller off the staff learns nothing, not even that
 * their body was malformed, and an assistant learns only that they may not.
 * Their 400 is the wrapper's `invalid()`, `{ error: "validation", details }`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ClassroomCreate,
  ClassroomDeleteQuery,
  ClassroomPatch,
  CourseConditionCreate,
  CourseConditionOrder,
  CourseConditionParam,
  CourseConditionPatch,
  CourseConceptsPut,
  type CourseConcepts,
  CoursePatch,
  CourseCreate,
  CoursePoolsPut,
  EnrollmentPatch,
  IdParam,
  RosterEntryParams,
  StaffAdd,
  StaffParam,
  StaffPatch,
  TeacherCandidateQuery,
  type CourseDetail,
  type CourseRole,
  type StudentClassroom,
} from "@quiz/contracts";
import type { Cell } from "@quiz/domain";

import { actorOf, tracer } from "../../audit.js";
import { issueImpersonationLink } from "../../auth/impersonation.js";
import type { AppConfig } from "../../config.js";
import { publish } from "../../events.js";
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
  withCourseRole,
} from "../guards.js";
import { courseConceptsOf, setCourseConcepts } from "../concept/service.js";
import { invalid, notFound, readerLang, teacherRoute } from "../http.js";
import { journalRemovalRefused } from "../journal/service.js";
import { poolsOfCourse, setCoursePools } from "../pool/service.js";
import { claimForExistingUsers, importRoster, rosterView } from "./roster.js";
import * as service from "./service.js";

const RowsBody = z.object({
  rows: z
    .array(z.array(z.union([z.string(), z.number(), z.null()])))
    .min(1)
    .max(5000),
});

/** A course keeps at least one owner (ADR-068): the refusal of removing or demoting the last. */
const lastOwner = (reply: FastifyReply) =>
  reply.code(409).send({ error: "last_owner", message: "A course keeps at least one owner" });

/** A course code is unique across the instance: the one refusal of a create and of an edit. */
const duplicateCode = (reply: FastifyReply) =>
  reply.code(409).send({ error: "duplicate_code", message: "A course already uses this code" });

export async function orgPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);
  const requireAdmin = adminGuard(app, { hidden: true });
  const trace = tracer(app);

  const teacher = teacherRoute(app);
  /** The loaders of invariant 6: each answers its own 404 and returns null. */
  const loadCourse = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    accessibleCourse(app, req, reply, p);
  const loadClassroom = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    accessibleClassroom(app, req, reply, p);
  /** The course, and the caller's role on it when `role` is given (ADR-068). */
  const onCourse = (role?: CourseRole) => ({
    params: IdParam,
    load: withCourseRole(app, loadCourse, (course) => course.id, role),
  });
  const onClassroom = (role?: CourseRole) => ({
    params: IdParam,
    load: withCourseRole(app, loadClassroom, (scope) => scope.course.id, role),
  });
  /**
   * One seat of the course's staff. Its role is the owner's to change, and
   * so is the seat, except that a member may always leave: for the caller's
   * own seat the role step is skipped. Still inside `load`, so the refusal
   * comes before the body, like every other owner-only route.
   */
  const ownedCourse = withCourseRole(app, loadCourse, (course) => course.id, "owner");
  const onSeat = { params: StaffParam, load: ownedCourse };
  const onOwnSeatOrOwned = {
    params: StaffParam,
    load: (req: FastifyRequest, reply: FastifyReply, p: { id: string; uid: string }) =>
      p.uid === req.user!.id ? loadCourse(req, reply, p) : ownedCourse(req, reply, p),
  };
  const onEntry = {
    params: RosterEntryParams,
    load: (req: FastifyRequest, reply: FastifyReply, p: { id: string; eid: string }) =>
      accessibleEnrollment(app, req, reply, p),
  };
  /**
   * F-PROJ-17, ADR-070 §5: a roster line leaving, or losing its account,
   * first loses every GitHub access it was given to the classroom's project
   * repositories (the service's writes) — `502 revoke_failed` otherwise.
   */
  const revocation = (req: FastifyRequest, now: Date): service.Revocation => ({ config, actor: actorOf(req), now, log: req.log });

  // --- Courses ---

  app.get("/app/api/courses", { preHandler: requireTeacher }, async (req) =>
    service.listCourses(app.db, accessWhere(callerOf(req), staffAccess(req.user!.id)), {
      id: req.user!.id,
      reachesAll: callerOf(req).reach === "all",
    }),
  );

  app.post("/app/api/courses", { preHandler: requireTeacher }, async (req, reply) => {
    const body = CourseCreate.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const created = await service.createCourse(app.db, body.data, req.user!.id);
    if (!created) return duplicateCode(reply);
    await trace(req, "course.create", "course", created.id, { name: created.name, code: created.code });
    publish("courses", [`teacher:${req.user!.id}`]);
    return reply.code(201).send({ ...created, createdAt: created.createdAt.toISOString() });
  });

  /** `GET /courses/:id` — the course, its staff, its pools and its classrooms. */
  app.get(
    "/app/api/courses/:id",
    { preHandler: requireTeacher },
    teacher(onCourse(), async ({ req, scope: course }) => {
      const [staff, rooms, pools, concepts] = await Promise.all([
        service.staffOfCourse(app.db, course.id),
        service.classroomsOfCourse(app.db, course.id),
        poolsOfCourse(app.db, course.id),
        courseConceptsOf(app.db, course.id, readerLang(req)),
      ]);
      const detail: CourseDetail = {
        course: { id: course.id, name: course.name, code: course.code },
        staff,
        pools: pools.map((p) => ({
          id: p.id,
          name: p.name,
          visibility: p.visibility,
          questionCount: p.questionCount,
          mode: p.mode,
        })),
        classrooms: rooms.map((r) => ({
          id: r.id,
          name: r.name,
          period: r.period,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          archivedAt: r.archivedAt?.toISOString() ?? null,
        })),
        concepts,
      };
      return detail;
    }),
  );

  app.patch(
    "/app/api/courses/:id",
    { preHandler: requireTeacher },
    teacher({ ...onCourse("owner"), body: CoursePatch }, async ({ req, reply, body, scope: course }) => {
      const updated = await service.updateCourse(app.db, course.id, body);
      if (updated === null) return duplicateCode(reply);
      await trace(req, "course.update", "course", course.id, body);
      return updated;
    }),
  );

  app.delete(
    "/app/api/courses/:id",
    { preHandler: requireTeacher },
    teacher(onCourse("owner"), async ({ req, reply, scope: course }) => {
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
      teacher(onCourse(), async ({ req, reply, scope: course }) => {
        await service.setCourseHidden(app.db, req.user!.id, course.id, hidden);
        return reply.code(204).send();
      }),
    );
  }

  /**
   * The whole set of pools the course draws from, each with its mode,
   * replaced in one call. Only pools the caller can already reach are linked;
   * a NEW `edit` link needs contributor access to the pool (ADR-013), a
   * `read` link a public pool (ADR-095) — the write goes through
   * `pool/service.ts`, which owns `course_pools`.
   */
  app.put(
    "/app/api/courses/:id/pools",
    { preHandler: requireTeacher },
    teacher({ ...onCourse("owner"), body: CoursePoolsPut }, async ({ req, body, scope: course }) => {
      // A pool the caller only reads is `setCoursePools`'s 403 `pool_link_forbidden` (ADR-013).
      const linked = await setCoursePools(
        app.db,
        course.id,
        body.pools,
        accessWhere(callerOf(req), poolAccess(req.user!.id)),
        callerOf(req),
      );
      await trace(req, "course.pools_update", "course", course.id, {
        poolIds: linked.map((p) => p.id),
        links: linked.map((p) => ({ poolId: p.id, mode: p.mode })),
      });
      publish("courses", [`course:${course.id}`, `teacher:${req.user!.id}`]);
      for (const pool of linked) publish("pool", [`pool:${pool.id}`]);
      return linked;
    }),
  );

  // --- The concepts a course declares (F-ORG-12, ADR-081 §8) ---

  /**
   * Every member of the staff reads the list in `GET /courses/:id`; only an
   * owner replaces it, here (ADR-068): the course under `staffAccess` (404),
   * then the owner role (403 `owner_required`), then the body. Staff only, in
   * every response: no student route returns it. The write is
   * `concept/service.ts`, which owns `course_concepts` and locks the concepts
   * against a merge; the answer is the new list, by label.
   */

  app.put(
    "/app/api/courses/:id/concepts",
    { preHandler: requireTeacher },
    teacher({ ...onCourse("owner"), body: CourseConceptsPut }, async ({ req, now, body, scope: course }): Promise<CourseConcepts> => {
      await setCourseConcepts(app.db, { actor: actorOf(req), userId: req.user!.id, now }, course.id, body.conceptIds);
      publish("courses", [`course:${course.id}`]);
      return { concepts: await courseConceptsOf(app.db, course.id, readerLang(req)) };
    }),
  );

  // --- The course's catalog of conditions (F-ORG-16, ADR-079 §5) ---

  /**
   * Every member of the staff reads the catalog (an assistant ticks its
   * entries in an evaluation's conditions); only the course's owners write
   * it (ADR-079 §5, amended 2026-10-09): the course under `staffAccess` (404
   * otherwise), then the owner role (403 `owner_required`). An entry is
   * looked up within that course, so another course's id is the same 404.
   */
  const onCondition = {
    params: CourseConditionParam,
    load: async (req: FastifyRequest, reply: FastifyReply, p: { id: string; cid: string }) => {
      const course = await ownedCourse(req, reply, p);
      if (!course) return null;
      const row = await service.conditionOfCourse(app.db, course.id, p.cid);
      if (row) return { course, row };
      notFound(reply);
      return null;
    },
  };

  app.get(
    "/app/api/courses/:id/conditions",
    { preHandler: requireTeacher },
    teacher(onCourse(), async ({ scope: course }) => service.listConditions(app.db, course.id)),
  );

  app.post(
    "/app/api/courses/:id/conditions",
    { preHandler: requireTeacher },
    teacher({ ...onCourse("owner"), body: CourseConditionCreate }, async ({ req, reply, body, scope: course }) => {
      const row = await service.createCondition(app.db, course.id, body);
      await trace(req, "course.condition_create", "course", course.id, {
        conditionId: row.id,
        kind: row.kind,
        text: row.text,
      });
      return reply.code(201).send(service.conditionView(row));
    }),
  );

  app.patch(
    "/app/api/courses/:id/conditions/:cid",
    { preHandler: requireTeacher },
    teacher({ ...onCondition, body: CourseConditionPatch }, async ({ req, now, body, scope }) => {
      const row = await service.updateCondition(app.db, scope.row.id, body, now);
      await trace(req, "course.condition_update", "course", scope.course.id, {
        conditionId: row.id,
        from: { kind: scope.row.kind, text: scope.row.text },
        to: { kind: row.kind, text: row.text },
      });
      return service.conditionView(row);
    }),
  );

  app.put(
    "/app/api/courses/:id/conditions/order",
    { preHandler: requireTeacher },
    teacher({ ...onCourse("owner"), body: CourseConditionOrder }, async ({ reply, body, scope: course }) => {
      await service.reorderConditions(app.db, course.id, body.ids);
      return reply.code(204).send();
    }),
  );

  for (const [path, action, archived] of [
    ["archive", "course.condition_archive", true],
    ["unarchive", "course.condition_unarchive", false],
  ] as const) {
    app.post(
      `/app/api/courses/:id/conditions/:cid/${path}`,
      { preHandler: requireTeacher },
      teacher(onCondition, async ({ req, now, scope }) => {
        // Already in that state: nothing to write, nothing to trace.
        if ((scope.row.archivedAt !== null) === archived) return service.conditionView(scope.row);
        const row = await service.setConditionArchived(app.db, scope.row, archived, now);
        await trace(req, action, "course", scope.course.id, { conditionId: row.id, text: row.text });
        return service.conditionView(row);
      }),
    );
  }

  // --- Course staff ---

  /**
   * The teachers and admins an owner may still seat, by name or address
   * (the picker of "Add a person"): the same owner step as the POST below.
   */
  app.get(
    "/app/api/courses/:id/staff/candidates",
    { preHandler: requireTeacher },
    teacher({ ...onCourse("owner"), query: TeacherCandidateQuery }, async ({ query, scope: course }) =>
      service.staffCandidates(app.db, course.id, query.q),
    ),
  );

  /**
   * A new seat, an assistant unless the body says `owner` (ADR-068). The
   * account is the one picked among the candidates (`userId`, a teacher or
   * an admin) or the one behind a typed address. An account that already
   * holds a seat is `409 already_staff`: its role is changed by the PATCH
   * below, never by adding it again.
   */
  app.post(
    "/app/api/courses/:id/staff",
    { preHandler: requireTeacher },
    teacher({ ...onCourse("owner"), body: StaffAdd }, async ({ req, reply, body, scope: course }) => {
      const who = await service.resolveStaffInvitee(app.db, body);
      if ("error" in who) return reply.code(409).send(who);
      const { id: userId, email } = who;
      if (!(await service.addStaff(app.db, course.id, userId, body.role))) {
        return reply
          .code(409)
          .send({ error: "already_staff", message: "This account is already on the staff" });
      }
      // Immediate effect: a colleague added mid-session sees the course
      // without signing out and in again.
      await syncRoleOfUser(app.db, config, userId);
      await trace(req, "course.staff_add", "course", course.id, {
        userId,
        email,
        role: body.role,
      });
      publish("courses", [`teacher:${userId}`, `course:${course.id}`]);
      return reply.code(201).send({ userId, role: body.role });
    }),
  );

  /** An owner makes a seat an owner or an assistant; the last owner stays one. */
  app.patch(
    "/app/api/courses/:id/staff/:uid",
    { preHandler: requireTeacher },
    teacher({ ...onSeat, body: StaffPatch }, async ({ req, reply, params, body, scope: course }) => {
      const outcome = await service.changeStaffSeat(app.db, course.id, params.uid, body.role);
      if (outcome.refused === "not_found") return notFound(reply);
      if (outcome.refused === "last_owner") return lastOwner(reply);
      if (outcome.from !== body.role) {
        await trace(req, "course.staff_role_change", "course", course.id, {
          userId: params.uid,
          from: outcome.from,
          to: body.role,
        });
        publish("courses", [`teacher:${params.uid}`, `course:${course.id}`]);
      }
      return { userId: params.uid, role: body.role };
    }),
  );

  /** An owner removes a seat; any member removes their own (leaves the course). */
  app.delete(
    "/app/api/courses/:id/staff/:uid",
    { preHandler: requireTeacher },
    teacher(onOwnSeatOrOwned, async ({ req, reply, params, scope: course }) => {
      const { uid } = params;
      const outcome = await service.changeStaffSeat(app.db, course.id, uid, "remove");
      if (outcome.refused === "not_found") return notFound(reply);
      if (outcome.refused === "last_owner") return lastOwner(reply);
      await syncRoleOfUser(app.db, config, uid);
      await trace(req, "course.staff_remove", "course", course.id, { userId: uid, role: outcome.from });
      publish("courses", [`teacher:${uid}`, `course:${course.id}`]);
      return reply.code(204).send();
    }),
  );

  // --- Classrooms ---

  app.post(
    "/app/api/courses/:id/classrooms",
    { preHandler: requireTeacher },
    teacher({ ...onCourse("owner"), body: ClassroomCreate }, async ({ req, reply, body, scope: course }) => {
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
    teacher(onClassroom(), async ({ scope }) => ({
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
    teacher({ ...onClassroom(), body: ClassroomPatch }, async ({ req, body, scope }) => {
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
      teacher(onClassroom(), async ({ req, reply, scope }) => {
        await service.setArchived(app.db, scope.room.id, value);
        await trace(req, action, "classroom", scope.room.id, { name: scope.room.name });
        return reply.code(204).send();
      }),
    );
  }

  /**
   * The classroom goes, and its journal with it by cascade (F-ORG-09): a
   * Quiz-mode journal holding pages is the only copy, so the journal's own
   * guard asks for the classroom's name typed (`?confirm=`, F-JRN-04).
   */
  app.delete(
    "/app/api/classrooms/:id",
    { preHandler: requireTeacher },
    teacher({ ...onClassroom("owner"), query: ClassroomDeleteQuery }, async ({ req, reply, query, scope }) => {
      await journalRemovalRefused(app.db, scope.room, query.confirm);
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
    teacher(onClassroom(), async ({ req, reply, now, scope }) => {
      const me = req.user!;
      await service.selfEnroll(app.db, scope.room.id, me, revocation(req, now));
      await trace(req, "roster.self_enroll", "classroom", scope.room.id);
      publish("roster", [`classroom:${scope.room.id}`, `user:${me.id}`]);
      return reply.code(201).send({ ok: true });
    }),
  );

  // --- Roster ---

  app.post(
    "/app/api/classrooms/:id/roster",
    { preHandler: requireTeacher },
    teacher(onClassroom(), async ({ req, reply, scope }) => {
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
    teacher({ ...onEntry, body: EnrollmentPatch }, async ({ req, reply, now, body, scope: entry }) => {
      const email = body.email?.trim().toLowerCase();
      const emailChanged = email !== undefined && email !== entry.email;
      // `409 duplicate_email`, `502 revoke_failed` (`rosterRefusal`). The
      // claim below runs after the update committed.
      const updated = await service.updateEnrollment(app.db, entry, body, email, emailChanged, revocation(req, now));
      await trace(req, "roster.update", "enrollment", entry.id, { ...body, emailChanged });
      if (emailChanged) await claimForExistingUsers(app.db, entry.classroomId, req.user!.id);
      return updated;
    }),
  );

  app.post(
    "/app/api/classrooms/:id/roster/:eid/unclaim",
    { preHandler: requireTeacher },
    teacher(onEntry, async ({ req, now, scope: entry }) => {
      const updated = await service.unclaimEnrollment(app.db, entry, revocation(req, now));
      await trace(req, "roster.unclaim", "enrollment", entry.id, { previousUserId: entry.userId });
      return updated;
    }),
  );

  app.delete(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    teacher(onEntry, async ({ req, reply, now, scope: entry }) => {
      await service.removeEnrollment(app.db, entry, revocation(req, now));
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
