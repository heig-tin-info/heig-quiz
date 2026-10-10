/** `course_pools`: written here, called by the `org` module. */
import { and, asc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";

import type { CoursePoolsPut } from "@quiz/contracts";
import { linkModeFor, strongerLinkMode, type CoursePoolMode } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { DomainError } from "../http.js";
import { coursePools, courseStaff, pools } from "../../db/schema.js";
import { accessRevoked } from "../realtime/bus.js";
import { derivedVisibility, questionCount, poolJson, poolRolesOf } from "./pools.js";
import type { Caller } from "../guards.js";

export async function poolsOfCourse(db: Db, courseId: string) {
  const rows = await db
    .select({ pool: pools, visibility: derivedVisibility, questionCount, mode: coursePools.mode })
    .from(coursePools)
    .innerJoin(pools, eq(coursePools.poolId, pools.id))
    .where(eq(coursePools.courseId, courseId))
    .orderBy(asc(pools.name));
  return rows.map((r) => ({ ...poolJson(r.pool, r.visibility), questionCount: r.questionCount, mode: r.mode }));
}

/**
 * Replaces the whole set of pools a course draws from. Only pools the caller
 * can already see may be linked, hence `allowed`.
 *
 * Modes (ADR-095): a link already there KEEPS its mode unless the body asks
 * for a stronger one, and a pool named twice takes the stronger. A NEW `edit`
 * link, and the upgrade of a `read` one, need the caller's effective role to
 * be at least `contributor` (`linkModeFor`), because the link makes the whole
 * staff contributors of it; a NEW `read` link needs only that the pool be
 * public (a read link to a private pool would stand for nothing and could not
 * be kept: unpublishing drops them). Unlinking needs nothing more than the
 * course. An unlink closes the course staff's open streams once committed
 * (#259): their `pool:` topics were computed at connection, and the
 * reconnection keeps the pool only for whoever still reaches it another way.
 */
export async function setCoursePools(
  db: Db,
  courseId: string,
  links: CoursePoolsPut["pools"],
  allowed: SQL | undefined,
  viewer: Caller,
) {
  const asked = new Map<string, CoursePoolMode>();
  for (const { poolId, mode } of links) asked.set(poolId, strongerLinkMode(asked.get(poolId) ?? mode, mode));
  const reachable = asked.size
    ? await db
        .select({ id: pools.id, isPublic: pools.isPublic })
        .from(pools)
        .where(and(inArray(pools.id, [...asked.keys()]), allowed))
    : [];
  const current = new Map(
    (
      await db
        .select({ poolId: coursePools.poolId, mode: coursePools.mode })
        .from(coursePools)
        .where(eq(coursePools.courseId, courseId))
    ).map((r) => [r.poolId, r.mode] as const),
  );
  const wanted = new Map<string, CoursePoolMode>(
    reachable.map((p) => {
      const mode = asked.get(p.id)!;
      const held = current.get(p.id);
      return [p.id, held ? strongerLinkMode(held, mode) : mode] as const;
    }),
  );
  const changed = [...wanted].filter(([id, mode]) => current.get(id) !== mode);
  const unlinked = [...current.keys()].some((id) => !wanted.has(id));
  // The links as they stand: nothing to write, nobody to notify.
  if (changed.length === 0 && !unlinked) return poolsOfCourse(db, courseId);

  const readOnPrivate = changed.filter(([id, mode]) => mode === "read" && !reachable.find((p) => p.id === id)!.isPublic);
  if (readOnPrivate.length) {
    throw new DomainError("pool_not_public", 409, "Only a public pool can be linked read-only", {
      poolIds: readOnPrivate.map(([id]) => id),
    });
  }
  const strengthened = changed.filter(([, mode]) => mode === "edit").map(([id]) => id);
  if (strengthened.length) {
    const roles = await poolRolesOf(db, inArray(pools.id, strengthened), viewer);
    const refused = [...roles].filter(([, { role, isPublic }]) => linkModeFor(role, isPublic) !== "edit").map(([id]) => id);
    if (refused.length) {
      const named = await db
        .select({ id: pools.id, name: pools.name })
        .from(pools)
        .where(inArray(pools.id, refused))
        .orderBy(asc(pools.name));
      // A course would newly edit a pool the caller only reads (ADR-013):
      // the link would hand the whole course staff `contributor` on it, a
      // write access the caller does not hold. The caller sees these pools,
      // so naming them leaks nothing.
      throw new DomainError("pool_link_forbidden", 403, `Linking the pool "${named[0]!.name}" needs contributor access to it`, {
        poolIds: named.map((p) => p.id),
      });
    }
  }
  await db.transaction(async (tx) => {
    // A read link is only ever written to a pool that is public NOW: the rows are locked, so an
    // unpublication that commits first is seen here, and one that comes after drops the link.
    const reads = [...wanted].filter(([id, mode]) => mode === "read" && current.get(id) !== "read").map(([id]) => id);
    if (reads.length) {
      const stillPublic = await tx
        .select({ id: pools.id })
        .from(pools)
        .where(and(inArray(pools.id, reads), eq(pools.isPublic, true)))
        .for("update");
      if (stillPublic.length !== reads.length) {
        throw new DomainError("pool_not_public", 409, "Only a public pool can be linked read-only", { poolIds: reads });
      }
    }
    const keep = [...wanted.keys()];
    await tx
      .delete(coursePools)
      .where(and(eq(coursePools.courseId, courseId), keep.length ? notInArray(coursePools.poolId, keep) : undefined));
    if (wanted.size) {
      await tx
        .insert(coursePools)
        .values([...wanted].map(([poolId, mode]) => ({ courseId, poolId, mode })))
        .onConflictDoUpdate({ target: [coursePools.courseId, coursePools.poolId], set: { mode: sql`excluded.mode` } });
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
