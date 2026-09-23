/**
 * The `pool` module's business layer: pools, categories, questions, their
 * versions. Routes call this file; no other module reads it except through
 * the few functions the plan lets them (`setCoursePools`, `poolsOfCourse`).
 *
 * Two rules shape everything here:
 *   - a stored config is only ever read and written through `./config.ts`
 *     (PLAN-MVP §1.6), never parsed inline;
 *   - a question's content lives in `question_versions`, never in
 *     `questions`; publishing is ONE transaction guarded by two unique
 *     indexes (see `db/pool.ts`).
 */
import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  getTableName,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

import type {
  Category,
  CategoryCountNode,
  CategoryNode,
  Pool,
  PoolCandidates,
  PoolCategories,
  PoolMember,
  PoolMembers,
  PoolRole,
  PoolSummary,
  QuestionDetail,
  QuestionDraft,
  QuestionMeta,
  QuestionRow,
  PoolTag,
  QuestionSearch,
  VersionDetail,
  VersionRow,
  ZodIssueLite,
} from "@quiz/contracts";
import { issuesOf } from "@quiz/contracts";
import { effectivePoolRole } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import {
  assets,
  attempts,
  categories,
  classrooms,
  coursePools,
  courseStaff,
  courses,
  evaluationItems,
  evaluations,
  poolMembers,
  pools,
  poolTags as poolTagsTable,
  questionTags,
  questionVersionAssets,
  questionVersions,
  questions,
  userEmails,
  users,
} from "../../db/schema.js";
import { audit } from "../../audit.js";
import { notify } from "../notifications/service.js";
import { userTopic } from "../realtime/bus.js";
import { poolPeopleChanged } from "./events.js";
import {
  loadConfig,
  saveConfig,
  saveDraftConfig,
  searchTextOf,
  tryLoadConfig,
  typeOf,
} from "./config.js";

/** The handle inside `db.transaction(...)`: the same builders, one connection. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type PoolRow = typeof pools.$inferSelect;
type QuestionRecord = typeof questions.$inferSelect;

/**
 * The pool of a question this module was handed. Every route reaches a
 * question THROUGH its pool (`findAccessibleQuestion` joins `pools`), and the
 * only questions without one — the unsaved questions of a poll (ADR-014,
 * addendum 2026-09-23) — are never reached that way; a null here is a bug.
 */
function poolOf(question: QuestionRecord): string {
  if (question.poolId === null) throw new Error(`question ${question.id} belongs to no pool`);
  return question.poolId;
}
type VersionRecord = typeof questionVersions.$inferSelect;

/** A draft cannot be published while its config does not satisfy the schema (D16). */
export class DraftInvalid extends Error {
  constructor(readonly issues: ZodIssueLite[]) {
    super("draft config is invalid");
    this.name = "DraftInvalid";
  }
}

/** The question has no draft row at all — a corrupted question, never normal. */
export class MissingDraft extends Error {
  constructor() {
    super("question has no draft");
    this.name = "MissingDraft";
  }
}

/** A published version is referenced by an evaluation item (`409 in_use`). */
export class VersionInUse extends Error {
  constructor() {
    super("a published version is in use");
    this.name = "VersionInUse";
  }
}

/**
 * A move would land two live questions on the same internal name in the
 * target pool (`questions_pool_name_uq`). A move KEEPS the name it moves —
 * unlike a copy, which invents one (ADR-017) — so the answer is a 409 that
 * names the offenders rather than a silent rename.
 */
export class MoveNameTaken extends Error {
  constructor(readonly names: string[]) {
    super("an internal name is already taken in the target pool");
    this.name = "MoveNameTaken";
  }
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/**
 * `"table"."column"`, always.
 *
 * A bare `${table.column}` inside a `sql` fragment renders WITHOUT its table
 * whenever drizzle believes the surrounding statement reads a single table —
 * which is exactly the case of the correlated subquery below, sitting in the
 * select list of `select … from pools`. The condition then came out as
 * `"pool_id" = "id"`, both resolved against `questions`, and every pool
 * counted zero. Qualifying by hand makes the fragment independent of the
 * statement it is dropped into.
 */
function qualified(column: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

const questionCount = sql<number>`(SELECT count(*) FROM ${questions} WHERE ${qualified(questions.poolId)} = ${qualified(pools.id)} AND ${qualified(questions.deletedAt)} IS NULL)::int`;

function poolJson(pool: PoolRow): Pool {
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

/** "Prof Démo", or the e-mail when the account has no name yet. */
function displayName(row: { givenName: string | null; familyName: string | null; email: string }): string {
  const full = `${row.givenName ?? ""} ${row.familyName ?? ""}`.trim();
  return full === "" ? row.email : full;
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
 * The pool. The bells that point at it go with it: `notifications.pool_id`
 * cascades, so no reader is walked to a 404.
 */
export async function deletePool(db: Db, poolId: string): Promise<void> {
  await db.delete(pools).where(eq(pools.id, poolId));
}

// ---------------------------------------------------------------------------
// Members (F-POOL-05)
// ---------------------------------------------------------------------------

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

/** The distinct tags used by the live questions of a pool, alphabetical. */
export async function poolTagNames(db: Db, poolId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tag: questionTags.tag })
    .from(questionTags)
    .innerJoin(questions, eq(questionTags.questionId, questions.id))
    .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)))
    .orderBy(asc(questionTags.tag));
  return rows.map((r) => r.tag);
}

/**
 * The whole tag vocabulary of a pool, alphabetical: the documented rows of
 * `pool_tags` and, defensively, any tag worn by a question that has no row
 * yet (a pool written before the lazy creation landed and never migrated).
 * `count` only counts the live questions, which is what the teacher sees.
 */
export async function poolTags(db: Db, poolId: string): Promise<PoolTag[]> {
  const [described, used] = await Promise.all([
    db
      .select({ tag: poolTagsTable.tag, description: poolTagsTable.description })
      .from(poolTagsTable)
      .where(eq(poolTagsTable.poolId, poolId)),
    db
      .select({ tag: questionTags.tag, n: sql<number>`count(*)::int` })
      .from(questionTags)
      .innerJoin(questions, eq(questionTags.questionId, questions.id))
      .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)))
      .groupBy(questionTags.tag),
  ]);
  const counts = new Map(used.map((r) => [r.tag, r.n]));
  const out = new Map<string, PoolTag>();
  for (const row of described) {
    out.set(row.tag, { tag: row.tag, description: row.description, count: counts.get(row.tag) ?? 0 });
  }
  for (const row of used) {
    if (!out.has(row.tag)) out.set(row.tag, { tag: row.tag, description: "", count: row.n });
  }
  return [...out.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * Writes the one-line description of a tag. The row is created if the tag is
 * only worn by questions so far, so documenting a tag never needs a separate
 * "create the tag" call.
 */
export async function describeTag(
  db: Db,
  poolId: string,
  tag: string,
  description: string,
): Promise<PoolTag> {
  const name = normalizeTag(tag);
  await db
    .insert(poolTagsTable)
    .values({ poolId, tag: name, description })
    .onConflictDoUpdate({
      target: [poolTagsTable.poolId, poolTagsTable.tag],
      set: { description },
    });
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(questionTags)
    .innerJoin(questions, eq(questionTags.questionId, questions.id))
    .where(
      and(eq(questions.poolId, poolId), isNull(questions.deletedAt), eq(questionTags.tag, name)),
    );
  return { tag: name, description, count: counted?.n ?? 0 };
}

/** The one spelling a tag is stored under, everywhere. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

/**
 * Lazily gives every tag of a pool its `pool_tags` row. Called from the two
 * places that write `question_tags`, so a tag invented in the editor is part
 * of the vocabulary — undocumented, but suggestible and countable — the
 * moment it is saved.
 */
async function ensurePoolTags(tx: Tx, poolId: string, tags: readonly string[]): Promise<void> {
  if (tags.length === 0) return;
  await tx
    .insert(poolTagsTable)
    .values(tags.map((tag) => ({ poolId, tag })))
    .onConflictDoNothing();
}

// --- `course_pools`: written here, called by the `org` module -------------

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
 * Replaces the whole set of pools a course draws from. Only pools the caller
 * can already reach may be linked, hence `allowed`: linking someone else's
 * pool would grant the whole staff access to it.
 */
export async function setCoursePools(
  db: Db,
  courseId: string,
  poolIds: readonly string[],
  allowed: SQL | undefined,
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

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function categoryJson(row: typeof categories.$inferSelect): Category {
  return {
    id: row.id,
    poolId: row.poolId,
    parentId: row.parentId,
    name: row.name,
    position: row.position,
  };
}

/** The folders of a pool as a tree; siblings ordered by `position` then name. */
export async function categoryTree(db: Db, poolId: string): Promise<CategoryNode[]> {
  const rows = await db
    .select()
    .from(categories)
    .where(eq(categories.poolId, poolId))
    .orderBy(asc(categories.position), asc(categories.name));
  const nodes = new Map<string, CategoryNode>(
    rows.map((r) => [r.id, { ...categoryJson(r), children: [] }]),
  );
  const roots: CategoryNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * `GET /pools/:id/categories`: the tree of the categories page, each folder
 * with the live questions filed directly in it, and the root's own count.
 * One grouped count, not one per folder.
 */
export async function categoriesWithCounts(db: Db, poolId: string): Promise<PoolCategories> {
  const [tree, counted] = await Promise.all([
    categoryTree(db, poolId),
    db
      .select({ categoryId: questions.categoryId, n: sql<number>`count(*)::int` })
      .from(questions)
      .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)))
      .groupBy(questions.categoryId),
  ]);
  const counts = new Map(counted.map((r) => [r.categoryId, r.n]));
  const withCounts = (nodes: CategoryNode[]): CategoryCountNode[] =>
    nodes.map((node) => ({
      ...node,
      questionCount: counts.get(node.id) ?? 0,
      children: withCounts(node.children),
    }));
  return { categories: withCounts(tree), rootQuestionCount: counts.get(null) ?? 0 };
}

export async function createCategory(
  db: Db,
  poolId: string,
  input: { name: string; parentId?: string | null | undefined },
): Promise<Category> {
  const parentId = input.parentId ?? null;
  const [last] = await db
    .select({ max: sql<number>`coalesce(max(${categories.position}), -1)::int` })
    .from(categories)
    .where(
      and(
        eq(categories.poolId, poolId),
        parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId),
      ),
    );
  const [row] = await db
    .insert(categories)
    .values({
      id: randomUUID(),
      poolId,
      parentId,
      name: input.name,
      position: (last?.max ?? -1) + 1,
    })
    .returning();
  return categoryJson(row!);
}

/**
 * A folder cannot become its own descendant; the walk up the parent chain is
 * what keeps the tree a tree (the database only knows the edge is valid).
 */
export async function wouldCycle(
  db: Db,
  categoryId: string,
  newParentId: string | null,
): Promise<boolean> {
  let cursor = newParentId;
  for (let hops = 0; cursor !== null && hops < 64; hops += 1) {
    if (cursor === categoryId) return true;
    const [row] = await db
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.id, cursor))
      .limit(1);
    if (!row) return false;
    cursor = row.parentId;
  }
  return false;
}

export async function updateCategory(
  db: Db,
  categoryId: string,
  patch: {
    name?: string | undefined;
    parentId?: string | null | undefined;
    position?: number | undefined;
  },
): Promise<Category> {
  const [row] = await db
    .update(categories)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    })
    .where(eq(categories.id, categoryId))
    .returning();
  return categoryJson(row!);
}

/**
 * Is this new layout of the tree a tree of THIS pool? Every folder moved and
 * every parent named must belong to the pool (a crafted payload must not hang
 * a folder under another pool's), and the layout the payload produces —
 * the moves applied TOGETHER, not one by one against the old tree — must
 * have no cycle: "A under B" and "B under A" are each fine alone.
 */
export async function checkCategoryLayout(
  db: Db,
  poolId: string,
  items: readonly { id: string; parentId: string | null }[],
): Promise<"not_found" | "cycle" | null> {
  const rows = await db
    .select({ id: categories.id, parentId: categories.parentId })
    .from(categories)
    .where(eq(categories.poolId, poolId));
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
  for (const item of items) {
    if (!parentOf.has(item.id)) return "not_found";
    if (item.parentId !== null && !parentOf.has(item.parentId)) return "not_found";
  }
  for (const item of items) parentOf.set(item.id, item.parentId);
  for (const item of items) {
    let cursor = parentOf.get(item.id) ?? null;
    for (let hops = 0; cursor !== null; hops += 1) {
      if (cursor === item.id || hops > parentOf.size) return "cycle";
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  return null;
}

/**
 * Drag-and-drop reorder of the whole tree in one call. Only the rows of this
 * pool are touched, so a crafted payload cannot move a folder into another
 * pool's tree.
 */
export async function reorderCategories(
  db: Db,
  poolId: string,
  items: readonly { id: string; parentId: string | null; position: number }[],
): Promise<CategoryNode[]> {
  await db.transaction(async (tx) => {
    for (const item of items) {
      await tx
        .update(categories)
        .set({ parentId: item.parentId, position: item.position })
        .where(and(eq(categories.id, item.id), eq(categories.poolId, poolId)));
    }
  });
  return categoryTree(db, poolId);
}

/** Deleting a folder deletes its subtree; its questions fall back to the root. */
export async function deleteCategory(db: Db, categoryId: string): Promise<void> {
  await db.delete(categories).where(eq(categories.id, categoryId));
}

// ---------------------------------------------------------------------------
// Questions — listing and metadata
// ---------------------------------------------------------------------------

/** A cursor that does not belong to the query it was sent with (400). */
export class InvalidCursor extends Error {
  constructor(readonly reason: "malformed" | "sort_changed") {
    super(`cursor is ${reason}`);
    this.name = "InvalidCursor";
  }
}

/**
 * The keyset cursor: the SORT KEY of the last row of the page, its id, and
 * the order that produced them — base64url, opaque to the client, same shape
 * as the `(updatedAt, id)` one it replaces.
 *
 * Carrying the order is what makes a page safe: a client that changes column
 * mid-scroll sends a key that means nothing in the new order, and the API
 * refuses it (`sort_changed`) instead of returning a page that mixes two.
 */
interface Cursor {
  sort: QuestionSearch["sort"];
  dir: QuestionSearch["dir"];
  /** The sort key as text; `id` breaks the ties. */
  key: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string, search: QuestionSearch): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursor("malformed");
  }
  const cursor = parsed as Partial<Cursor> | null;
  if (!cursor || typeof cursor.key !== "string" || typeof cursor.id !== "string") {
    throw new InvalidCursor("malformed");
  }
  if (cursor.sort !== search.sort || cursor.dir !== search.dir) {
    throw new InvalidCursor("sort_changed");
  }
  return { sort: search.sort, dir: search.dir, key: cursor.key, id: cursor.id };
}

/**
 * The highest PUBLISHED version number of a question, as a correlated
 * subquery. `null` for a draft-only question — which is why `version:>1` and
 * `version:<3` both leave those rows out: a comparison against null is never
 * true (F-POOL-03, the `version:` filters of the search box).
 */
const latestNumber = sql<number | null>`(SELECT max(${qualified(questionVersions.number)}) FROM ${questionVersions} WHERE ${qualified(questionVersions.questionId)} = ${qualified(questions.id)})`;

/**
 * The sort key per column, as SQL and as text.
 *
 * `version` sorts NULLS LAST in both directions, which a plain `order by`
 * could express but a KEYSET comparison could not: `(key, id) < (…)` has no
 * meaning when the key is null. The null is therefore folded into a sentinel
 * that already sorts last in the requested direction, and the row comparison
 * stays a single, index-friendly expression.
 */
const SORT_KEYS = {
  name: { expr: () => sql`lower(${qualified(questions.internalName)})`, cast: "text" },
  type: { expr: () => qualified(questions.type), cast: "text" },
  difficulty: { expr: () => qualified(questions.difficulty), cast: "int" },
  version: {
    expr: (dir: QuestionSearch["dir"]) =>
      sql`coalesce(${latestNumber}, ${dir === "desc" ? -1 : 2_147_483_647})`,
    cast: "int",
  },
  updated: { expr: () => qualified(questions.updatedAt), cast: "timestamptz" },
} as const satisfies Record<
  QuestionSearch["sort"],
  { expr: (dir: QuestionSearch["dir"]) => SQL; cast: string }
>;

/** The value the database returned for the sort key, as cursor text. */
function keyText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

/**
 * The filter bar of the pool screen, as SQL. Everything is optional and
 * everything composes; the text search runs against the generated tsvector of
 * ANY version of the question plus its internal name, because a teacher
 * searches for what they wrote, published or not.
 */
function searchWhere(poolId: string, search: QuestionSearch): SQL[] {
  const clauses: SQL[] = [eq(questions.poolId, poolId)];
  if (!search.includeDeleted) clauses.push(isNull(questions.deletedAt));
  if (search.categoryId) clauses.push(eq(questions.categoryId, search.categoryId));
  if (search.type?.length) clauses.push(inArray(questions.type, search.type));
  if (search.difficulty?.length) clauses.push(inArray(questions.difficulty, search.difficulty));
  if (search.tag?.length) {
    clauses.push(
      sql`EXISTS (SELECT 1 FROM ${questionTags} WHERE ${questionTags.questionId} = ${questions.id} AND ${inArray(questionTags.tag, search.tag)})`,
    );
  }
  if (search.q) {
    const like = `%${search.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    clauses.push(
      sql`(${questions.internalName} ILIKE ${like} OR EXISTS (SELECT 1 FROM ${questionVersions} WHERE ${questionVersions.questionId} = ${questions.id} AND ${questionVersions.search} @@ plainto_tsquery('simple', ${search.q})))`,
    );
  }
  // `version:>1` / `version:<3`: bounds on the HIGHEST published number. A
  // question that was never published has none, and matches neither bound.
  if (search.versionMin !== undefined) clauses.push(sql`${latestNumber} >= ${search.versionMin}`);
  if (search.versionMax !== undefined) clauses.push(sql`${latestNumber} <= ${search.versionMax}`);
  return clauses;
}

/** Tags of a set of questions, in one query. */
async function tagsOf(db: Db, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(questionTags)
    .where(inArray(questionTags.questionId, ids))
    .orderBy(asc(questionTags.tag));
  for (const row of rows) {
    const list = out.get(row.questionId) ?? [];
    list.push(row.tag);
    out.set(row.questionId, list);
  }
  return out;
}

interface VersionFacts {
  latestNumber: number | null;
  publishedAt: Date | null;
  deprecated: boolean;
  draftUpdatedAt: Date | null;
}

/** Latest published number, its deprecation, and the draft's mtime, per question. */
async function versionFactsOf(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, VersionFacts>> {
  const out = new Map<string, VersionFacts>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      questionId: questionVersions.questionId,
      number: questionVersions.number,
      publishedAt: questionVersions.publishedAt,
      deprecatedAt: questionVersions.deprecatedAt,
      updatedAt: questionVersions.updatedAt,
    })
    .from(questionVersions)
    .where(inArray(questionVersions.questionId, ids));
  for (const row of rows) {
    const facts = out.get(row.questionId) ?? {
      latestNumber: null,
      publishedAt: null,
      deprecated: false,
      draftUpdatedAt: null,
    };
    if (row.number === null) {
      facts.draftUpdatedAt = row.updatedAt;
    } else if (facts.latestNumber === null || row.number > facts.latestNumber) {
      facts.latestNumber = row.number;
      facts.publishedAt = row.publishedAt;
      facts.deprecated = row.deprecatedAt !== null;
    }
    out.set(row.questionId, facts);
  }
  return out;
}

/**
 * The draft moved after the last publication. Publishing writes both rows
 * with the same timestamp, so the comparison is strict.
 */
function hasDraftChanges(facts: VersionFacts | undefined): boolean {
  if (!facts?.draftUpdatedAt) return false;
  if (!facts.publishedAt) return true;
  return facts.draftUpdatedAt.getTime() > facts.publishedAt.getTime();
}

function rowJson(
  question: QuestionRecord,
  tags: string[],
  facts: VersionFacts | undefined,
): QuestionRow {
  return {
    id: question.id,
    type: question.type,
    internalName: question.internalName,
    difficulty: question.difficulty,
    tags,
    categoryId: question.categoryId,
    latestNumber: facts?.latestNumber ?? null,
    hasDraftChanges: hasDraftChanges(facts),
    updatedAt: question.updatedAt.toISOString(),
    deprecated: facts?.deprecated ?? false,
    deletedAt: question.deletedAt?.toISOString() ?? null,
  };
}

/**
 * `GET /pools/:id/questions`: filtered, sorted on the requested column,
 * cursor-paginated.
 *
 * The sort key is SELECTED as well as ordered on, so the cursor carries the
 * exact value the database produced — a `lower()` recomputed in JavaScript
 * could disagree with the collation and silently skip a row at a page break.
 */
export async function listQuestions(db: Db, poolId: string, search: QuestionSearch) {
  const clauses = searchWhere(poolId, search);
  // Counted before the cursor narrows the clauses: the total of the search,
  // the same on every page, and not the size of the page.
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(questions)
    .where(and(...clauses));
  const spec = SORT_KEYS[search.sort];
  const key = spec.expr(search.dir);
  const descending = search.dir === "desc";
  if (search.cursor) {
    const cursor = decodeCursor(search.cursor, search);
    // One row-value comparison, so the page break is a single predicate on
    // `(sort key, id)` — the pair the ORDER BY below is built on.
    clauses.push(
      sql`(${key}, ${qualified(questions.id)}) ${sql.raw(descending ? "<" : ">")} (${cursor.key}::${sql.raw(spec.cast)}, ${cursor.id}::uuid)`,
    );
  }
  const order = descending ? desc : asc;
  const rows = await db
    .select({ question: questions, sortKey: key })
    .from(questions)
    .where(and(...clauses))
    .orderBy(order(key), order(questions.id))
    .limit(search.limit + 1);
  const page = rows.slice(0, search.limit);
  const ids = page.map((r) => r.question.id);
  const [tags, facts] = await Promise.all([tagsOf(db, ids), versionFactsOf(db, ids)]);
  const last = page.at(-1);
  return {
    items: page.map((r) =>
      rowJson(r.question, tags.get(r.question.id) ?? [], facts.get(r.question.id)),
    ),
    nextCursor:
      rows.length > search.limit && last
        ? encodeCursor({
            sort: search.sort,
            dir: search.dir,
            key: keyText(last.sortKey),
            id: last.question.id,
          })
        : null,
    total: counted?.n ?? 0,
  };
}

function metaJson(question: QuestionRecord, tags: string[]): QuestionMeta {
  return {
    id: question.id,
    poolId: poolOf(question),
    type: question.type,
    internalName: question.internalName,
    categoryId: question.categoryId,
    difficulty: question.difficulty,
    shuffleable: question.shuffleable,
    randomizable: question.randomizable,
    tags,
    createdBy: question.createdBy,
    originQuestionId: question.originQuestionId,
    deletedAt: question.deletedAt?.toISOString() ?? null,
    updatedAt: question.updatedAt.toISOString(),
  };
}

function versionJson(row: VersionRecord): VersionRow {
  return {
    number: row.number!,
    publishedAt: (row.publishedAt ?? row.updatedAt).toISOString(),
    publishedBy: row.publishedBy,
    changeNote: row.changeNote,
    deprecatedAt: row.deprecatedAt?.toISOString() ?? null,
    deprecationNote: row.deprecationNote,
  };
}

function draftJson(type: string, row: VersionRecord): QuestionDraft {
  const outcome = tryLoadConfig(type, row);
  return {
    // MIGRATED either way (the editor always works at the current schema),
    // and never re-validated when it does not parse: the teacher must not
    // lose the half-written work `PUT /draft` accepted (D16). An invalid
    // draft handed back at its OLD shape is what used to be written straight
    // back under the current version number — see `tryLoadConfig`.
    config: outcome.config,
    explanation: row.explanation,
    configVersion: row.configVersion,
    updatedAt: row.updatedAt.toISOString(),
    valid: outcome.ok,
  };
}

// ---------------------------------------------------------------------------
// Questions — the write path
// ---------------------------------------------------------------------------

/**
 * A new question and its first draft, pre-filled by the type's
 * `emptyDraft()` — the only place a config is born.
 *
 * That draft is EMPTY, so it does not satisfy the type's schema: it goes
 * through `saveDraftConfig`, exactly like the autosave of `putDraft`, and is
 * stored as it stands (decision D16). Refusing it here would mean no teacher
 * could ever create a question.
 */
export async function createQuestion(
  db: Db,
  input: {
    poolId: string;
    type: string;
    internalName: string;
    categoryId?: string | null;
    createdBy: string;
  },
): Promise<string> {
  const t = typeOf(input.type);
  const { row: config } = saveDraftConfig(input.type, t.emptyDraft());
  const id = randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(questions).values({
      id,
      poolId: input.poolId,
      type: input.type,
      internalName: input.internalName,
      categoryId: input.categoryId ?? null,
      createdBy: input.createdBy,
      shuffleable: t.shuffleable(config.config),
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(questionVersions).values({
      id: randomUUID(),
      questionId: id,
      number: null,
      config: config.config,
      configVersion: config.configVersion,
      searchText: searchTextOf(input.type, input.internalName, config.config),
      updatedAt: now,
      createdAt: now,
    });
  });
  return id;
}

/**
 * A question that belongs to NO pool: the one a teacher writes straight into
 * the poll launcher and does not keep (ADR-014, addendum 2026-09-23).
 *
 * It is born PUBLISHED — version 1, no draft — because the only thing that
 * will ever read it is the poll that freezes that version, and a draft is
 * something to come back to. The configuration goes through the type's own
 * schema (`saveConfig`), the same gate as a publication with ONE exception:
 * the key is optional (`keyOptional`, the type's `keylessConfigSchema`), for
 * a poll may ask an opinion. A refusal is `DraftInvalid` with the zod
 * issues, for the launcher to place under its fields.
 *
 * It lives HERE because `questions` and `question_versions` are this
 * module's tables. Nothing reaches it afterwards but its evaluation item: no
 * pool lists it, and `findAccessibleQuestion` joins `pools`.
 */
export async function createUnsavedQuestion(
  db: Db,
  input: { type: string; config: unknown; createdBy: string; now: Date },
): Promise<{ questionId: string; versionId: string; internalName: string }> {
  const t = typeOf(input.type);
  let config: ReturnType<typeof saveConfig>;
  try {
    config = saveConfig(input.type, input.config, { keyOptional: true });
  } catch (error) {
    throw new DraftInvalid(issuesOf(error));
  }
  const internalName = unsavedName(input.type, config.config);
  const questionId = randomUUID();
  const versionId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(questions).values({
      id: questionId,
      poolId: null,
      type: input.type,
      internalName,
      createdBy: input.createdBy,
      shuffleable: t.shuffleable(config.config),
      createdAt: input.now,
      updatedAt: input.now,
    });
    await tx.insert(questionVersions).values({
      id: versionId,
      questionId,
      number: 1,
      config: config.config,
      configVersion: config.configVersion,
      searchText: searchTextOf(input.type, internalName, config.config),
      publishedAt: input.now,
      publishedBy: input.createdBy,
      updatedAt: input.now,
      createdAt: input.now,
    });
  });
  return { questionId, versionId, internalName };
}

/**
 * The name of an unsaved question, and therefore the title of its poll: the
 * start of its statement, as plain text. The statement is what the room
 * reads anyway, so the title reveals nothing a participant does not see.
 */
function unsavedName(type: string, config: unknown): string {
  const prompt = (config as { prompt?: unknown }).prompt;
  const line =
    typeof prompt === "string"
      ? prompt
          .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
          .replace(/[`*_#>$\\]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  if (line === "") return type;
  return line.length <= 80 ? line : `${line.slice(0, 79).trimEnd()}…`;
}

/** The draft row of a question (`number is null`), or `MissingDraft`. */
export async function draftOf(db: Db, questionId: string): Promise<VersionRecord> {
  const [row] = await db
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), isNull(questionVersions.number)))
    .limit(1);
  if (!row) throw new MissingDraft();
  return row;
}

export async function questionDetail(db: Db, question: QuestionRecord): Promise<QuestionDetail> {
  const [draft, versions, tags] = await Promise.all([
    draftOf(db, question.id),
    db
      .select()
      .from(questionVersions)
      .where(
        and(eq(questionVersions.questionId, question.id), isNotNull(questionVersions.number)),
      )
      .orderBy(desc(questionVersions.number)),
    tagsOf(db, [question.id]),
  ]);
  const rows = versions.map(versionJson);
  return {
    meta: metaJson(question, tags.get(question.id) ?? []),
    draft: draftJson(question.type, draft),
    versions: rows,
    latestPublished: rows[0] ?? null,
  };
}

/**
 * Metadata only. Renaming also refreshes the draft's `search_text`, so the
 * full-text index follows the name the teacher searches by.
 */
export async function patchQuestion(
  db: Db,
  question: QuestionRecord,
  patch: {
    internalName?: string | undefined;
    categoryId?: string | null | undefined;
    difficulty?: number | undefined;
    shuffleable?: boolean | undefined;
    randomizable?: boolean | undefined;
    tags?: readonly string[] | undefined;
  },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(questions)
      .set({
        ...(patch.internalName !== undefined ? { internalName: patch.internalName } : {}),
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.difficulty !== undefined ? { difficulty: patch.difficulty } : {}),
        ...(patch.shuffleable !== undefined ? { shuffleable: patch.shuffleable } : {}),
        ...(patch.randomizable !== undefined ? { randomizable: patch.randomizable } : {}),
        updatedAt: now,
      })
      .where(eq(questions.id, question.id));
    if (patch.tags) {
      const unique = [...new Set(patch.tags.map(normalizeTag))].filter(Boolean);
      await tx.delete(questionTags).where(eq(questionTags.questionId, question.id));
      if (unique.length) {
        await tx
          .insert(questionTags)
          .values(unique.map((tag) => ({ questionId: question.id, tag })));
        await ensurePoolTags(tx, poolOf(question), unique);
      }
    }
    if (patch.internalName !== undefined) {
      const [draft] = await tx
        .select()
        .from(questionVersions)
        .where(
          and(eq(questionVersions.questionId, question.id), isNull(questionVersions.number)),
        )
        .limit(1);
      if (draft) {
        await tx
          .update(questionVersions)
          .set({
            searchText: searchTextOf(question.type, patch.internalName, draft.config),
          })
          .where(eq(questionVersions.id, draft.id));
      }
    }
  });
}

/**
 * Autosave (F-QST-02, decision D16): the config is STORED even when it does
 * not parse, and the issues travel back so the editor can underline them.
 * Nothing here can fail on content.
 */
export async function putDraft(
  db: Db,
  question: QuestionRecord,
  body: { config: unknown; explanation?: string },
): Promise<{ updatedAt: string; valid: boolean; issues: ZodIssueLite[] }> {
  const draft = await draftOf(db, question.id);
  const { row, issues } = saveDraftConfig(question.type, body.config);
  const explanation = body.explanation ?? draft.explanation;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(questionVersions)
      .set({
        config: row.config,
        configVersion: row.configVersion,
        explanation,
        searchText: searchTextOf(question.type, question.internalName, row.config),
        updatedAt: now,
      })
      .where(eq(questionVersions.id, draft.id));
    await tx.update(questions).set({ updatedAt: now }).where(eq(questions.id, question.id));
  });
  return { updatedAt: now.toISOString(), valid: issues.length === 0, issues };
}

/**
 * Every `asset:<uuid>` reference a stored configuration carries (F-QST-06).
 *
 * The markdown of a prompt, of a choice or of a cloze text embeds an image as
 * `asset:<uuid>`, which the web renderer rewrites into
 * `/app/api/assets/<uuid>`. Scanning the serialized config is what keeps this
 * type-agnostic: a new question type needs no hook for its images to be
 * reachable during an exam.
 */
function assetReferences(value: unknown): string[] {
  const found = new Set<string>();
  const pattern = /asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  for (const match of JSON.stringify(value ?? null).matchAll(pattern)) {
    found.add(match[1]!.toLowerCase());
  }
  return [...found];
}

/**
 * Publication (F-QST-03) in ONE transaction: the draft BECOMES version
 * `max + 1` and a fresh draft is opened with the same content. The partial
 * unique index `(question_id) where number is null` is what makes two
 * simultaneous publications resolve to one winner — the loser's insert of
 * the new draft violates it and its whole transaction rolls back.
 */
export async function publishQuestion(
  db: Db,
  question: QuestionRecord,
  input: { userId: string; changeNote?: string },
): Promise<VersionRow> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, question.id), isNull(questionVersions.number)))
      .for("update")
      .limit(1);
    if (!draft) throw new MissingDraft();

    // Full parse here, and only here: this is the gate D16 moves the
    // validation to.
    let config: unknown;
    try {
      config = saveConfig(question.type, loadConfig(question.type, draft)).config;
    } catch (error) {
      throw new DraftInvalid(issuesOf(error));
    }
    const configVersion = typeOf(question.type).configVersion;
    const searchText = searchTextOf(question.type, question.internalName, config);

    const [highest] = await tx
      .select({ max: sql<number>`coalesce(max(${questionVersions.number}), 0)::int` })
      .from(questionVersions)
      .where(eq(questionVersions.questionId, question.id));
    const number = (highest?.max ?? 0) + 1;
    const now = new Date();

    const [published] = await tx
      .update(questionVersions)
      .set({
        number,
        config,
        configVersion,
        searchText,
        publishedAt: now,
        publishedBy: input.userId,
        changeNote: input.changeNote ?? null,
        updatedAt: now,
      })
      .where(eq(questionVersions.id, draft.id))
      .returning();

    await tx.insert(questionVersions).values({
      id: randomUUID(),
      questionId: question.id,
      number: null,
      config,
      configVersion,
      explanation: draft.explanation,
      searchText,
      updatedAt: now,
      createdAt: now,
    });
    await tx.update(questions).set({ updatedAt: now }).where(eq(questions.id, question.id));

    // The link table of `db/pool.ts`: which assets this version shows. It is
    // the garbage-collection root, and it is what lets a STUDENT taking the
    // evaluation read the image (`assetReachableBy`).
    await tx
      .delete(questionVersionAssets)
      .where(eq(questionVersionAssets.versionId, draft.id));
    const referenced = assetReferences({ config, explanation: draft.explanation });
    if (referenced.length > 0) {
      // Only ids that exist: a reference to a deleted asset is a broken
      // image, not a failed publication.
      const known = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(inArray(assets.id, referenced));
      if (known.length > 0) {
        await tx
          .insert(questionVersionAssets)
          .values(known.map((row) => ({ versionId: draft.id, assetId: row.id })))
          .onConflictDoNothing();
      }
    }
    return versionJson(published!);
  });
}

/**
 * May this STUDENT read this asset? (F-QST-06, N-SEC-05.)
 *
 * Exactly when the image is shown to them by a question they are taking or
 * reviewing: a version referenced by an item of an evaluation they hold an
 * attempt on, while that attempt is running or once the results are
 * released. Anything else is a 404, indistinguishable from a missing asset
 * (invariant 6). `assets` and `question_version_assets` are this module's
 * tables; `evaluation_items` and `attempts` are read by join, never written.
 */
export async function assetReachableBy(
  db: Db,
  assetId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: questionVersionAssets.assetId })
    .from(questionVersionAssets)
    .innerJoin(
      evaluationItems,
      eq(evaluationItems.questionVersionId, questionVersionAssets.versionId),
    )
    .innerJoin(evaluations, eq(evaluations.id, evaluationItems.evaluationId))
    .innerJoin(
      attempts,
      and(eq(attempts.evaluationId, evaluationItems.evaluationId), eq(attempts.userId, userId)),
    )
    .where(
      and(
        eq(questionVersionAssets.assetId, assetId),
        or(eq(attempts.state, "in_progress"), isNotNull(evaluations.releasedAt)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** One published version, config migrated to the current shape. */
export async function versionDetail(
  db: Db,
  question: QuestionRecord,
  number: number,
): Promise<VersionDetail | null> {
  const row = await versionRow(db, question.id, number);
  if (!row) return null;
  return {
    ...versionJson(row),
    config: loadConfig(question.type, row),
    explanation: row.explanation,
    configVersion: row.configVersion,
  };
}

export async function versionRow(
  db: Db,
  questionId: string,
  number: number,
): Promise<VersionRecord | null> {
  const [row] = await db
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.number, number)))
    .limit(1);
  return row ?? null;
}

export async function listVersions(db: Db, questionId: string): Promise<VersionRow[]> {
  const rows = await db
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), isNotNull(questionVersions.number)))
    .orderBy(desc(questionVersions.number));
  return rows.map(versionJson);
}

/** Copies a published version back into the draft (F-QST-05). */
export async function restoreVersion(
  db: Db,
  question: QuestionRecord,
  number: number,
): Promise<boolean> {
  const source = await versionRow(db, question.id, number);
  if (!source) return false;
  const draft = await draftOf(db, question.id);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(questionVersions)
      .set({
        config: source.config,
        configVersion: source.configVersion,
        explanation: source.explanation,
        searchText: source.searchText,
        updatedAt: now,
      })
      .where(eq(questionVersions.id, draft.id));
    await tx.update(questions).set({ updatedAt: now }).where(eq(questions.id, question.id));
  });
  return true;
}

/** Marks a version as not-to-be-used-any-more; existing evaluations keep it. */
export async function deprecateVersion(
  db: Db,
  questionId: string,
  number: number,
  note: string,
): Promise<VersionRow | null> {
  const [row] = await db
    .update(questionVersions)
    .set({ deprecatedAt: new Date(), deprecationNote: note })
    .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.number, number)))
    .returning();
  return row ? versionJson(row) : null;
}

/**
 * Is a published version referenced by an evaluation?
 *
 * This is what makes `409 in_use` real: a version an evaluation froze
 * (F-EVAL-03) must stay readable forever, because a student answered THAT
 * wording. `evaluation_items` belongs to the `evaluation` module; the `pool`
 * module reads it by join and never writes it (CLAUDE.md, Conventions).
 */
export async function isVersionInUse(db: Db, versionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: evaluationItems.id })
    .from(evaluationItems)
    .where(eq(evaluationItems.questionVersionId, versionId))
    .limit(1);
  return row !== undefined;
}

/** True when ANY published version of the question is referenced (F-QST-11). */
async function isQuestionInUse(db: Db, questionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: evaluationItems.id })
    .from(evaluationItems)
    .innerJoin(questionVersions, eq(evaluationItems.questionVersionId, questionVersions.id))
    .where(eq(questionVersions.questionId, questionId))
    .limit(1);
  return row !== undefined;
}

/**
 * Soft delete (F-QST-11): the question leaves the pool but its published
 * versions stay readable, because an evaluation may have frozen one. A
 * question an evaluation still points at cannot be removed at all.
 */
export async function softDeleteQuestion(db: Db, question: QuestionRecord): Promise<void> {
  if (await isQuestionInUse(db, question.id)) throw new VersionInUse();
  const now = new Date();
  await db
    .update(questions)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(questions.id, question.id));
}

/** `?hard=1`: the rows really go away (cascade on versions and tags). */
export async function hardDeleteQuestion(db: Db, question: QuestionRecord): Promise<void> {
  if (await isQuestionInUse(db, question.id)) throw new VersionInUse();
  await db.delete(questions).where(eq(questions.id, question.id));
}

/**
 * Copies a question into a pool: metadata, tags and the CURRENT draft — not
 * the history, which belongs to the original. The copy keeps a pointer to
 * its origin so a teacher can tell where it came from.
 */
export async function copyQuestion(
  db: Db,
  question: QuestionRecord,
  input: { targetPoolId: string; categoryId?: string | null; userId: string },
): Promise<string> {
  const draft = await draftOf(db, question.id);
  const tags = (await tagsOf(db, [question.id])).get(question.id) ?? [];
  const id = randomUUID();
  const now = new Date();
  const name = await freeName(db, input.targetPoolId, question.internalName);
  await db.transaction(async (tx) => {
    await tx.insert(questions).values({
      id,
      poolId: input.targetPoolId,
      type: question.type,
      internalName: name,
      categoryId: input.categoryId ?? null,
      difficulty: question.difficulty,
      shuffleable: question.shuffleable,
      randomizable: question.randomizable,
      createdBy: input.userId,
      originQuestionId: question.id,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(questionVersions).values({
      id: randomUUID(),
      questionId: id,
      number: null,
      config: draft.config,
      configVersion: draft.configVersion,
      explanation: draft.explanation,
      searchText: searchTextOf(question.type, name, draft.config),
      updatedAt: now,
      createdAt: now,
    });
    if (tags.length) {
      await tx.insert(questionTags).values(tags.map((tag) => ({ questionId: id, tag })));
      // The copy may land in another pool, whose vocabulary learns the tags.
      await ensurePoolTags(tx, input.targetPoolId, tags);
    }
  });
  return id;
}

/**
 * `questions_pool_name_uq` is case-insensitive and per pool: a copy landing
 * next to its original needs a name of its own, chosen here rather than
 * discovered as a 409 by the teacher.
 */
async function freeName(db: Db, poolId: string, name: string): Promise<string> {
  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? name : n === 1 ? `${name} (copy)` : `${name} (copy ${n})`;
    const [taken] = await db
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.poolId, poolId),
          isNull(questions.deletedAt),
          sql`lower(${questions.internalName}) = lower(${candidate})`,
        ),
      )
      .limit(1);
    if (!taken) return candidate;
  }
  return `${name} ${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Moving questions between pools (ADR-017)
// ---------------------------------------------------------------------------

/** One course that plays a question being moved, with its classrooms. */
interface UsingCourse {
  courseId: string;
  courseName: string;
  courseCode: string;
  classrooms: { id: string; name: string }[];
}

/**
 * Which COURSES play one of these questions, through an evaluation item
 * frozen on one of their versions.
 *
 * `evaluation_items`, `evaluations` and `classrooms` belong to other modules;
 * they are read by join here and never written (CLAUDE.md, Conventions) —
 * exactly as `isQuestionInUse` above already does.
 *
 * A move does not break those items: the version rows stay, and the item
 * points at a version, not at a pool. What it DOES break is the course's
 * ability to reach the question again — to add it to the next evaluation, to
 * re-freeze it on a newer version — because that goes through `course_pools`.
 * Hence the list, and the 409 the route builds from it.
 */
export async function coursesUsingQuestions(
  db: Db,
  questionIds: readonly string[],
): Promise<UsingCourse[]> {
  if (questionIds.length === 0) return [];
  const rows = await db
    .selectDistinct({
      courseId: courses.id,
      courseName: courses.name,
      courseCode: courses.code,
      classroomId: classrooms.id,
      classroomName: classrooms.name,
    })
    .from(evaluationItems)
    .innerJoin(questionVersions, eq(evaluationItems.questionVersionId, questionVersions.id))
    .innerJoin(evaluations, eq(evaluationItems.evaluationId, evaluations.id))
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(inArray(questionVersions.questionId, [...questionIds]))
    .orderBy(asc(courses.code), asc(classrooms.name));
  const byCourse = new Map<string, UsingCourse>();
  for (const row of rows) {
    const found = byCourse.get(row.courseId) ?? {
      courseId: row.courseId,
      courseName: row.courseName,
      courseCode: row.courseCode,
      classrooms: [],
    };
    if (!found.classrooms.some((c) => c.id === row.classroomId)) {
      found.classrooms.push({ id: row.classroomId, name: row.classroomName });
    }
    byCourse.set(row.courseId, found);
  }
  return [...byCourse.values()];
}

/** Which of these courses already draw from the pool (`course_pools`). */
export async function coursesLinkedToPool(
  db: Db,
  poolId: string,
  courseIds: readonly string[],
): Promise<Set<string>> {
  if (courseIds.length === 0) return new Set();
  const rows = await db
    .select({ courseId: coursePools.courseId })
    .from(coursePools)
    .where(and(eq(coursePools.poolId, poolId), inArray(coursePools.courseId, [...courseIds])));
  return new Set(rows.map((r) => r.courseId));
}

/** The course ids, among these, the user holds a staff seat on. */
export async function staffSeatsOf(
  db: Db,
  userId: string,
  courseIds: readonly string[],
): Promise<Set<string>> {
  if (courseIds.length === 0) return new Set();
  const rows = await db
    .select({ courseId: courseStaff.courseId })
    .from(courseStaff)
    .where(and(eq(courseStaff.userId, userId), inArray(courseStaff.courseId, [...courseIds])));
  return new Set(rows.map((r) => r.courseId));
}

/**
 * Moves questions into a pool, with their tags, in ONE transaction.
 *
 * The question keeps its id, its internal name, its versions, its draft and
 * its history: only `pool_id` and `category_id` change. That is the whole
 * point — an evaluation item frozen on version 3 of this very question goes
 * on resolving, and a teacher who moved a question by mistake moves it back.
 *
 * Three things travel with it and are worth naming:
 *   - the TAGS stay on `question_tags` (they are the question's), and the
 *     target pool's vocabulary learns them through `ensurePoolTags`, the same
 *     way a copy teaches them (ADR-017). The source pool keeps its `pool_tags`
 *     rows — a teacher's one-line description of "pointeurs" is documentation
 *     of the pool, not of the question that left;
 *   - the ASSETS keep their `assets.pool_id`: they are addressed by id and
 *     served by the asset route, which authorizes through the ATTEMPT or the
 *     pool the caller reaches — moving the rows would be a second, silent
 *     write into the source pool for no gain;
 *   - the CATEGORY of the source pool is dropped; the caller passes a
 *     category OF THE TARGET, or null for its root.
 *
 * `linkCourseIds` is the explicit second half of the operation (`linkCourses`
 * of `MoveBody`): the courses the route decided the caller may link, added to
 * `course_pools` in the same transaction as the move, so a question is never
 * momentarily out of the reach of the classroom that plays it.
 */
export async function moveQuestions(
  db: Db,
  input: {
    questions: QuestionRecord[];
    targetPoolId: string;
    categoryId: string | null;
    linkCourseIds?: readonly string[];
  },
): Promise<void> {
  const ids = input.questions.map((q) => q.id);
  if (ids.length === 0) return;
  await assertNamesFree(db, input.targetPoolId, input.questions);
  const tags = [...new Set([...(await tagsOf(db, ids)).values()].flat())];
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(questions)
      .set({ poolId: input.targetPoolId, categoryId: input.categoryId, updatedAt: now })
      .where(inArray(questions.id, ids));
    await ensurePoolTags(tx, input.targetPoolId, tags);
    const links = [...new Set(input.linkCourseIds ?? [])];
    if (links.length) {
      await tx
        .insert(coursePools)
        .values(links.map((courseId) => ({ courseId, poolId: input.targetPoolId })))
        .onConflictDoNothing();
    }
  });
}

/**
 * `questions_pool_name_uq` is per pool and case-insensitive. Checked here
 * rather than caught as a unique violation, because the answer has to NAME
 * the questions that clash, and because a batch can clash with itself: two
 * questions called `ptr-01` coming from two different pools.
 */
async function assertNamesFree(
  db: Db,
  targetPoolId: string,
  moving: QuestionRecord[],
): Promise<void> {
  const seen = new Map<string, string>();
  const clashing = new Set<string>();
  for (const q of moving) {
    const key = q.internalName.toLowerCase();
    if (seen.has(key)) clashing.add(q.internalName);
    else seen.set(key, q.internalName);
  }
  const taken = await db
    .select({ internalName: questions.internalName })
    .from(questions)
    .where(
      and(
        eq(questions.poolId, targetPoolId),
        isNull(questions.deletedAt),
        inArray(sql`lower(${questions.internalName})`, [...seen.keys()]),
        // A question already in the target pool is being re-filed, not moved
        // in: it cannot clash with itself.
        notInArray(questions.id, moving.map((q) => q.id)),
      ),
    );
  for (const row of taken) clashing.add(row.internalName);
  if (clashing.size) throw new MoveNameTaken([...clashing].sort());
}
