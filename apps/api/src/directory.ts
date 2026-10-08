/**
 * The staff directory: the teacher and admin accounts a colleague may pick
 * by name to seat on a pool (F-POOL-05) or on a course's staff (ADR-068).
 * Teachers knowing their colleagues is institutionally fine; a student never
 * appears here. The modules decide who is already seated; this file only
 * knows who is staff and how a search is matched.
 *
 * A picked account (`findTeacherById`) is resolved the same way for both.
 * An address typed instead is NOT, on purpose: the pool resolves it among
 * staff accounts only (`findTeacherByEmail`, 404 `teacher_not_found`), the
 * course among every account that signed in (`ownersOf`, 409
 * `unknown_account` / `ambiguous_account`).
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { TeacherCandidates } from "@quiz/contracts";

import { likeContains, type Db } from "./db/client.js";
import { STAFF_ROLES, users } from "./db/schema.js";

/**
 * The accounts that may hold a seat, and so hear of a pool: the stored role,
 * as `decideRole` (`roles.ts`) computed it, is staff. A deliberate demotion
 * deletes the pool seats (`vacateSeats`), but a LOGIN that stores `student`
 * keeps them (ADR-013, rule 5), and a demoted pool owner nobody could
 * inherit from keeps `pools.owner_id`: such an account holds a claim, never
 * the rights nor the news.
 */
export const isStaff = inArray(users.role, [...STAFF_ROLES]);

/** The account behind a pick of a picker — a teacher or an admin, or nobody. */
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
    .where(and(eq(users.id, userId), isStaff))
    .limit(1);
  return row ?? null;
}

/**
 * The staff accounts matched on name or address, minus those `unseated`
 * rules out (the caller's "already holds a seat here"). Ten rows at most —
 * a picker is searched, not browsed — in family-name order.
 */
export async function searchTeachers(db: Db, q: string, ...unseated: SQL[]): Promise<TeacherCandidates> {
  const needle = likeContains(q.trim().toLowerCase());
  return db
    .select({
      userId: users.id,
      email: users.email,
      givenName: users.givenName,
      familyName: users.familyName,
    })
    .from(users)
    .where(
      and(
        isStaff,
        ...unseated,
        sql`lower(${users.givenName} || ' ' || ${users.familyName} || ' ' || ${users.email}) LIKE ${needle}`,
      ),
    )
    .orderBy(asc(users.familyName), asc(users.givenName), asc(users.email))
    .limit(10);
}
