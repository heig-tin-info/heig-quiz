/** The category tree of a pool. */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { CategoryCreate, CategoryOrder, CategoryPatch, IdParam } from "@quiz/contracts";

import { categories } from "../../db/schema.js";
import { poolChanged } from "./events.js";
import * as service from "./service.js";
import type { PoolRouteContext } from "./routeContext.js";

export function categoryRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, trace, teacher, inPool, onCategory } = ctx;

  /**
   * The categories page: the tree with each folder's question count. Any
   * seat reads it — a reader sees the tree, and simply cannot change it.
   */
  app.get(
    "/app/api/pools/:id/categories",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ scope: pool }) =>
      service.categoriesWithCounts(app.db, pool.id),
    ),
  );

  app.post(
    "/app/api/pools/:id/categories",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: CategoryCreate, load: inPool("contributor") },
      async ({ req, reply, body, scope: pool }) => {
        if (body.parentId) {
          const [parent] = await app.db
            .select({ id: categories.id })
            .from(categories)
            .where(and(eq(categories.id, body.parentId), eq(categories.poolId, pool.id)))
            .limit(1);
          if (!parent) return reply.code(404).send({ error: "not_found" });
        }
        const category = await service.createCategory(app.db, pool.id, body);
        await trace(req, "category.create", "category", category.id, {
          poolId: pool.id,
          name: category.name,
        });
        poolChanged(pool.id);
        return reply.code(201).send(category);
      },
    ),
  );

  app.patch(
    "/app/api/categories/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: CategoryPatch, load: onCategory("contributor") },
      async ({ req, reply, body, scope }) => {
        if (body.parentId !== undefined && body.parentId !== null) {
          const [parent] = await app.db
            .select({ poolId: categories.poolId })
            .from(categories)
            .where(eq(categories.id, body.parentId))
            .limit(1);
          if (!parent || parent.poolId !== scope.pool.id) {
            return reply.code(404).send({ error: "not_found" });
          }
          if (await service.wouldCycle(app.db, scope.category.id, body.parentId)) {
            return reply
              .code(409)
              .send({ error: "cycle", message: "A folder cannot be moved inside itself" });
          }
        }
        const updated = await service.updateCategory(app.db, scope.category.id, body);
        await trace(req, "category.update", "category", scope.category.id, body);
        poolChanged(scope.pool.id);
        return updated;
      },
    ),
  );

  app.put(
    "/app/api/pools/:id/categories/order",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: CategoryOrder, load: inPool("contributor") },
      async ({ req, reply, body, scope: pool }) => {
        const refused = await service.checkCategoryLayout(app.db, pool.id, body.items);
        if (refused === "not_found") return reply.code(404).send({ error: "not_found" });
        if (refused === "cycle") {
          return reply
            .code(409)
            .send({ error: "cycle", message: "A folder cannot be moved inside itself" });
        }
        const tree = await service.reorderCategories(app.db, pool.id, body.items);
        await trace(req, "category.reorder", "pool", pool.id, { count: body.items.length });
        poolChanged(pool.id);
        return tree;
      },
    ),
  );

  app.delete(
    "/app/api/categories/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onCategory("contributor") }, async ({ req, reply, scope }) => {
      await service.deleteCategory(app.db, scope.category.id);
      await trace(req, "category.delete", "category", scope.category.id, {
        poolId: scope.pool.id,
        name: scope.category.name,
      });
      poolChanged(scope.pool.id);
      return reply.code(204).send();
    }),
  );
}
