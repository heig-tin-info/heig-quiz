/** The people of a pool (F-POOL-05): members, candidates, audience, succession. */
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import type { PoolCandidates, PoolMember, PoolMembers, PoolRole } from "@quiz/contracts";
import { displayName } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { poolMembers, pools, userEmails, users } from "../../db/schema.js";
import { audit } from "../../audit.js";
import { notify } from "../notifications/service.js";
import { accessRevoked, userTopic } from "../realtime/bus.js";
import { poolPeopleChanged } from "./events.js";
import { type PoolRow, qualified } from "./shared.js";

/**
 * The people of a pool: the `pools.owner_id` account FIRST, then the members
 * in the order they were added — which is the succession order the day the
 * owner loses the teacher role (`transferOnLoss`).
 */
export async function listMembers(db: Db, pool: PoolRow): Promise<PoolMembers> {
  const [[owner], rows] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        givenName: users.givenName,
        familyName: users.familyName,
      })
      .from(users)
      .where(eq(users.id, pool.ownerId))
      .limit(1),
    db
      .select({
        id: users.id,
        email: users.email,
        givenName: users.givenName,
        familyName: users.familyName,
        role: poolMembers.role,
        addedAt: poolMembers.createdAt,
      })
      .from(poolMembers)
      .innerJoin(users, eq(users.id, poolMembers.userId))
      .where(eq(poolMembers.poolId, pool.id))
      .orderBy(asc(poolMembers.createdAt), asc(users.email)),
  ]);
  const members: PoolMember[] = [];
  if (owner) {
    members.push({
      userId: owner.id,
      email: owner.email,
      givenName: owner.givenName,
      familyName: owner.familyName,
      role: "owner",
      isOwner: true,
      // The owner has held the pool since it existed; nothing else would be
      // true, and the web app sorts on this field.
      addedAt: pool.createdAt.toISOString(),
    });
  }
  for (const row of rows) {
    members.push({
      userId: row.id,
      email: row.email,
      givenName: row.givenName,
      familyName: row.familyName,
      role: row.role,
      isOwner: false,
      addedAt: row.addedAt.toISOString(),
    });
  }
  return { visibility: pool.visibility, members };
}

/**
 * The account an invitation names, found by e-mail over the whole identity
 * set (`user_emails`, GH-11) and not only the login address, then narrowed to
 * the accounts that may hold a pool seat: a teacher or an admin.
 *
 * A student address answers `teacher_not_found` like an unknown one: a pool
 * is never shared with a student, and the difference is not the inviter's
 * business.
 */
export async function findTeacherByEmail(db: Db, email: string) {
  const normalized = email.trim().toLowerCase();
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      givenName: users.givenName,
      familyName: users.familyName,
      role: users.role,
    })
    .from(users)
    .where(
      and(
        or(
          sql`lower(${users.email}) = ${normalized}`,
          sql`EXISTS (SELECT 1 FROM ${userEmails} WHERE ${qualified(userEmails.userId)} = ${qualified(users.id)} AND ${qualified(userEmails.email)} = ${normalized} AND ${qualified(userEmails.verified)})`,
        ),
        inArray(users.role, ["teacher", "admin"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The account behind a pick of the invite list — a teacher or an admin, or nobody. */
export async function findTeacherById(db: Db, userId: string) {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      givenName: users.givenName,
      familyName: users.familyName,
      role: users.role,
    })
    .from(users)
    .where(and(eq(users.id, userId), inArray(users.role, ["teacher", "admin"])))
    .limit(1);
  return row ?? null;
}

/**
 * The teachers who hold no seat on the pool yet, matched on name or address:
 * what the picker of the share sheet offers. Ten rows at most — the picker
 * is searched, not browsed — and none when the school is fully seated.
 */
export async function listCandidates(db: Db, pool: PoolRow, q: string): Promise<PoolCandidates> {
  // `\` is the default LIKE escape in PostgreSQL: a typed `%` or `_` is a
  // character to find, not a wildcard.
  const needle = `%${q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      givenName: users.givenName,
      familyName: users.familyName,
    })
    .from(users)
    .where(
      and(
        inArray(users.role, ["teacher", "admin"]),
        sql`${users.id} <> ${pool.ownerId}`,
        sql`NOT EXISTS (SELECT 1 FROM ${poolMembers} WHERE ${qualified(poolMembers.poolId)} = ${pool.id} AND ${qualified(poolMembers.userId)} = ${qualified(users.id)})`,
        sql`lower(${users.givenName} || ' ' || ${users.familyName} || ' ' || ${users.email}) LIKE ${needle}`,
      ),
    )
    .orderBy(asc(users.familyName), asc(users.givenName), asc(users.email))
    .limit(10);
  return rows;
}

/** Already a member, or the owner: the invitation is a 409, not a second row. */
export async function isMemberOrOwner(db: Db, pool: PoolRow, userId: string): Promise<boolean> {
  if (pool.ownerId === userId) return true;
  const [row] = await db
    .select({ userId: poolMembers.userId })
    .from(poolMembers)
    .where(and(eq(poolMembers.poolId, pool.id), eq(poolMembers.userId, userId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Names one account in the pool. A `private` pool becomes `shared` on the
 * first invitation — the visibility is a consequence of the members, never a
 * second thing to remember (F-POOL-05).
 */
export async function addMember(
  db: Db,
  pool: PoolRow,
  userId: string,
  role: PoolRole,
): Promise<{ addedAt: Date; visibility: PoolRow["visibility"] }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(poolMembers)
      .values({ poolId: pool.id, userId, role })
      .returning();
    const visibility = pool.visibility === "private" ? "shared" : pool.visibility;
    await tx
      .update(pools)
      .set({ visibility, updatedAt: new Date() })
      .where(eq(pools.id, pool.id));
    return { addedAt: row!.createdAt, visibility };
  });
}

export async function setMemberRole(
  db: Db,
  poolId: string,
  userId: string,
  role: PoolRole,
): Promise<boolean> {
  const updated = await db
    .update(poolMembers)
    .set({ role })
    .where(and(eq(poolMembers.poolId, poolId), eq(poolMembers.userId, userId)))
    .returning({ userId: poolMembers.userId });
  return updated.length > 0;
}

export async function removeMember(db: Db, poolId: string, userId: string): Promise<boolean> {
  const removed = await db
    .delete(poolMembers)
    .where(and(eq(poolMembers.poolId, poolId), eq(poolMembers.userId, userId)))
    .returning({ userId: poolMembers.userId });
  // The seat may have been their only way to the pool: close their streams (#248).
  accessRevoked(removed.map((r) => r.userId));
  return removed.length > 0;
}

/**
 * The topics a change of the pool's people must reach: the owner and every
 * member, on their OWN topic.
 *
 * `pool:<id>` is not enough here — a connection subscribes to the pools it
 * could reach WHEN IT OPENED, so the colleague who has just been named is
 * precisely the one not listening to it yet.
 */
export async function poolAudience(db: Db, pool: PoolRow): Promise<string[]> {
  const rows = await db
    .select({ userId: poolMembers.userId })
    .from(poolMembers)
    .where(eq(poolMembers.poolId, pool.id));
  return [...new Set([pool.ownerId, ...rows.map((r) => r.userId)])];
}

/**
 * Succession (F-POOL-05): the pools owned by an account that has just lost
 * the teacher role pass to their FIRST member, then the next, and so on.
 *
 * "Removed from the system" is never a deletion here — an account is kept for
 * its audit trail and its past attempts. What happens is that the role is
 * recomputed to something that is not `teacher`/`admin`, which is why this is
 * wired into `roles.ts` (see the comment there) rather than into a delete
 * route that does not exist.
 *
 * One transaction per pool, and idempotent: a pool whose owner is anyone else
 * is left alone, and a pool with NO member keeps its owner — it stays
 * readable by the staff of the courses it is linked to, and an admin can
 * still dispose of it. Nothing is ever orphaned to nobody.
 */
export async function transferOnLoss(
  db: Db,
  userId: string,
): Promise<{ poolId: string; toUserId: string }[]> {
  const owned = await db.select().from(pools).where(eq(pools.ownerId, userId));
  if (owned.length === 0) return [];
  const [previous] = await db
    .select({ givenName: users.givenName, familyName: users.familyName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const fromName = previous ? displayName(previous) : "";

  const done: { poolId: string; toUserId: string }[] = [];
  for (const pool of owned) {
    const heir = await db.transaction(async (tx) => {
      // Re-read inside the transaction: two concurrent role recomputations
      // must not hand the same pool to two different people.
      const [current] = await tx
        .select()
        .from(pools)
        .where(and(eq(pools.id, pool.id), eq(pools.ownerId, userId)))
        .limit(1);
      if (!current) return null;
      const [first] = await tx
        .select({ userId: poolMembers.userId })
        .from(poolMembers)
        .where(eq(poolMembers.poolId, pool.id))
        .orderBy(asc(poolMembers.createdAt), asc(poolMembers.userId))
        .limit(1);
      if (!first) return null;
      await tx
        .update(pools)
        .set({ ownerId: first.userId, updatedAt: new Date() })
        .where(eq(pools.id, pool.id));
      // The new owner is the owner by `pools.owner_id`; a member row for them
      // would be a second, weaker claim on the same seat.
      await tx
        .delete(poolMembers)
        .where(and(eq(poolMembers.poolId, pool.id), eq(poolMembers.userId, first.userId)));
      return first.userId;
    });
    if (!heir) continue;
    await audit(db, {
      actorUserId: null,
      actorType: "system",
      action: "pool.transfer",
      subjectType: "pool",
      subjectId: pool.id,
      payload: { from: userId, to: heir, name: pool.name, reason: "owner_lost_teacher_role" },
    });
    await notify(db, heir, {
      kind: "pool_ownership",
      poolId: pool.id,
      poolName: pool.name,
      fromName,
    });
    poolPeopleChanged([userTopic(heir), userTopic(userId)]);
    done.push({ poolId: pool.id, toUserId: heir });
  }
  return done;
}
