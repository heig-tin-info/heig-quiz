/** The people of a pool (F-POOL-05). */
import type { FastifyInstance } from "fastify";

import {
  IdParam,
  TeacherCandidateQuery,
  PoolMemberInvite,
  PoolMemberParam,
  PoolMemberPatch,
} from "@quiz/contracts";

import { findTeacherById } from "../../directory.js";
import { callerOf, poolRoleOf, requirePoolRole } from "../guards.js";
import { DomainError } from "../http.js";
import { notify } from "../notifications/service.js";
import { accessRevoked, userTopic } from "../realtime/bus.js";
import { poolChanged, poolPeopleChanged } from "./events.js";
import * as service from "./service.js";
import type { PoolRouteContext } from "./routeContext.js";

/**
 * A public pool is already readable by every teacher: a `reader` seat would
 * add nothing and could later be mistaken for a restriction (ADR-013,
 * amendment of 2026-10-10). Existing reader rows stay; no new one is made.
 */
function refuseReaderOnPublic(isPublic: boolean, role: string): void {
  if (isPublic && role === "reader") {
    throw new DomainError("role_covered_by_public", 409, "A public pool is already readable by every teacher");
  }
}

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
    teacher({ params: IdParam, load: inPool() }, async ({ req, scope: pool }) =>
      service.listMembers(app.db, pool, (await poolRoleOf(app.db, pool, callerOf(req))) === "owner"),
    ),
  );

  /**
   * The subscribers of a public pool, by name only (ADR-095). Its owner and
   * its members see them, nobody else: a reader through a course or a
   * subscription is a 403, since the pool is plainly visible to them.
   */
  app.get(
    "/app/api/pools/:id/subscribers",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, reply, scope: pool }) => {
      const me = callerOf(req);
      if (me.reach !== "all" && !(await service.isMemberOrOwner(app.db, pool, me.id))) {
        return reply.code(403).send({ error: "forbidden", message: "Only the owner and the members see the subscribers" });
      }
      return service.listSubscribers(app.db, pool.id);
    }),
  );

  /**
   * Subscribes the caller to a public pool: it joins their "My pools", and
   * nothing else changes (ADR-095). Idempotent. A pool that is not public
   * cannot be subscribed to, and its owner and members already have it.
   */
  app.put(
    "/app/api/pools/:id/subscription",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, reply, scope: pool }) => {
      const me = req.user!.id;
      if (!pool.isPublic) throw new DomainError("pool_not_public", 409, "Only a public pool can be subscribed to");
      if (await service.isMemberOrOwner(app.db, pool, me)) {
        throw new DomainError("already_member", 409, "This account already holds a seat");
      }
      if (await service.subscribe(app.db, pool.id, me)) {
        await trace(req, "pool.subscribe", "pool", pool.id, {});
        poolChanged(pool.id);
      }
      poolPeopleChanged([userTopic(me)]);
      return reply.code(204).send();
    }),
  );

  app.delete(
    "/app/api/pools/:id/subscription",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, reply, scope: pool }) => {
      const me = req.user!.id;
      if (await service.unsubscribe(app.db, pool.id, me)) {
        await trace(req, "pool.unsubscribe", "pool", pool.id, {});
        poolChanged(pool.id);
      }
      // Their streams were subscribed to the pool's topic when they opened: close them.
      accessRevoked([me]);
      return reply.code(204).send();
    }),
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
      { params: IdParam, query: TeacherCandidateQuery, load: inPool("owner") },
      async ({ query, scope: pool }) => {
        return service.listCandidates(app.db, pool, query.q);
      },
    ),
  );

  /**
   * Names a colleague in the pool: an account picked among the candidates,
   * or an address — matched over the whole identity set of an account
   * (GH-11) for a teacher the picker does not list under that spelling. The
   * visibility is derived from the roster, not written here.
   */
  app.post(
    "/app/api/pools/:id/members",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PoolMemberInvite, load: inPool("owner") },
      async ({ req, reply, body, scope: pool }) => {
        const invitee =
          body.userId !== undefined
            ? await findTeacherById(app.db, body.userId)
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
        refuseReaderOnPublic(pool.isPublic, body.role);
        await service.addMember(app.db, pool, invitee.id, body.role);
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
        return reply.code(201).send(await service.listMembers(app.db, pool, true));
      },
    ),
  );

  /** Changes what a member may do. The `pools.owner_id` account is not here. */
  app.patch(
    "/app/api/pools/:id/members/:userId",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, path: PoolMemberParam, body: PoolMemberPatch, load: inPool("owner") },
      async ({ req, reply, path, body, scope: pool }) => {
        if (path.userId === pool.ownerId) {
          return reply.code(409).send({
            error: "is_owner",
            message: "The owner of the pool holds their seat by ownership",
          });
        }
        refuseReaderOnPublic(pool.isPublic, body.role);
        const audience = await topicsOf(pool);
        const done = await service.setMemberRole(app.db, pool.id, path.userId, body.role);
        if (!done) return reply.code(404).send({ error: "not_found" });
        await trace(req, "pool.member_update", "pool", pool.id, { userId: path.userId, role: body.role });
        poolChanged(pool.id);
        poolPeopleChanged(audience);
        return service.listMembers(app.db, pool, true);
      },
    ),
  );

  /**
   * Removes a seat. An owner removes anyone but the `pools.owner_id` account
   * — that one goes away by a TRANSFER, never by a delete — and a member may
   * remove THEMSELVES, which is how one leaves a pool one was named in.
   */
  app.delete(
    "/app/api/pools/:id/members/:userId",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, path: PoolMemberParam, load: inPool() }, async ({ req, reply, path, scope: pool }) => {
      const leaving = path.userId === req.user!.id;
      if (!leaving && !(await requirePoolRole(app, req, reply, pool, "owner"))) return reply;
      if (path.userId === pool.ownerId) {
        return reply.code(409).send({
          error: "is_owner",
          message: "The owner of a pool cannot be removed from it",
        });
      }
      const audience = await topicsOf(pool);
      const done = await service.removeMember(app.db, pool.id, path.userId);
      if (!done) return reply.code(404).send({ error: "not_found" });
      await trace(req, "pool.unshare", "pool", pool.id, { userId: path.userId, left: leaving });
      poolChanged(pool.id);
      poolPeopleChanged(audience);
      return reply.code(204).send();
    }),
  );
}
