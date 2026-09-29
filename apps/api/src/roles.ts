/**
 * Global role, computed from the database in ONE place (SSOT).
 *
 * admin (SUPER_ADMIN_EMAIL) > teacher > student, where "teacher" means an
 * admin-managed `teacher_grants` row, a seat on the staff of at least one
 * course, or a `staff` affiliation scoped to one of STAFF_AFFILIATION_DOMAINS.
 *
 * The rule is keyed on the account's VERIFIED e-mail ADDRESSES (and, when
 * the account exists, its course seats), never on the current `users.role`, so
 * recomputing is idempotent and can never demote an admin nor a teacher who
 * still holds a grant. It reads the whole address set: a grant issued on an
 * institutional address must apply to someone signing in under a private one.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { RoleReason } from "@quiz/contracts";

import { affiliationKindsIn } from "./auth/claims.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import {
  STAFF_ROLES,
  courseStaff,
  teacherGrants,
  userEmails,
  userIdpClaims,
  users,
} from "./db/schema.js";
import { knownEmails, normalizeEmail, ownersOf } from "./identity.js";
import { holdsCourseSeat } from "./modules/org/service.js";
import { transferOnLoss, vacateSeats } from "./modules/pool/service.js";
import { accessRevoked } from "./modules/realtime/bus.js";

type UserRole = (typeof users.$inferSelect)["role"];

/** What the rule needs: the addresses of the account, and its affiliations. */
export interface Identity {
  /** Verified addresses only (`knownEmails`). */
  emails: readonly string[];
  /** edu-ID affiliations, scoped or not (`student@hes-so.ch`, `staff`). */
  affiliations?: readonly string[];
  /** Existing account id, when there is one: course seats are keyed on it. */
  userId?: string;
}

/** The role, and which branch of the rule gave it (`null` for a student). */
export interface RoleDecision {
  role: UserRole;
  reason: RoleReason | null;
}

/**
 * The facts the rule reads, however they were loaded: one account at a time
 * (`roleForIdentity`, at every login and role change) or every account at
 * once (`roleDecisionsOfAll`, for the administration list).
 */
interface RoleFacts {
  /** Normalized, non-empty. */
  emails: readonly string[];
  affiliations: readonly string[];
  /** A `teacher_grants` row holds one of `emails`. */
  hasGrant: boolean;
  /** The account holds a seat on at least one course staff. */
  hasSeat: boolean;
}

/** THE rule. Pure: every caller loads the facts, none re-derives the rule. */
function decideRole(config: AppConfig, facts: RoleFacts): RoleDecision {
  if (config.SUPER_ADMIN_EMAIL && facts.emails.includes(normalizeEmail(config.SUPER_ADMIN_EMAIL))) {
    return { role: "admin", reason: "super_admin" };
  }
  if (facts.hasGrant) return { role: "teacher", reason: "grant" };
  // A seat on a course staff is a teacher role, so a colleague added by
  // another teacher does not need an admin grant as well.
  if (facts.hasSeat) return { role: "teacher", reason: "course_seat" };
  // edu-ID tells us who is staff. A `staff` affiliation WITHOUT a `student`
  // one is an employee, and reaches the teacher UI without an invitation.
  // Their own courses only: the guards are unchanged, so this grants no
  // access to anyone else's. Only affiliations scoped to OUR institutions
  // count, both ways: a `staff@unige.ch` is somebody else's employee, and a
  // bare `staff` names no institution at all — neither makes a teacher.
  const kinds = affiliationKindsIn(facts.affiliations, config.STAFF_AFFILIATION_DOMAINS);
  if (kinds.includes("staff") && !kinds.includes("student")) {
    return { role: "teacher", reason: "staff_affiliation" };
  }
  return { role: "student", reason: null };
}

function normalizedSet(emails: readonly string[]): string[] {
  return [...new Set(emails.map(normalizeEmail))].filter((e) => e !== "");
}

export async function roleForIdentity(
  db: Db,
  config: AppConfig,
  identity: Identity,
): Promise<RoleDecision> {
  const emails = normalizedSet(identity.emails);
  // Both lookups at once: this runs at every sign-in.
  const [[grant], hasSeat] = await Promise.all([
    emails.length > 0
      ? db
          .select({ id: teacherGrants.id })
          .from(teacherGrants)
          .where(inArray(teacherGrants.email, emails))
          .limit(1)
      : [],
    identity.userId ? holdsCourseSeat(db, identity.userId) : false,
  ]);
  return decideRole(config, {
    emails,
    affiliations: identity.affiliations ?? [],
    hasGrant: grant !== undefined,
    hasSeat,
  });
}

/**
 * The decision for EVERY non-anonymized account, keyed by id: the facts of
 * `roleForUser` (verified addresses, stored affiliations, grants, seats)
 * loaded in five queries whatever the number of accounts — the addresses
 * and claims of anonymized accounts left out — then the same
 * `decideRole`. For the administration list, which shows why each account
 * is what it is.
 */
export async function roleDecisionsOfAll(
  db: Db,
  config: AppConfig,
): Promise<Map<string, RoleDecision>> {
  const [accounts, addresses, grants, seats, claims] = await Promise.all([
    db.select({ id: users.id }).from(users).where(isNull(users.anonymizedAt)),
    db
      .select({ userId: userEmails.userId, email: userEmails.email })
      .from(userEmails)
      .innerJoin(users, eq(users.id, userEmails.userId))
      .where(and(eq(userEmails.verified, true), isNull(users.anonymizedAt))),
    db.select({ email: teacherGrants.email }).from(teacherGrants),
    db.selectDistinct({ userId: courseStaff.userId }).from(courseStaff),
    db
      .select({ userId: userIdpClaims.userId, affiliations: userIdpClaims.affiliations })
      .from(userIdpClaims)
      .innerJoin(users, eq(users.id, userIdpClaims.userId))
      .where(isNull(users.anonymizedAt)),
  ]);
  const emailsOf = new Map<string, string[]>();
  for (const a of addresses) emailsOf.set(a.userId, [...(emailsOf.get(a.userId) ?? []), a.email]);
  const granted = new Set(grants.map((g) => g.email));
  const seated = new Set(seats.map((s) => s.userId));
  const affiliationsOf = new Map(claims.map((c) => [c.userId, c.affiliations]));

  return new Map(
    accounts.map(({ id }) => {
      const emails = normalizedSet(emailsOf.get(id) ?? []);
      return [
        id,
        decideRole(config, {
          emails,
          affiliations: affiliationsOf.get(id) ?? [],
          hasGrant: emails.some((e) => granted.has(e)),
          hasSeat: seated.has(id),
        }),
      ];
    }),
  );
}

/** The stored identity of an existing account. */
async function roleForUser(
  db: Db,
  config: AppConfig,
  userId: string,
): Promise<RoleDecision> {
  const [stored] = await db
    .select({ affiliations: userIdpClaims.affiliations })
    .from(userIdpClaims)
    .where(eq(userIdpClaims.userId, userId))
    .limit(1);
  return roleForIdentity(db, config, {
    // Every address the account ever had verified: the set never shrinks.
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
 * (F-POOL-05) is wired here and not in `modules/admin/`: revoking a grant
 * is only one of the two ways the role falls (`org/routes.ts` removes the last
 * staff seat through `syncRoleOfUser`), and an account is NEVER deleted —
 * "removed from the system" means exactly "no longer teacher nor admin".
 *
 * The consequences of a demotion run BEFORE the role is stored: the loss is
 * noticed by comparing with the stored role, so a failure half-way leaves the
 * account as it was and the admin action fails. A later deliberate sync that
 * computes the same loss runs them again (`transferOnLoss` and `vacateSeats`
 * are idempotent). Not every failure gets one: a revoked grant is already
 * gone, and a login stores `student` without succession, so the account may
 * keep its seats until an admin acts again. Stored first, a failed succession
 * would never be retried at all.
 *
 * A LOGIN stores the role with `succession: false`: what the IdP releases
 * may vary from one login to the next, and ADR-013 ties the handover to the
 * two deliberate actions above, never to a login. The pools stay with their
 * owner, and the seats with their members, until one of those actions runs.
 */
interface StoreOptions {
  /**
   * Apply the consequences of a DELIBERATE demotion below staff: the owned
   * pools pass on and every pool seat is lost (ADR-013, rule 5). False for
   * a login, which only stores the role.
   */
  succession?: boolean;
}

/** Privilege order: a move down is a loss of access. */
const RANK: Record<UserRole, number> = { student: 0, teacher: 1, admin: 2 };

async function storeRole(
  db: Db,
  userId: string,
  role: UserRole,
  { succession = true }: StoreOptions = {},
): Promise<void> {
  const [before] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const lost = before !== undefined && RANK[role] < RANK[before.role];
  if (lost && succession && !(STAFF_ROLES as readonly string[]).includes(role)) {
    // The pools they own pass on first, then every seat they held goes: a
    // demoted member does not get it back with the role (ADR-013, rule 5).
    await transferOnLoss(db, userId);
    await vacateSeats(db, userId);
  }
  await db.update(users).set({ role }).where(eq(users.id, userId));
  // A privilege was lost: `admin`, or every `teacher:`/`course:`/`pool:`
  // topic with the teacher role (#248).
  if (lost) accessRevoked([userId]);
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
    // An account from before the address set: its login address, and only
    // when the IdP verified it.
    const legacy = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, normalized), eq(users.emailVerified, true)));
    owners.push(...legacy.map((u) => u.id));
  }
  for (const userId of owners) {
    await storeRole(db, userId, (await roleForUser(db, config, userId)).role);
  }
  return owners.length;
}

/** Recomputes one account's role (after a course-staff change, or a login). */
export async function syncRoleOfUser(
  db: Db,
  config: AppConfig,
  userId: string,
  options: StoreOptions = {},
): Promise<void> {
  await storeRole(db, userId, (await roleForUser(db, config, userId)).role, options);
}
