/**
 * HTTP surface of the `group` module (ADR-070, F-PROJ-06; merge task
 * M3-15a): a classroom's group sets, their groups, a student's place, the
 * random formation. Every body and payload is a schema of
 * `packages/contracts/src/group.ts` (invariant 7); every write answers the
 * set as it now stands (`GroupSetDetail`), but a set's deletion (204).
 *
 * Registered whatever the GitHub configuration (`app.ts`): without Quiz's
 * App no repository exists, and no move waits for the `group.sync` job
 * (M3-15b-2), which a member's place sends once it is applied. Open to
 * every member of a course's staff, by
 * their own portal session (`projectsClassroom`, `accessibleGroupSet`): a
 * student, a teacher off the staff, an impersonation, a `seb` or `kiosk`
 * session, a token get the 404 of a missing set (invariant 6).
 *
 * The students' routes (lot 2, F-PROJ-22, M3-17): their view of the
 * classroom's sets, through its student branch (`readableClassroom`, the
 * student payload forced: a student, a teacher in the student view, an
 * impersonation read it, `writable` false but for the first); and their
 * writes — create and name a group, join, leave, rename their own — by
 * their own portal session on a claimed student seat of a set that reaches
 * them (`studentGroupSet`): a teacher in the student view, a `seb` or
 * `kiosk` session, a token get the 404 of a missing set; an impersonation
 * the 404 in development, and the auth plugin's `403
 * impersonation_read_only` elsewhere (ADR-034). Each answers the
 * classroom's sets as its writer now reads them (`StudentGroupSets`), group
 * ids only, never a roster line's.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  GroupCreate,
  GroupMemberParams,
  GroupMemberPut,
  GroupParams,
  GroupRandomForm,
  GroupRename,
  GroupSetCreate,
  GroupSetPatch,
  IdParam,
  StudentGroupCreate,
  StudentGroupJoin,
} from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { accessibleGroupSet, projectsClassroom, readableClassroom, selfFormingSeat, studentGroupSet } from "../guards.js";
import { studentRoute, teacherRoute } from "../http.js";
import { requestGroupSync } from "../project/service.js";
import * as service from "./service.js";

export async function groupPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const teacher = teacherRoute(app);
  const student = studentRoute(app);
  const session = { preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply) };
  const onSet = { params: IdParam, load: accessibleGroupSet.bind(null, app) };
  const onGroup = { params: GroupParams, load: accessibleGroupSet.bind(null, app) };
  const onMember = { params: GroupMemberParams, load: accessibleGroupSet.bind(null, app) };
  const ctx = (req: FastifyRequest, now: Date): service.WriteContext => ({
    actor: actorOf(req),
    userId: req.user!.id,
    locale: req.user!.locale ?? "en",
    now,
  });

  app.get(
    "/app/api/classrooms/:id/group-sets",
    session,
    teacher({ params: IdParam, load: projectsClassroom.bind(null, app) }, async ({ now, scope }) =>
      service.classroomGroupSets(app.db, scope.room.id, now),
    ),
  );

  app.post(
    "/app/api/classrooms/:id/group-sets",
    session,
    teacher(
      { params: IdParam, load: projectsClassroom.bind(null, app), body: GroupSetCreate, optionalBody: true },
      async ({ req, reply, now, body, scope }) => {
        const id = await service.createGroupSet(app.db, scope, body, ctx(req, now));
        return reply.code(201).send(await service.groupSetDetail(app.db, id, now));
      },
    ),
  );

  app.get(
    "/app/api/group-sets/:id",
    session,
    teacher(onSet, async ({ now, scope }) => service.groupSetDetail(app.db, scope.set.id, now)),
  );

  app.patch(
    "/app/api/group-sets/:id",
    session,
    teacher({ ...onSet, body: GroupSetPatch }, async ({ req, now, body, scope }) => {
      await service.patchGroupSet(app.db, scope, body, ctx(req, now));
      return service.groupSetDetail(app.db, scope.set.id, now);
    }),
  );

  /** Refused while a project that is not archived names it (`409 set_in_use`). */
  app.delete(
    "/app/api/group-sets/:id",
    session,
    teacher(onSet, async ({ req, reply, now, scope }) => {
      await service.deleteGroupSet(app.db, scope, ctx(req, now));
      return reply.code(204).send();
    }),
  );

  /** A new set with the same groups and members; answers the new set. */
  app.post(
    "/app/api/group-sets/:id/duplicate",
    session,
    teacher(onSet, async ({ req, reply, now, scope }) => {
      const id = await service.duplicateGroupSet(app.db, scope, ctx(req, now));
      return reply.code(201).send(await service.groupSetDetail(app.db, id, now));
    }),
  );

  app.post(
    "/app/api/group-sets/:id/groups",
    session,
    teacher({ ...onSet, body: GroupCreate, optionalBody: true }, async ({ req, reply, now, body, scope }) => {
      await service.createGroup(app.db, scope, body.name, ctx(req, now));
      return reply.code(201).send(await service.groupSetDetail(app.db, scope.set.id, now));
    }),
  );

  app.patch(
    "/app/api/group-sets/:id/groups/:gid",
    session,
    teacher({ ...onGroup, body: GroupRename }, async ({ req, now, params, body, scope }) => {
      await service.renameGroup(app.db, scope, params.gid, body.name, ctx(req, now));
      return service.groupSetDetail(app.db, scope.set.id, now);
    }),
  );

  app.delete(
    "/app/api/group-sets/:id/groups/:gid",
    session,
    teacher(onGroup, async ({ req, now, params, scope }) => {
      await service.deleteGroup(app.db, scope, params.gid, ctx(req, now));
      return service.groupSetDetail(app.db, scope.set.id, now);
    }),
  );

  /**
   * A student into a group of the set, or out of every group (`groupId:
   * null`); `409 needs_confirmation` until its GitHub consequences are
   * confirmed (`confirm`), then the `group.sync` job sent (M3-15b-2).
   */
  app.put(
    "/app/api/group-sets/:id/members/:eid",
    session,
    teacher({ ...onMember, body: GroupMemberPut }, async ({ req, now, params, body, scope }) => {
      const due = await service.placeStudent(app.db, scope, params.eid, body, { ...ctx(req, now), confirm: body.confirm });
      await requestGroupSync(app, opts.config, due);
      return service.groupSetDetail(app.db, scope.set.id, now);
    }),
  );

  /** ADR-070 §3: the students in no group, cut at random into new groups. */
  app.post(
    "/app/api/group-sets/:id/random",
    session,
    teacher({ ...onSet, body: GroupRandomForm }, async ({ req, now, body, scope }) => {
      await service.formRandom(app.db, scope, body, ctx(req, now));
      return service.groupSetDetail(app.db, scope.set.id, now);
    }),
  );

  // ------------------------------------------------------------ the students' side (F-PROJ-22, M3-17)

  /** The classroom's sets that reach its students, as the caller reads them (the module's student exit, N-SEC-20). */
  app.get(
    "/app/api/classrooms/:id/group-sets/student",
    session,
    student(
      { params: IdParam, load: (req, reply, p) => readableClassroom(app, req, reply, p, { studentView: true }) },
      async ({ req, now, scope }) =>
        service.studentGroupSets(
          app.db,
          scope.room.id,
          { seatId: scope.seat?.id ?? null, writer: selfFormingSeat(req.auth, scope.seat) },
          now,
        ),
    ),
  );

  const onStudentSet = { params: IdParam, load: studentGroupSet.bind(null, app) };
  /** A write's answer: the classroom's sets as its writer reads them (the loader held `selfFormingSeat`). */
  const asWriter = (scope: { room: { id: string }; seat: { id: string } }, now: Date) =>
    service.studentGroupSets(app.db, scope.room.id, { seatId: scope.seat.id, writer: true }, now);
  const onStudentGroup = { params: GroupParams, load: studentGroupSet.bind(null, app) };

  /** A new group of the set, named by the student or "Group k", with them moved in. */
  app.post(
    "/app/api/group-sets/:id/student/groups",
    session,
    student({ ...onStudentSet, body: StudentGroupCreate, optionalBody: true }, async ({ req, reply, now, body, scope }) => {
      await service.studentCreateGroup(app.db, scope, body.name, ctx(req, now));
      return reply.code(201).send(await asWriter(scope, now));
    }),
  );

  /** The student into a group below the maximum size (`409 group_full`). */
  app.put(
    "/app/api/group-sets/:id/student/membership",
    session,
    student({ ...onStudentSet, body: StudentGroupJoin }, async ({ req, now, body, scope }) => {
      await service.studentJoin(app.db, scope, body.groupId, ctx(req, now));
      return asWriter(scope, now);
    }),
  );

  /** The student out of their group. */
  app.delete(
    "/app/api/group-sets/:id/student/membership",
    session,
    student(onStudentSet, async ({ req, now, scope }) => {
      await service.studentLeave(app.db, scope, ctx(req, now));
      return asWriter(scope, now);
    }),
  );

  /** The student's own group renamed. */
  app.patch(
    "/app/api/group-sets/:id/student/groups/:gid",
    session,
    student({ ...onStudentGroup, body: GroupRename }, async ({ req, now, params, body, scope }) => {
      await service.studentRenameGroup(app.db, scope, params.gid, body.name, ctx(req, now));
      return asWriter(scope, now);
    }),
  );
}
