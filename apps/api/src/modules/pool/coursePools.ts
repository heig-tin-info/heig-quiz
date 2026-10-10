/** `course_pools`: written here, called by the `org` module. */
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";

import type { PoolRole } from "@quiz/contracts";
import { poolRoleAllows } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { DomainError } from "../http.js";
import { coursePools, courseStaff, pools } from "../../db/schema.js";
import { accessRevoked } from "../realtime/bus.js";
import { derivedVisibility, questionCount, poolJson, poolRolesOf } from "./pools.js";
import type { Caller } from "../guards.js";

export async function poolsOfCourse(db: Db, courseId: string) {
  const rows = await db
    .select({ pool: pools, visibility: derivedVisibility, questionCount })
    .from(coursePools)
    .innerJoin(pools, eq(coursePools.poolId, pools.id))
    .where(eq(coursePools.courseId, courseId))
    .orderBy(asc(pools.name));
  return rows.map((r) => ({ ...poolJson(r.pool, r.visibility), questionCount: r.questionCount }));
}

/**
 * The caller may newly link a pool where they hold `role`: linking makes the
 * whole course staff contributors of it, so it takes at least that (ADR-013).
 */
export const mayLinkPool = (role: PoolRole) => poolRoleAllows(role, "contributor");

/**
 * Replaces the whole set of pools a course draws from. Only pools the caller
 * can already see may be linked, hence `allowed`; a pool NEWLY linked also
 * needs the caller's effective role to be at least `contributor`, because the
 * link makes the whole staff contributors of it. A pool already linked stays
 * when the list keeps it, and unlinking needs nothing more than the course.
 * An unlink closes the course staff's open streams once committed (#259):
 * their `pool:` topics were computed at connection, and the reconnection
 * keeps the pool only for whoever still reaches it another way.
 */
export async function setCoursePools(
  db: Db,
  courseId: string,
  poolIds: readonly string[],
  allowed: SQL | undefined,
  viewer: Caller,
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
  const unlinked = [...current].some((id) => !reachable.includes(id));
  // The links as they stand: nothing to write, nobody to notify.
  if (added.length === 0 && !unlinked) return poolsOfCourse(db, courseId);
  if (added.length) {
    const roles = await poolRolesOf(db, inArray(pools.id, added), viewer);
    const refused = [...roles].filter(([, role]) => !mayLinkPool(role)).map(([id]) => id);
    if (refused.length) {
      const named = await db
        .select({ id: pools.id, name: pools.name })
        .from(pools)
        .where(inArray(pools.id, refused))
        .orderBy(asc(pools.name));
      // A course would newly draw from a pool the caller only reads (ADR-013):
      // the link would hand the whole course staff `contributor` on it, a
      // write access the caller does not hold. The caller sees these pools,
      // so naming them leaks nothing.
      throw new DomainError("pool_link_forbidden", 403, `Linking the pool "${named[0]!.name}" needs contributor access to it`, {
        poolIds: named.map((p) => p.id),
      });
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(coursePools).where(eq(coursePools.courseId, courseId));
    if (reachable.length) {
      await tx
        .insert(coursePools)
        .values(reachable.map((poolId) => ({ courseId, poolId })));
    }
  });
  if (unlinked) {
    const staff = await db
      .select({ userId: courseStaff.userId })
      .from(courseStaff)
      .where(eq(courseStaff.courseId, courseId));
    accessRevoked(staff.map((s) => s.userId));
  }
  return poolsOfCourse(db, courseId);
}
