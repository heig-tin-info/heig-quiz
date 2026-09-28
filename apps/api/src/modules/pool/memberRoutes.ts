/** The people of a pool (F-POOL-05), and its tag vocabulary. */
import type { FastifyInstance } from "fastify";

import {
  IdParam,
  PoolCandidateQuery,
  PoolMemberInvite,
  PoolMemberParam,
  PoolMemberPatch,
  TagParam,
  TagPatch,
} from "@quiz/contracts";

import { pools } from "../../db/schema.js";
import { requirePoolRole } from "../guards.js";
import { invalid } from "../http.js";
import { notify } from "../notifications/service.js";
import { poolChanged, poolPeopleChanged } from "./events.js";
import * as service from "./service.js";
import type { PoolRouteContext } from "./routeContext.js";

export function memberRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, trace, teacher, inPool, topicsOf } = ctx;

  /**
   * Who holds a seat on this pool. Readable by anyone the pool lets in: a
   * contributor has to know whom they are working with, and the list carries
   * no more than the colleagues' names.
   */
  app.get(
    "/app/api/pools/:id/members",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, ({ scope: pool }) =>
      service.listMembers(app.db, pool),
    ),
  );

  /**
   * The colleagues an owner may still invite, matched on a few letters of a
   * name or an address: the list behind the picker of the share sheet. Owner
   * only, like the invitation it prepares — a reader of a pool has no
   * business with the directory of the school.
   */
  app.get(
    "/app/api/pools/:id/candidates",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, query: PoolCandidateQuery, load: inPool("owner") },
      async ({ query, scope: pool }) => {
        return service.listCandidates(app.db, pool, query.q);
      },
    ),
  );

  /**
   * Names a colleague in the pool: an account picked among the candidates,
   * or an address — matched over the whole identity set of an account
   * (GH-11) for a teacher the picker does not list under that spelling. A
   * `private` pool becomes `shared` on the first invitation.
   */
  app.post(
    "/app/api/pools/:id/members",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PoolMemberInvite, load: inPool("owner") },
      async ({ req, reply, body, scope: pool }) => {
        const invitee =
          body.userId !== undefined
            ? await service.findTeacherById(app.db, body.userId)
            : await service.findTeacherByEmail(app.db, body.email!);
        if (!invitee) {
          return reply.code(404).send({
            error: "teacher_not_found",
            message: "No teacher account matches",
          });
        }
        if (await service.isMemberOrOwner(app.db, pool, invitee.id)) {
          return reply
            .code(409)
            .send({ error: "already_member", message: "This account already holds a seat" });
        }
        const added = await service.addMember(app.db, pool, invitee.id, body.role);
        await trace(req, "pool.share", "pool", pool.id, {
          userId: invitee.id,
          email: invitee.email,
          role: body.role,
        });
        await notify(app.db, invitee.id, {
          kind: "pool_shared",
          poolId: pool.id,
          poolName: pool.name,
          role: body.role,
          byName: `${req.user!.givenName ?? ""} ${req.user!.familyName ?? ""}`.trim() || req.user!.email,
        });
        poolChanged(pool.id);
        poolPeopleChanged(await topicsOf(pool));
        return reply.code(201).send(await service.listMembers(app.db, { ...pool, visibility: added.visibility }));
      },
    ),
  );

  /** Changes what a member may do. The `pools.owner_id` account is not here. */
  app.patch(
    "/app/api/pools/:id/members/:userId",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool("owner") }, async ({ req, reply, scope: pool }) => {
      const params = PoolMemberParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const body = PoolMemberPatch.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      if (params.data.userId === pool.ownerId) {
        return reply.code(409).send({
          error: "is_owner",
          message: "The owner of the pool holds their seat by ownership",
        });
      }
      const audience = await topicsOf(pool);
      const done = await service.setMemberRole(app.db, pool.id, params.data.userId, body.data.role);
      if (!done) return reply.code(404).send({ error: "not_found" });
      await trace(req, "pool.member_update", "pool", pool.id, {
        userId: params.data.userId,
        role: body.data.role,
      });
      poolChanged(pool.id);
      poolPeopleChanged(audience);
      return service.listMembers(app.db, pool);
    }),
  );

  /**
   * Removes a seat. An owner removes anyone but the `pools.owner_id` account
   * — that one goes away by a TRANSFER, never by a delete — and a member may
   * remove THEMSELVES, which is how one leaves a pool one was named in.
   */
  app.delete(
    "/app/api/pools/:id/members/:userId",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, reply, scope: pool }) => {
      const params = PoolMemberParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const leaving = params.data.userId === req.user!.id;
      if (!leaving && !(await requirePoolRole(app, req, reply, pool, "owner"))) return reply;
      if (params.data.userId === pool.ownerId) {
        return reply.code(409).send({
          error: "is_owner",
          message: "The owner of a pool cannot be removed from it",
        });
      }
      const audience = await topicsOf(pool);
      const done = await service.removeMember(app.db, pool.id, params.data.userId);
      if (!done) return reply.code(404).send({ error: "not_found" });
      await trace(req, "pool.unshare", "pool", pool.id, {
        userId: params.data.userId,
        left: leaving,
      });
      poolChanged(pool.id);
      poolPeopleChanged(audience);
      return reply.code(204).send();
    }),
  );

  /** The tag vocabulary of the pool: name, description, usage count. */
  app.get(
    "/app/api/pools/:id/tags",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, ({ scope: pool }) =>
      service.poolTags(app.db, pool.id),
    ),
  );

  /**
   * Documents one tag of the pool. The row is created on the spot when the
   * tag only existed on questions so far, so a teacher never has to "declare"
   * a tag before describing it.
   */
  app.patch(
    "/app/api/pools/:id/tags/:tag",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, load: inPool("contributor") },
      async ({ req, reply, scope: pool }) => {
        const params = TagParam.safeParse(req.params);
        if (!params.success) return invalid(reply, params.error);
        const body = TagPatch.safeParse(req.body);
        if (!body.success) return invalid(reply, body.error);
        const tag = await service.describeTag(
          app.db,
          pool.id,
          params.data.tag,
          body.data.description,
        );
        await trace(req, "tag.describe", "pool", pool.id, {
          tag: tag.tag,
          description: tag.description,
        });
        poolChanged(pool.id);
        return tag;
      },
    ),
  );
}
