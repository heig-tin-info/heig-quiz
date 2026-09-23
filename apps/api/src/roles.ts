/**
 * Global role, computed from the database in ONE place (SSOT).
 *
 * admin (SUPER_ADMIN_EMAIL) > teacher > student, where "teacher" means an
 * admin-managed `teacher_grants` row, a seat on the staff of at least one
 * course, or a `staff` affiliation at the IdP.
 *
 * The rule is keyed on the account's e-mail ADDRESSES (and, when the account
 * exists, its course seats), never on the current `users.role`, so
 * recomputing is idempotent and can never demote an admin nor a teacher who
 * still holds a grant. It reads the whole address set: a grant issued on an
 * institutional address must apply to someone signing in under a private one.
 */
import { eq, inArray } from "drizzle-orm";

import { affiliationKinds } from "./auth/claims.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { courseStaff, teacherGrants, userIdpClaims, users } from "./db/schema.js";
import { knownEmails, normalizeEmail, ownersOf } from "./identity.js";
import { transferOnLoss } from "./modules/pool/service.js";

type UserRole = (typeof users.$inferSelect)["role"];

/** What the rule needs: the addresses of the account, and its affiliations. */
export interface Identity {
  emails: readonly string[];
  /** edu-ID affiliations, scoped or not (`student@hes-so.ch`, `staff`). */
  affiliations?: readonly string[];
  /** Existing account id, when there is one: course seats are keyed on it. */
  userId?: string;
}

export async function roleForIdentity(
  db: Db,
  config: AppConfig,
  identity: Identity,
): Promise<UserRole> {
  const emails = [...new Set(identity.emails.map(normalizeEmail))].filter((e) => e !== "");
  if (config.SUPER_ADMIN_EMAIL && emails.includes(normalizeEmail(config.SUPER_ADMIN_EMAIL))) {
    return "admin";
  }
  if (emails.length > 0) {
    const [grant] = await db
      .select({ id: teacherGrants.id })
      .from(teacherGrants)
      .where(inArray(teacherGrants.email, emails))
      .limit(1);
    if (grant) return "teacher";
  }
  // A seat on a course staff is a teacher role, so a colleague added by
  // another teacher does not need an admin grant as well.
  if (identity.userId) {
    const [seat] = await db
      .select({ courseId: courseStaff.courseId })
      .from(courseStaff)
      .where(eq(courseStaff.userId, identity.userId))
      .limit(1);
    if (seat) return "teacher";
  }
  // edu-ID tells us who is staff. A `staff` affiliation WITHOUT a `student`
  // one is an employee, and reaches the teacher UI without an invitation.
  // Their own courses only: the guards are unchanged, so this grants no
  // access to anyone else's.
  const kinds = affiliationKinds(identity.affiliations ?? []);
  if (kinds.includes("staff") && !kinds.includes("student")) return "teacher";
  return "student";
}

/** The stored identity of an existing account. */
async function roleForUser(
  db: Db,
  config: AppConfig,
  userId: string,
): Promise<UserRole> {
  const [stored] = await db
    .select({ affiliations: userIdpClaims.affiliations })
    .from(userIdpClaims)
    .where(eq(userIdpClaims.userId, userId))
    .limit(1);
  return roleForIdentity(db, config, {
    emails: await knownEmails(db, userId),
    affiliations: stored?.affiliations ?? [],
    userId,
  });
}

/**
 * THE seam where a computed role is STORED — and therefore the one place
 * that can notice an account LOSING the teacher role.
 *
 * Both entry points below go through it, which is why the pool succession
 * (F-POOL-05) is wired here and not in `modules/admin.ts`: revoking a grant
 * is only one of the two ways the role falls (`courses.ts` removes the last
 * staff seat through `syncRoleOfUser`), and an account is NEVER deleted —
 * "removed from the system" means exactly "no longer teacher nor admin".
 *
 * The transfer runs after the role is stored, so a failure of the succession
 * can never leave an account teacher-by-accident; re-running the sync picks
 * the pools up again (`transferOnLoss` is idempotent).
 */
async function storeRole(db: Db, userId: string, role: UserRole): Promise<void> {
  const [before] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  await db.update(users).set({ role }).where(eq(users.id, userId));
  const was = before?.role === "teacher" || before?.role === "admin";
  const is = role === "teacher" || role === "admin";
  if (was && !is) await transferOnLoss(db, userId);
}

/**
 * Applies the rule to the accounts holding `email`, so a grant/revoke or a
 * staff add/remove takes effect immediately instead of at the next login.
 * No-op when nobody signed up under that address yet (the role is computed
 * again at their first login anyway).
 */
export async function syncUserRole(db: Db, config: AppConfig, email: string): Promise<number> {
  const normalized = normalizeEmail(email);
  const owners = await ownersOf(db, normalized);
  if (owners.length === 0) {
    const legacy = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized));
    owners.push(...legacy.map((u) => u.id));
  }
  for (const userId of owners) {
    await storeRole(db, userId, await roleForUser(db, config, userId));
  }
  return owners.length;
}

/** Recomputes one account's role (after a course-staff change). */
export async function syncRoleOfUser(db: Db, config: AppConfig, userId: string): Promise<void> {
  await storeRole(db, userId, await roleForUser(db, config, userId));
}
