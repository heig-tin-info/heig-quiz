import { randomUUID } from "node:crypto";

import { eq, isNull, sql } from "drizzle-orm";

import type { AdminUser } from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { avatars, classrooms, courseStaff, pools, questions, teacherGrants, users } from "../../db/schema.js";
import { normalizeEmail } from "../../identity.js";
import { shownAvatar } from "../avatar.js";
import { roleDecisionsOfAll } from "../../roles.js";

/**
 * Every account that is not anonymized (F-ADMIN-01), with its teaching
 * footprint and why it holds its role.
 *
 * One statement for the rows and their counts (correlated subqueries, no
 * N+1), plus the few bulk reads of `roleDecisionsOfAll`. No pagination: the
 * platform has a few hundred accounts, a row is a few hundred bytes, and the
 * reason is computed in memory for each row anyway — the client searches,
 * filters and sorts the one response.
 *
 * The reason is the rule's (`roles.ts`), never re-derived here. It is shown
 * only when the rule still gives the stored role: a stored role the rule no
 * longer gives (an edu-ID affiliation that changed, a new super-admin
 * address) is fixed at the next sign-in, and until then there is no reason
 * to state.
 */
export async function listUsers(db: Db, config: AppConfig): Promise<AdminUser[]> {
  // Qualified by hand: drizzle drops the table name on a one-table select,
  // and a bare `id` is ambiguous inside the subqueries.
  const uid = sql`${users}.id`;
  const [rows, decisions] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        givenName: users.givenName,
        familyName: users.familyName,
        role: users.role,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        pictureUrl: users.pictureUrl,
        avatarAt: avatars.updatedAt,
        pools: sql<number>`(SELECT count(*) FROM ${pools} p WHERE p.owner_id = ${uid})::int`,
        questions: sql<number>`(SELECT count(*) FROM ${questions} q JOIN ${pools} p ON p.id = q.pool_id
          WHERE p.owner_id = ${uid} AND q.deleted_at IS NULL)::int`,
        classrooms: sql<number>`(SELECT count(*) FROM ${classrooms} c JOIN ${courseStaff} cs ON cs.course_id = c.course_id
          WHERE cs.user_id = ${uid} AND c.archived_at IS NULL)::int`,
      })
      .from(users)
      .leftJoin(avatars, eq(avatars.userId, users.id))
      .where(isNull(users.anonymizedAt))
      .orderBy(users.familyName, users.givenName, users.email),
    roleDecisionsOfAll(db, config),
  ]);
  return rows.map(({ pictureUrl, avatarAt, ...r }) => {
    const decision = decisions.get(r.id);
    return {
      ...r,
      avatarUrl: shownAvatar(r.id, avatarAt, pictureUrl),
      reason: decision?.role === r.role ? decision.reason : null,
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/**
 * THE writer of a teacher grant: one per address, normalized. Returns the
 * new row, or undefined when the address already holds one; the caller
 * recomputes the role and audits. The heig-classroom import (M1-06) gives
 * `id` and `createdAt`, the source's.
 */
export async function createTeacherGrant(
  db: Db | Tx,
  grant: { email: string; createdBy: string; id?: string; createdAt?: Date },
): Promise<typeof teacherGrants.$inferSelect | undefined> {
  const [created] = await db
    .insert(teacherGrants)
    .values({
      id: grant.id ?? randomUUID(),
      email: normalizeEmail(grant.email),
      createdBy: grant.createdBy,
      ...(grant.createdAt ? { createdAt: grant.createdAt } : {}),
    })
    .onConflictDoNothing({ target: teacherGrants.email })
    .returning();
  return created;
}
