/** The pools themselves: list, create, read, rename, delete. */
import type { FastifyInstance } from "fastify";

import { IdParam, PoolCreate, PoolPatch, type PoolInUse } from "@quiz/contracts";

import {
  accessWhere,
  callerOf,
  managedEvaluationAccess,
  myPools,
  poolRoleOf,
  requirePoolRole,
} from "../guards.js";
import { Budget, BUDGET_RETRY_AFTER_S } from "../../budget.js";
import { DomainError, invalid, rateLimited, readerLang } from "../http.js";
import { publish } from "../../events.js";
import { poolChanged, poolPeopleChanged } from "./events.js";
import * as service from "./service.js";
import { LLM_CALLS_PER_MINUTE, type PoolRouteContext } from "./routeContext.js";

export function poolRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, trace, teacher, inPool, topicsOf } = ctx;

  /**
   * "My pools" (ADR-095): the pools the caller owns, sits on, reaches through
   * a linked course or subscribed to — each with the caller's effective role,
   * so the list can say what it offers (F-POOL-05). A public pool they have
   * no such tie to is not here: the catalogue lists it.
   *
   * Filtered by `myPools` through `accessWhere`: an admin sees their own
   * shelf, and every pool of the instance only with Super Powers on
   * (ADR-054, which removed the `?scope=all` switch of #63). No input, so no
   * schema.
   */
  app.get("/app/api/pools", { preHandler: requireTeacher }, async (req) => {
    const caller = callerOf(req);
    return service.listPools(app.db, accessWhere(caller, myPools(caller.id)), caller);
  });

  app.post("/app/api/pools", { preHandler: requireTeacher }, async (req, reply) => {
    const body = PoolCreate.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const pool = await service.createPool(app.db, { ...body.data, ownerId: req.user!.id });
    await trace(req, "pool.create", "pool", pool.id, {
      name: pool.name,
      isPublic: pool.isPublic,
    });
    if (pool.isPublic) await trace(req, "pool.publish", "pool", pool.id, {});
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
      service.poolDetail(app.db, pool, await poolRoleOf(app.db, pool, callerOf(req)), readerLang(req), callerOf(req)),
    ),
  );

  /** Name, icon and visibility are the owner's business (F-POOL-05). */
  app.patch(
    "/app/api/pools/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PoolPatch, load: inPool("owner") },
      async ({ req, body, scope: pool }) => {
        const { isPublic, descriptionFromAi, ...fields } = body;
        if (isPublic === true && pool.isPersonal) {
          throw new DomainError("personal_pool_not_publishable", 409, "A personal pool cannot be published");
        }
        const source = fields.description === undefined ? {} : { descriptionSource: descriptionFromAi ? ("ai" as const) : ("owner" as const) };
        const updated = await service.updatePool(app.db, pool.id, {
          ...fields,
          ...(isPublic === undefined ? {} : { isPublic }),
          ...source,
        });
        if (isPublic !== undefined && isPublic !== pool.isPublic) {
          await trace(req, isPublic ? "pool.publish" : "pool.unpublish", "pool", pool.id, {});
          // The pool leaves the catalogue: its read-only links and its subscriptions end (ADR-095).
          if (!isPublic) await service.retirePublicAccess(app.db, pool);
        }
        if (Object.keys(fields).length > 0) {
          await trace(req, "pool.update", "pool", pool.id, { ...fields, ...source });
        }
        poolChanged(pool.id);
        // A visibility or a name the members see on their own list too.
        poolPeopleChanged(await topicsOf(pool));
        return updated;
      },
    ),
  );

  /**
   * What unpublishing would end, counted for the owner's confirmation
   * (ADR-095): subscribers, read-linked courses, templates that use the pool.
   */
  app.get(
    "/app/api/pools/:id/unpublish-impact",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool("owner") }, async ({ scope: pool }) =>
      service.unpublishImpact(app.db, pool.id),
    ),
  );

  /**
   * The AI's proposal of a description (owner only). Nothing is written: the
   * owner accepts it with a `PATCH` carrying `descriptionFromAi`.
   */
  const proposals = new Budget();
  app.post(
    "/app/api/pools/:id/description/propose",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool("owner") }, async ({ req, reply, scope: pool }) => {
      // An AI proposal never replaces the owner's own text (ADR-013, amendment of 2026-10-10).
      if (pool.descriptionSource === "owner" && pool.description !== "") {
        throw new DomainError("description_owned", 409, "The owner's own description is kept");
      }
      if (!proposals.spend(`describe:${req.user!.id}`, LLM_CALLS_PER_MINUTE, app.clock.now())) {
        return rateLimited(reply, BUDGET_RETRY_AFTER_S);
      }
      const description = await service.proposeDescription(
        app.db,
        app.llmGateway,
        pool,
        req.user!.id,
        readerLang(req),
      );
      return { description };
    }),
  );

  app.delete(
    "/app/api/pools/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, reply, scope: pool }) => {
      // Only an owner disposes of a pool: a course staff member and a named
      // contributor reach it to WORK in it, not to destroy it.
      const audience = await topicsOf(pool);
      if (!(await requirePoolRole(app, req, reply, pool, "owner"))) return reply;
      const subscribers = await service.subscribersOf(app.db, pool.id);
      // A version an evaluation or a template pins cannot vanish under it
      // (ADR-031): the refusal names what holds the pool, not a 500.
      const inUse = () => service.poolUses(app.db, pool.id, managedEvaluationAccess(callerOf(req)));
      const uses = await inUse();
      if (uses) return reply.code(409).send(uses);
      if (!(await service.deletePool(app.db, pool.id))) {
        // Pinned between the check and the delete: the same refusal.
        const late: PoolInUse = (await inUse()) ?? { error: "pool_in_use", uses: [], hidden: 0 };
        return reply.code(409).send(late);
      }
      await trace(req, "pool.delete", "pool", pool.id, { name: pool.name });
      // The subscribers lose their pool (the read-only links cascade with it): told once it is gone.
      await service.tellPoolDeleted(app.db, pool.name, subscribers);
      poolChanged(pool.id);
      poolPeopleChanged(audience);
      return reply.code(204).send();
    }),
  );
}
