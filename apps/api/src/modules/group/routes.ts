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
 * session, a token get the 404 of a missing set (invariant 6). The
 * students' routes are lot 2's (M3-17).
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
} from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { accessibleGroupSet, projectsClassroom } from "../guards.js";
import { teacherRoute } from "../http.js";
import { requestGroupSync } from "../project/service.js";
import * as service from "./service.js";

export async function groupPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const teacher = teacherRoute(app);
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
    teacher({ params: IdParam, load: projectsClassroom.bind(null, app) }, async ({ scope }) =>
      service.classroomGroupSets(app.db, scope.room.id),
    ),
  );

  app.post(
    "/app/api/classrooms/:id/group-sets",
    session,
    teacher(
      { params: IdParam, load: projectsClassroom.bind(null, app), body: GroupSetCreate, optionalBody: true },
      async ({ req, reply, now, body, scope }) => {
        const id = await service.createGroupSet(app.db, scope, body, ctx(req, now));
        return reply.code(201).send(await service.groupSetDetail(app.db, id));
      },
    ),
  );

  app.get(
    "/app/api/group-sets/:id",
    session,
    teacher(onSet, async ({ scope }) => service.groupSetDetail(app.db, scope.set.id)),
  );

  app.patch(
    "/app/api/group-sets/:id",
    session,
    teacher({ ...onSet, body: GroupSetPatch }, async ({ req, now, body, scope }) => {
      await service.patchGroupSet(app.db, scope, body, ctx(req, now));
      return service.groupSetDetail(app.db, scope.set.id);
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
      return reply.code(201).send(await service.groupSetDetail(app.db, id));
    }),
  );

  app.post(
    "/app/api/group-sets/:id/groups",
    session,
    teacher({ ...onSet, body: GroupCreate, optionalBody: true }, async ({ req, reply, now, body, scope }) => {
      await service.createGroup(app.db, scope, body.name, ctx(req, now));
      return reply.code(201).send(await service.groupSetDetail(app.db, scope.set.id));
    }),
  );

  app.patch(
    "/app/api/group-sets/:id/groups/:gid",
    session,
    teacher({ ...onGroup, body: GroupRename }, async ({ req, now, params, body, scope }) => {
      await service.renameGroup(app.db, scope, params.gid, body.name, ctx(req, now));
      return service.groupSetDetail(app.db, scope.set.id);
    }),
  );

  app.delete(
    "/app/api/group-sets/:id/groups/:gid",
    session,
    teacher(onGroup, async ({ req, now, params, scope }) => {
      await service.deleteGroup(app.db, scope, params.gid, ctx(req, now));
      return service.groupSetDetail(app.db, scope.set.id);
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
      return service.groupSetDetail(app.db, scope.set.id);
    }),
  );

  /** ADR-070 §3: the students in no group, cut at random into new groups. */
  app.post(
    "/app/api/group-sets/:id/random",
    session,
    teacher({ ...onSet, body: GroupRandomForm }, async ({ req, now, body, scope }) => {
      await service.formRandom(app.db, scope, body, ctx(req, now));
      return service.groupSetDetail(app.db, scope.set.id);
    }),
  );
}
