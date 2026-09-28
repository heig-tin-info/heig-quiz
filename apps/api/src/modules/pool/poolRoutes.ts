/** The pools themselves: list, create, read, rename, delete. */
import type { FastifyInstance } from "fastify";

import { IdParam, PoolCreate, PoolListQuery, PoolPatch, type PoolInUse } from "@quiz/contracts";

import { pools } from "../../db/schema.js";
import { managedEvaluationAccess, poolAccess, poolRoleOf, requirePoolRole } from "../guards.js";
import { invalid } from "../http.js";
import { publish } from "../../events.js";
import { poolChanged, poolPeopleChanged } from "./events.js";
import * as service from "./service.js";
import type { PoolRouteContext } from "./routeContext.js";

export function poolRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, trace, teacher, inPool, topicsOf } = ctx;

  /**
   * Every pool the caller reaches: their own, the ones they were named in,
   * the public ones and the ones their courses draw from — each with the
   * caller's effective role, so the list can say what it offers (F-POOL-05).
   */
  /**
   * The pools list is filtered by `poolAccess` for EVERYONE, admins included:
   * an admin who sees every teacher's private pools on their shelf cannot
   * tell theirs from the others'. `?scope=all` lifts the filter, for an admin
   * only; a teacher asking for it gets their own list.
   */
  app.get("/app/api/pools", { preHandler: requireTeacher }, async (req, reply) => {
    const query = PoolListQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    const everyone = query.data.scope === "all" && req.user!.role === "admin";
    return service.listPools(app.db, everyone ? undefined : poolAccess(req.user!.id), req.user!);
  });

  app.post("/app/api/pools", { preHandler: requireTeacher }, async (req, reply) => {
    const body = PoolCreate.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const pool = await service.createPool(app.db, { ...body.data, ownerId: req.user!.id });
    await trace(req, "pool.create", "pool", pool.id, {
      name: pool.name,
      visibility: pool.visibility,
    });
    // A brand-new pool has no `pool:<id>` subscriber yet — topics are computed
    // at connection time — so the teacher's own topic is the only one that can
    // carry it. It refreshes `GET /app/api/pools`, which emits nothing back.
    publish("mutation", [`user:${req.user!.id}`]);
    return reply.code(201).send(pool);
  });

  app.get(
    "/app/api/pools/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, scope: pool }) =>
      service.poolDetail(app.db, pool, await poolRoleOf(app.db, pool, req.user!)),
    ),
  );

  /** Name, icon and visibility are the owner's business (F-POOL-05). */
  app.patch(
    "/app/api/pools/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PoolPatch, load: inPool("owner") },
      async ({ req, body, scope: pool }) => {
        const updated = await service.updatePool(app.db, pool.id, body);
        await trace(req, "pool.update", "pool", pool.id, body);
        poolChanged(pool.id);
        // A visibility or a name the members see on their own list too.
        poolPeopleChanged(await topicsOf(pool));
        return updated;
      },
    ),
  );

  app.delete(
    "/app/api/pools/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, reply, scope: pool }) => {
      // Only an owner disposes of a pool: a course staff member and a named
      // contributor reach it to WORK in it, not to destroy it.
      const audience = await topicsOf(pool);
      if (!(await requirePoolRole(app, req, reply, pool, "owner"))) return reply;
      // A version an evaluation or a template pins cannot vanish under it
      // (ADR-031): the refusal names what holds the pool, not a 500.
      const inUse = () => service.poolUses(app.db, pool.id, managedEvaluationAccess(req.user!));
      const uses = await inUse();
      if (uses) return reply.code(409).send(uses);
      if (!(await service.deletePool(app.db, pool.id))) {
        // Pinned between the check and the delete: the same refusal.
        const late: PoolInUse = (await inUse()) ?? { error: "pool_in_use", uses: [], hidden: 0 };
        return reply.code(409).send(late);
      }
      await trace(req, "pool.delete", "pool", pool.id, { name: pool.name });
      poolChanged(pool.id);
      poolPeopleChanged(audience);
      return reply.code(204).send();
    }),
  );
}
