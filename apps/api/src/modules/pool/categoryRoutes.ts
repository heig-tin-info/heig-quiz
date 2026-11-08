/** The category tree of a pool. */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { CategoryCreate, CategoryOrder, CategoryPatch, IdParam } from "@quiz/contracts";

import { categories } from "../../db/schema.js";
import * as service from "./service.js";
import type { PoolRouteContext } from "./routeContext.js";

export function categoryRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, poolWrite, teacher, inPool, onCategory } = ctx;

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
        const category = await poolWrite(req, pool.id, () => service.createCategory(app.db, pool.id, body), (row) => [
          "category.create", "category", row.id, { poolId: pool.id, name: row.name },
        ]);
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
        return poolWrite(req, scope.pool.id, () => service.updateCategory(app.db, scope.category.id, body), () => [
          "category.update", "category", scope.category.id, body,
        ]);
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
        return poolWrite(req, pool.id, () => service.reorderCategories(app.db, pool.id, body.items), () => [
          "category.reorder", "pool", pool.id, { count: body.items.length },
        ]);
      },
    ),
  );

  app.delete(
    "/app/api/categories/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onCategory("contributor") }, async ({ req, reply, scope }) => {
      await poolWrite(req, scope.pool.id, () => service.deleteCategory(app.db, scope.category.id), () => [
        "category.delete", "category", scope.category.id, { poolId: scope.pool.id, name: scope.category.name },
      ]);
      return reply.code(204).send();
    }),
  );
}
