/** `course_pools`: written here, called by the `org` module. */
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";

import { poolRoleAllows } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { DomainError } from "../http.js";
import { coursePools, pools } from "../../db/schema.js";
import { questionCount, poolJson, listPools } from "./pools.js";

export async function poolsOfCourse(db: Db, courseId: string) {
  const rows = await db
    .select({ pool: pools, questionCount })
    .from(coursePools)
    .innerJoin(pools, eq(coursePools.poolId, pools.id))
    .where(eq(coursePools.courseId, courseId))
    .orderBy(asc(pools.name));
  return rows.map((r) => ({ ...poolJson(r.pool), questionCount: r.questionCount }));
}

/**
 * A course would newly draw from a pool the caller only reads (ADR-013): the
 * link would hand the whole course staff `contributor` on it, a write access
 * the caller does not hold. Answered `403 pool_link_forbidden`.
 */
export class PoolLinkForbidden extends DomainError {
  override name = "PoolLinkForbidden";
  constructor(readonly pools: { id: string; name: string }[]) {
    // The caller sees these pools, so naming them leaks nothing (ADR-013).
    super(
      "pool_link_forbidden",
      403,
      `Linking the pool "${pools[0]!.name}" needs contributor access to it`,
      { poolIds: pools.map((p) => p.id) },
    );
  }
}

/**
 * Replaces the whole set of pools a course draws from. Only pools the caller
 * can already see may be linked, hence `allowed`; a pool NEWLY linked also
 * needs the caller's effective role to be at least `contributor`, because the
 * link makes the whole staff contributors of it. A pool already linked stays
 * when the list keeps it, and unlinking needs nothing more than the course.
 */
export async function setCoursePools(
  db: Db,
  courseId: string,
  poolIds: readonly string[],
  allowed: SQL | undefined,
  viewer: { id: string; role: string },
) {
  const unique = [...new Set(poolIds)];
  const reachable = unique.length
    ? (
        await db
          .select({ id: pools.id })
          .from(pools)
          .where(and(inArray(pools.id, unique), allowed))
      ).map((r) => r.id)
    : [];
  const current = new Set(
    (
      await db
        .select({ poolId: coursePools.poolId })
        .from(coursePools)
        .where(eq(coursePools.courseId, courseId))
    ).map((r) => r.poolId),
  );
  const added = reachable.filter((id) => !current.has(id));
  if (added.length) {
    const refused = (await listPools(db, inArray(pools.id, added), viewer)).filter(
      (p) => !poolRoleAllows(p.role, "contributor"),
    );
    if (refused.length) throw new PoolLinkForbidden(refused.map(({ id, name }) => ({ id, name })));
  }
  await db.transaction(async (tx) => {
    await tx.delete(coursePools).where(eq(coursePools.courseId, courseId));
    if (reachable.length) {
      await tx
        .insert(coursePools)
        .values(reachable.map((poolId) => ({ courseId, poolId })));
    }
  });
  return poolsOfCourse(db, courseId);
}
