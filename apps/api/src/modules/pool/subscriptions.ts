/**
 * Subscriptions to public pools, and what taking a pool out of the catalogue
 * ends (ADR-095): the subscriptions and the `read` links of the pool.
 */
import { and, asc, countDistinct, eq, inArray, isNotNull } from "drizzle-orm";

import type { PoolSubscribers, PoolUnpublishImpact } from "@quiz/contracts";
import { displayName, subscriptionState } from "@quiz/domain";

import { DomainError } from "../http.js";
import type { Db, Tx } from "../../db/client.js";
import {
  coursePools,
  courseStaff,
  courses,
  evaluationItems,
  evaluations,
  poolMembers,
  poolSubscriptions,
  pools,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";
import { notifyUsers } from "../notifications/service.js";
import { accessRevoked } from "../realtime/bus.js";
import type { PoolRow } from "./shared.js";

/**
 * Records the subscription; false when the teacher was subscribed already.
 * The pool is read FOR UPDATE inside the transaction, so a concurrent
 * unpublication either runs first (409 `pool_not_public`) or waits for the
 * row and then drops it: no subscription row can outlive the pool's
 * publication. `subscriptionState` is the one rule of who may subscribe.
 */
export async function subscribe(db: Db, poolId: string, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [pool] = await tx
      .select({ isPublic: pools.isPublic, ownerId: pools.ownerId })
      .from(pools)
      .where(eq(pools.id, poolId))
      .for("update");
    const [seat] = await tx
      .select({ role: poolMembers.role })
      .from(poolMembers)
      .where(and(eq(poolMembers.poolId, poolId), eq(poolMembers.userId, userId)));
    const state = subscriptionState({
      isPublic: pool?.isPublic ?? false,
      isOwner: pool?.ownerId === userId,
      memberRole: seat?.role ?? null,
      subscribed: false,
    });
    if (!pool?.isPublic) throw new DomainError("pool_not_public", 409, "Only a public pool can be subscribed to");
    if (state === "none") throw new DomainError("already_member", 409, "This account already holds a seat");
    const rows = await tx
      .insert(poolSubscriptions)
      .values({ poolId, userId })
      .onConflictDoNothing()
      .returning({ userId: poolSubscriptions.userId });
    return rows.length > 0;
  });
}

/** Ends the subscription; false when there was none. */
export async function unsubscribe(db: Db, poolId: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(poolSubscriptions)
    .where(and(eq(poolSubscriptions.poolId, poolId), eq(poolSubscriptions.userId, userId)))
    .returning({ userId: poolSubscriptions.userId });
  return rows.length > 0;
}

/** The subscribers by display name only, oldest subscription first (ADR-095: no id, no address). */
export async function listSubscribers(db: Db, poolId: string): Promise<PoolSubscribers> {
  const rows = await db
    .select({ givenName: users.givenName, familyName: users.familyName, email: users.email })
    .from(poolSubscriptions)
    .innerJoin(users, eq(users.id, poolSubscriptions.userId))
    .where(eq(poolSubscriptions.poolId, poolId))
    .orderBy(asc(poolSubscriptions.createdAt), asc(users.email));
  return { subscribers: rows.map((r) => ({ name: displayName(r) })) };
}

/** The ids of the pool's subscribers. */
export async function subscriberIds(db: Db, poolId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: poolSubscriptions.userId })
    .from(poolSubscriptions)
    .where(eq(poolSubscriptions.poolId, poolId));
  return rows.map((r) => r.userId);
}

/** The courses linked `read` to the pool, by id and name. */
async function readCourses(db: Db | Tx, poolId: string) {
  return db
    .select({ id: courses.id, name: courses.name })
    .from(coursePools)
    .innerJoin(courses, eq(courses.id, coursePools.courseId))
    .where(and(eq(coursePools.poolId, poolId), eq(coursePools.mode, "read")))
    .orderBy(asc(courses.name));
}

/**
 * What unpublishing the pool would end, counted for the owner's confirmation:
 * the subscribers, the courses linked `read`, and the templates of those
 * courses that use a question of the pool (they report `template_pool_unlinked`
 * when instantiated next year).
 */
export async function unpublishImpact(db: Db, poolId: string): Promise<PoolUnpublishImpact> {
  const [subscribers, linked] = await Promise.all([subscriberIds(db, poolId), readCourses(db, poolId)]);
  let templates = 0;
  if (linked.length > 0) {
    const [row] = await db
      .select({ n: countDistinct(evaluations.id) })
      .from(evaluationItems)
      .innerJoin(questionVersions, eq(questionVersions.id, evaluationItems.questionVersionId))
      .innerJoin(questions, eq(questions.id, questionVersions.questionId))
      .innerJoin(evaluations, eq(evaluations.id, evaluationItems.evaluationId))
      .where(
        and(
          eq(questions.poolId, poolId),
          isNotNull(evaluations.courseId),
          inArray(evaluations.courseId, linked.map((c) => c.id)),
        ),
      );
    templates = row?.n ?? 0;
  }
  return { subscribers: subscribers.length, readCourses: linked.length, templates };
}

/** What leaving the catalogue took away: the read-linked courses and the subscribers. */
export interface DroppedPublicAccess {
  linked: { id: string; name: string }[];
  subscribers: string[];
}

/**
 * The pool leaves the catalogue (the owner has confirmed the count): its
 * `read` links and its subscriptions go. Runs in the SAME transaction as the
 * unpublication (`isPublic = false`), so no row outlives it; `announceRetired`
 * tells the people once that transaction has committed.
 */
export async function dropPublicAccess(tx: Tx, poolId: string): Promise<DroppedPublicAccess> {
  const linked = await readCourses(tx, poolId);
  const subscribers = await tx
    .delete(poolSubscriptions)
    .where(eq(poolSubscriptions.poolId, poolId))
    .returning({ userId: poolSubscriptions.userId });
  await tx.delete(coursePools).where(and(eq(coursePools.poolId, poolId), eq(coursePools.mode, "read")));
  return { linked, subscribers: subscribers.map((s) => s.userId) };
}

/**
 * Once committed: tells each subscriber and the owners of each read-linked
 * course, and closes the streams of everyone who lost the pool, as
 * `removeMember` does. Evaluations keep their pinned versions.
 */
export async function announceRetired(db: Db, pool: Pick<PoolRow, "name">, dropped: DroppedPublicAccess): Promise<void> {
  const staff = dropped.linked.length
    ? await db
        .select({ userId: courseStaff.userId, courseId: courseStaff.courseId, role: courseStaff.role })
        .from(courseStaff)
        .where(inArray(courseStaff.courseId, dropped.linked.map((c) => c.id)))
    : [];
  // A subscriber who also owns a read-linked course hears it once, as a subscriber.
  const subscriberSet = new Set(dropped.subscribers);
  await notifyUsers(db, dropped.subscribers, {
    kind: "pool_unpublished",
    state: "unpublished",
    poolName: pool.name,
    courseName: null,
  });
  for (const course of dropped.linked) {
    await notifyUsers(
      db,
      staff.filter((s) => s.courseId === course.id && s.role === "owner" && !subscriberSet.has(s.userId)).map((s) => s.userId),
      { kind: "pool_unpublished", state: "course", poolName: pool.name, courseName: course.name },
    );
  }
  accessRevoked([...subscriberSet, ...staff.map((s) => s.userId)]);
}

/** Tells the former subscribers of a deleted public pool. */
export async function tellPoolDeleted(db: Db, poolName: string, userIds: readonly string[]): Promise<void> {
  await notifyUsers(db, userIds, { kind: "pool_unpublished", state: "deleted", poolName, courseName: null });
  accessRevoked([...userIds]);
}
