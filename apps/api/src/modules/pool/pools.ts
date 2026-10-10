/** Pools: listing, creating, the personal pool, updating, uses, deleting, detail. */
import { randomUUID } from "node:crypto";

import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import type { ConceptLang, Pool, PoolVisibility, PoolColor, PoolInUse, PoolRole, PoolSummary } from "@quiz/contracts";
import { displayName, effectivePoolRole, heldPoolRole, type PoolDescriptionSource, type PoolRoleFacts } from "@quiz/domain";

import { isForeignKeyViolation, qualified, type Db } from "../../db/client.js";
import type { Caller } from "../guards.js";
import { shownAvatar } from "../avatar.js";
import {
  attempts,
  avatars,
  classrooms,
  coursePools,
  courseStaff,
  evaluationItems,
  evaluations,
  isStaffAttempt,
  poolMembers,
  pools,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";
import { type PoolRow } from "./shared.js";
import { poolConcepts } from "../concept/service.js";
import { categoryTree } from "./categories.js";

export const questionCount = sql<number>`(SELECT count(*) FROM ${questions} WHERE ${qualified(questions.poolId)} = ${qualified(pools.id)} AND ${qualified(questions.deletedAt)} IS NULL)::int`;

/**
 * How many live questions of the pool a student has met (ADR-013, amendment
 * of 2026-10-04): DISTINCT questions, every version together, frozen in an
 * item of an exam or an exercise (never a poll) that has a started attempt
 * of a student account (no guest) which is not a staff walk (ADR-018). A
 * historical fact: the `stats_since` reset does not apply. Counted through
 * `questions.pool_id`, so a moved question carries its history along.
 * Reads `evaluations`, `evaluation_items` and `attempts` by join.
 */
const usedCount = sql<number>`(SELECT count(DISTINCT ${qualified(questions.id)}) FROM ${questions}
    JOIN ${questionVersions} ON ${qualified(questionVersions.questionId)} = ${qualified(questions.id)}
    JOIN ${evaluationItems} ON ${qualified(evaluationItems.questionVersionId)} = ${qualified(questionVersions.id)}
    JOIN ${evaluations} ON ${qualified(evaluations.id)} = ${qualified(evaluationItems.evaluationId)}
    WHERE ${qualified(questions.poolId)} = ${qualified(pools.id)}
      AND ${qualified(questions.deletedAt)} IS NULL
      AND ${qualified(evaluations.mode)} IN ('exam', 'exercise')
      AND EXISTS (SELECT 1 FROM ${attempts}
        WHERE ${qualified(attempts.evaluationId)} = ${qualified(evaluations.id)}
          AND ${qualified(attempts.startedAt)} IS NOT NULL
          AND ${qualified(attempts.userId)} IS NOT NULL
          AND NOT ${isStaffAttempt}))::int`;

/**
 * The visibility a pool DISPLAYS (ADR-013, amendment of 2026-10-10), derived
 * from the roster in SQL so the list can sort on it: `public` when published;
 * `shared` when someone other than the owner holds a seat, directly or through
 * the staff of a linked course; `private` otherwise (a pool linked only to the
 * owner's own course stays private).
 */
export const derivedVisibility = sql<PoolVisibility>`(CASE
  WHEN ${qualified(pools.isPublic)} THEN 'public'
  WHEN EXISTS (SELECT 1 FROM ${poolMembers} WHERE ${qualified(poolMembers.poolId)} = ${qualified(pools.id)})
    OR EXISTS (SELECT 1 FROM ${coursePools} JOIN ${courseStaff} ON ${qualified(courseStaff.courseId)} = ${qualified(coursePools.courseId)}
      WHERE ${qualified(coursePools.poolId)} = ${qualified(pools.id)} AND ${qualified(courseStaff.userId)} <> ${qualified(pools.ownerId)})
  THEN 'shared' ELSE 'private' END)`;

/** The derived visibility of one pool, read now. */
export async function visibilityOf(db: Db, poolId: string): Promise<PoolVisibility> {
  const [row] = await db.select({ v: derivedVisibility }).from(pools).where(eq(pools.id, poolId));
  return row?.v ?? "private";
}

export function poolJson(pool: PoolRow, visibility: PoolVisibility): Pool {
  return {
    id: pool.id,
    name: pool.name,
    icon: pool.icon,
    color: pool.color,
    visibility,
    isPublic: pool.isPublic,
    description: pool.description,
    descriptionSource: pool.descriptionSource,
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

/** The facts of `effectivePoolRole` for one row, Super Powers aside. */
function roleFacts(
  row: { ownerId: string; isPublic: boolean; memberRole: PoolRole | null; isCourseStaff: boolean },
  viewerId: string,
): PoolRoleFacts {
  return {
    reachesAll: false,
    isOwner: row.ownerId === viewerId,
    memberRole: row.memberRole,
    isCourseStaff: row.isCourseStaff,
    isPublic: row.isPublic,
  };
}

/**
 * The caller's EFFECTIVE role on every pool the predicate selects, by pool
 * id, and nothing else: what a write check needs, without the counts and the
 * owner of {@link listPools}.
 */
export async function poolRolesOf(
  db: Db,
  where: SQL | undefined,
  viewer: Pick<Caller, "id" | "reach">,
): Promise<Map<string, PoolRole>> {
  const rows = await db
    .select({
      id: pools.id,
      ownerId: pools.ownerId,
      isPublic: pools.isPublic,
      memberRole: memberRoleOf(viewer.id),
      isCourseStaff: courseStaffOf(viewer.id),
    })
    .from(pools)
    .where(where);
  return new Map(
    rows.map((r) => [
      r.id,
      effectivePoolRole({ ...roleFacts(r, viewer.id), reachesAll: viewer.reach === "all" }),
    ]),
  );
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
  viewer: Pick<Caller, "id" | "reach">,
): Promise<PoolSummary[]> {
  const rows = await db
    .select({
      pool: pools,
      visibility: derivedVisibility,
      questionCount,
      usedCount,
      memberCount: memberCountOf,
      memberRole: memberRoleOf(viewer.id),
      isCourseStaff: courseStaffOf(viewer.id),
      ownerGivenName: users.givenName,
      ownerFamilyName: users.familyName,
      ownerEmail: users.email,
      ownerPicture: users.pictureUrl,
      ownerAvatarAt: avatars.updatedAt,
    })
    .from(pools)
    .leftJoin(users, eq(users.id, pools.ownerId))
    .leftJoin(avatars, eq(avatars.userId, pools.ownerId))
    .where(where)
    .orderBy(asc(pools.name));
  return rows.map((r) => {
    const facts = roleFacts({ ...r.pool, memberRole: r.memberRole, isCourseStaff: r.isCourseStaff }, viewer.id);
    return {
      ...poolJson(r.pool, r.visibility),
      questionCount: r.questionCount,
      usedCount: r.usedCount,
      memberCount: r.memberCount,
      role: effectivePoolRole({ ...facts, reachesAll: viewer.reach === "all" }),
      heldRole: heldPoolRole(facts),
      ownerName: displayName({
        givenName: r.ownerGivenName,
        familyName: r.ownerFamilyName,
        email: r.ownerEmail ?? "",
      }),
      ownerGivenName: r.ownerGivenName ?? "",
      ownerFamilyName: r.ownerFamilyName ?? "",
      ownerAvatarUrl: shownAvatar(r.pool.ownerId, r.ownerAvatarAt, r.ownerPicture ?? null),
    };
  });
}

export async function createPool(
  db: Db,
  input: {
    name: string;
    isPublic?: boolean | undefined;
    ownerId: string;
    icon?: string | null | undefined;
    color?: PoolColor | null | undefined;
  },
) {
  const [row] = await db
    .insert(pools)
    .values({
      id: randomUUID(),
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? null,
      isPublic: input.isPublic ?? false,
      ownerId: input.ownerId,
    })
    .returning();
  return poolJson(row!, row!.isPublic ? "public" : "private");
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
    color?: PoolColor | null | undefined;
    isPublic?: boolean | undefined;
    description?: string | undefined;
    descriptionSource?: PoolDescriptionSource | undefined;
  },
) {
  const [row] = await db
    .update(pools)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pools.id, poolId))
    .returning();
  return poolJson(row!, await visibilityOf(db, poolId));
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
 * `GET /pools/:id`: the pool, its category tree, the concepts in use with
 * their counts (labelled in `lang`, the pool's "Concepts" tab) — and the caller's effective role, which is what the
 * screen reads to decide whether it offers an editor or a reading view.
 */
export async function poolDetail(db: Db, pool: PoolRow, role: PoolRole, lang: ConceptLang) {
  const [tree, used, [counted]] = await Promise.all([
    categoryTree(db, pool.id),
    poolConcepts(db, pool.id, lang),
    db.select({ n: questionCount }).from(pools).where(eq(pools.id, pool.id)),
  ]);
  return {
    pool: poolJson(pool, await visibilityOf(db, pool.id)),
    role,
    categories: tree,
    concepts: used,
    questionCount: counted?.n ?? 0,
  };
}
