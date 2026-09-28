/** Pools: listing, creating, the personal pool, updating, uses, deleting, detail. */
import { randomUUID } from "node:crypto";

import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import type { Pool, PoolInUse, PoolRole, PoolSummary } from "@quiz/contracts";
import { displayName, effectivePoolRole } from "@quiz/domain";

import { isForeignKeyViolation, type Db } from "../../db/client.js";
import {
  classrooms,
  coursePools,
  courseStaff,
  evaluationItems,
  evaluations,
  poolMembers,
  pools,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";
import { type PoolRow, qualified } from "./shared.js";
import { poolTagNames } from "./tags.js";
import { categoryTree } from "./categories.js";

export const questionCount = sql<number>`(SELECT count(*) FROM ${questions} WHERE ${qualified(questions.poolId)} = ${qualified(pools.id)} AND ${qualified(questions.deletedAt)} IS NULL)::int`;

export function poolJson(pool: PoolRow): Pool {
  return {
    id: pool.id,
    name: pool.name,
    icon: pool.icon,
    visibility: pool.visibility,
    ownerId: pool.ownerId,
    isPersonal: pool.isPersonal,
    createdAt: pool.createdAt.toISOString(),
    updatedAt: pool.updatedAt.toISOString(),
  };
}

/** The facts `effectivePoolRole` needs, gathered per row rather than per pool. */
const memberCountOf = sql<number>`(SELECT count(*) FROM ${poolMembers} WHERE ${qualified(poolMembers.poolId)} = ${qualified(pools.id)})::int`;

function memberRoleOf(userId: string): SQL<PoolRole | null> {
  return sql<PoolRole | null>`(SELECT ${qualified(poolMembers.role)} FROM ${poolMembers} WHERE ${qualified(poolMembers.poolId)} = ${qualified(pools.id)} AND ${qualified(poolMembers.userId)} = ${userId})`;
}

function courseStaffOf(userId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${coursePools} JOIN ${courseStaff} ON ${qualified(courseStaff.courseId)} = ${qualified(coursePools.courseId)} WHERE ${qualified(coursePools.poolId)} = ${qualified(pools.id)} AND ${qualified(courseStaff.userId)} = ${userId})`;
}

/**
 * Every pool the predicate lets the caller see (their own, the ones they were
 * named in, the public ones and the ones their courses draw from), with the
 * caller's EFFECTIVE role on each — the list screen needs it to know which
 * cards open on a read-only pool.
 *
 * The role is resolved by the same pure rule as `guards.poolRoleOf`; only the
 * loading differs, and it is done in one statement rather than one per pool.
 */
export async function listPools(
  db: Db,
  where: SQL | undefined,
  viewer: { id: string; role: string },
): Promise<PoolSummary[]> {
  const rows = await db
    .select({
      pool: pools,
      questionCount,
      memberCount: memberCountOf,
      memberRole: memberRoleOf(viewer.id),
      isCourseStaff: courseStaffOf(viewer.id),
      ownerGivenName: users.givenName,
      ownerFamilyName: users.familyName,
      ownerEmail: users.email,
    })
    .from(pools)
    .leftJoin(users, eq(users.id, pools.ownerId))
    .where(where)
    .orderBy(asc(pools.name));
  return rows.map((r) => ({
    ...poolJson(r.pool),
    questionCount: r.questionCount,
    memberCount: r.memberCount,
    role: effectivePoolRole({
      isAdmin: viewer.role === "admin",
      isOwner: r.pool.ownerId === viewer.id,
      memberRole: r.memberRole,
      isCourseStaff: r.isCourseStaff,
      isPublic: r.pool.visibility === "public",
    }),
    ownerName: displayName({
      givenName: r.ownerGivenName,
      familyName: r.ownerFamilyName,
      email: r.ownerEmail ?? "",
    }),
  }));
}

export async function createPool(
  db: Db,
  input: {
    name: string;
    visibility: "private" | "shared" | "public";
    ownerId: string;
    icon?: string | null | undefined;
  },
) {
  const [row] = await db
    .insert(pools)
    .values({
      id: randomUUID(),
      name: input.name,
      icon: input.icon ?? null,
      visibility: input.visibility,
      ownerId: input.ownerId,
    })
    .returning();
  return poolJson(row!);
}

/** The name the personal pool is born with; the teacher may rename it. */
export const PERSONAL_POOL_NAME = "Polls";

/**
 * The teacher's own pool (F-POOL-01), created on FIRST use and not at
 * sign-up: `pools_personal_uq` — unique on `owner_id WHERE is_personal` — is
 * what makes two simultaneous first polls resolve to one pool.
 *
 * It is an ordinary pool in every other respect: it shows on the pools page,
 * it can be renamed, shared and drawn from. Today the live poll launcher is
 * its only creator (ADR-014), which is why it is named after what it holds.
 */
export async function ensurePersonalPool(db: Db, userId: string): Promise<PoolRow> {
  const existing = await personalPool(db, userId);
  if (existing) return existing;
  await db
    .insert(pools)
    .values({
      id: randomUUID(),
      name: PERSONAL_POOL_NAME,
      icon: "message-circle-question",
      visibility: "private",
      ownerId: userId,
      isPersonal: true,
    })
    // The loser of a race reads the winner's row below.
    .onConflictDoNothing();
  const row = await personalPool(db, userId);
  if (!row) throw new Error("personal pool vanished after insert");
  return row;
}

async function personalPool(db: Db, userId: string): Promise<PoolRow | null> {
  const [row] = await db
    .select()
    .from(pools)
    .where(and(eq(pools.ownerId, userId), eq(pools.isPersonal, true)))
    .limit(1);
  return row ?? null;
}

export async function updatePool(
  db: Db,
  poolId: string,
  patch: {
    name?: string | undefined;
    icon?: string | null | undefined;
    visibility?: "private" | "shared" | "public" | undefined;
  },
) {
  const [row] = await db
    .update(pools)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pools.id, poolId))
    .returning();
  return poolJson(row!);
}

/**
 * The evaluations, templates and polls that pin a version of this pool's
 * questions (ADR-031, F-POOL-09): while there is one, the pool is not
 * deleted — `evaluation_items.question_version_id` has no cascade, on
 * purpose (F-EVAL-03). `managed` is the caller's access predicate on
 * `evaluations` (`managedEvaluationAccess` in `guards.ts`, undefined for an
 * admin): the holders it lets in are named, the others only counted. Read
 * by join: `evaluations` is the evaluation module's table.
 */
export async function poolUses(
  db: Db,
  poolId: string,
  managed: SQL | undefined,
): Promise<PoolInUse | null> {
  const rows = await db
    .selectDistinct({
      id: evaluations.id,
      title: evaluations.title,
      template: sql<boolean>`${evaluations.courseId} is not null`,
      reachable: sql<boolean>`${managed ?? sql`true`}`,
    })
    .from(evaluationItems)
    .innerJoin(questionVersions, eq(questionVersions.id, evaluationItems.questionVersionId))
    .innerJoin(questions, eq(questions.id, questionVersions.questionId))
    .innerJoin(evaluations, eq(evaluations.id, evaluationItems.evaluationId))
    .leftJoin(classrooms, eq(classrooms.id, evaluations.classroomId))
    .where(eq(questions.poolId, poolId))
    .orderBy(evaluations.title);
  if (rows.length === 0) return null;
  const uses = rows.filter((r) => r.reachable);
  return {
    error: "pool_in_use",
    uses: uses.map(({ id, title, template }) => ({ id, title, template })),
    hidden: rows.length - uses.length,
  };
}

/**
 * The pool. The bells that point at it go with it: `notifications.pool_id`
 * cascades, so no reader is walked to a 404. The caller has checked
 * {@link poolUses} first; false when an evaluation pinned one of its
 * versions in between — the foreign key, not a 500, says so.
 */
export async function deletePool(db: Db, poolId: string): Promise<boolean> {
  try {
    await db.delete(pools).where(eq(pools.id, poolId));
    return true;
  } catch (err) {
    if (isForeignKeyViolation(err, "evaluation_items_question_version_id_question_versions_id_fk")) {
      return false;
    }
    throw err;
  }
}
/**
 * `GET /pools/:id`: the pool, its category tree, the tags in use — and the
 * caller's effective role, which is what the screen reads to decide whether
 * it offers an editor or a reading view.
 */
export async function poolDetail(db: Db, pool: PoolRow, role: PoolRole) {
  const [tree, tags, [counted]] = await Promise.all([
    categoryTree(db, pool.id),
    poolTagNames(db, pool.id),
    db.select({ n: questionCount }).from(pools).where(eq(pools.id, pool.id)),
  ]);
  return {
    pool: poolJson(pool),
    role,
    categories: tree,
    tags,
    questionCount: counted?.n ?? 0,
  };
}
