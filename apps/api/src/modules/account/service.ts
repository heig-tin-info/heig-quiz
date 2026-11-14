/**
 * The `account` module (ADR-117, issue #681): the end of an account's
 * identity. `pseudonymizeUser` replaces who a person is and keeps what they
 * did under the same id; `lastActivity` is the last activity the lifecycle
 * reads, `dueForPseudonymization` the one rule of when the lifecycle may
 * pseudonymize, `lifecycleHealth` what the System status reads of it. The
 * daily job is `jobs.ts`, its stages `lifecycle.ts`; the routes
 * (self-service, administration) are `routes.ts`.
 *
 * A module of its own rather than `admin`: two of its three callers are not
 * an administrator (the person, the lifecycle job), and the wipe touches
 * every module's tables through one database function, which belongs to no
 * existing module.
 *
 * THE wipe list is that function, `quiz_pseudonymize_account(user, subject
 * prefix, email, given name, family name, anonymize)`, created by a
 * migration so that production (here: prefix `anon-`, anonymize) and the
 * staging copy (`scripts/staging-pseudonymize.sql`: prefix `staging:`, not
 * anonymized, so a copied account keeps its role and its place in the
 * administration list) run the same list. It writes the tables of several
 * modules: the one exception ADR-117 §8 accepts to "a module writes only its
 * own tables". Changing the list is a migration that replaces the function,
 * under `service.db.test.ts` and `stagingScrub.db.test.ts`.
 *
 * - Replaced: the account's names, address, subject (`<prefix><id>`, which
 *   no identity provider issues), edu-ID identifier, picture, notification
 *   address; its address set (the new address only); the IdP claims (the
 *   affiliations stay: they name nobody); its teacher grant (the first under
 *   one of its addresses takes the new address, any other goes); the roster
 *   lines it claimed (names, address, the teacher's note); its GitHub
 *   identities still positive (the linked account and those recorded on its
 *   roster lines) take a negative id GitHub never issues, `github-user-<n>`.
 * - Deleted: its avatar, Teams link and pending Teams link tokens, sessions
 *   (its own and those it acts through), launch tickets, API and OAuth
 *   tokens, OAuth grants and requests, kiosk pairings in progress,
 *   notifications. When anonymized (production), also its traces of use
 *   (presence hours, last activity, notification and course preferences),
 *   and `anonymized_at` is set, which ends every session and sign-in on the
 *   row.
 * - Kept, under the same id: attempts, answers, the attempt journal,
 *   gradings and their comments, released grades, the gradebook, project
 *   runs, scores and push receipts, codespace launches, LLM calls, drill
 *   data, the repositories' names, the audit logs (ADR-003 §5), course
 *   seats; pool seats and pools until the hand-over (ADR-013 §5).
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNotNull, isNull, lte, not, notInArray, or, sql, type SQL } from "drizzle-orm";

import type { PseudonymizeRefusal } from "@quiz/contracts";
import { HEALTH_THRESHOLDS } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import {
  apiTokens,
  attempts,
  classrooms,
  enrollments,
  evaluations,
  oauthGrants,
  poolMembers,
  pools,
  presenceLastSeen,
  sessions,
  users,
} from "../../db/schema.js";
import { roleForUser } from "../../roles.js";
import { refusalClass, type Refusal } from "../http.js";
import { revokeAccountAccess } from "../org/service.js";
import { handOverPools } from "../pool/service.js";
import { accessRevoked, sessionsEnded } from "../realtime/bus.js";

/** Who asked for a pseudonymization: the inactivity job, the person, an administrator. */
export type PseudonymizedBy = "lifecycle" | "self" | "admin";

/**
 * Why an account is not pseudonymized now: the contract's closed list
 * (`PSEUDONYMIZE_REFUSALS`), which the screens word. `not_due`: the
 * lifecycle's term has not come, or a sign-in ended the dormancy meanwhile.
 * A GitHub access that would not go is the `org` module's `502
 * revoke_failed`.
 */

const REFUSALS: Record<PseudonymizeRefusal, Refusal> = {
  not_found: [404, "No such account"],
  already_anonymized: [409, "This account is already pseudonymized"],
  open_attempt: [409, "This account has an exam attempt in progress"],
  running_classroom: [409, "This account holds a seat in a classroom that is still running"],
  staff: [409, "A staff account is pseudonymized by an administrator only"],
  not_due: [409, "This account is not due for pseudonymization"],
};

export class AccountError extends refusalClass("AccountError", REFUSALS) {}

/** The lifecycle's terms (ADR-117 §3, §10; product owner, 2026-11-05). */
export const LIFECYCLE = {
  /** Years without activity before the notice. */
  noticeAfterYears: 2,
  /** Notices sent in one run at most, the longest unused accounts first. */
  noticesPerRun: 50,
  /** Months from the notice to the reminder. */
  reminderAfterMonths: 9,
  /** Months from the notice to the pseudonymization. */
  pseudonymizeAfterMonths: 12,
  /** Months from the reminder to the pseudonymization: never right after a reminder a paused task sent late. */
  afterReminderMonths: 3,
  /** Pseudonymizations in one run at most; the rest waits for the next day. */
  perRun: 20,
} as const;

/**
 * What production writes in place of the identity. The `anon-` subject is
 * the form the heig-classroom import already treats as a fresh account
 * (`import-classroom/identity.ts`), and no identity provider issues it: a
 * later login makes a new, empty account through admission (ADR-111).
 */
const ANONYMOUS_PREFIX = "anon-";
const anonymousIdentity = (userId: string) => ({
  email: `${ANONYMOUS_PREFIX}${userId}@example.invalid`,
  givenName: "Anonymous",
  familyName: userId.slice(0, 8),
});

/**
 * A staff account (ADR-117 §6): the role rule of `roles.ts` gives it more
 * than student, or it owns a pool or holds a seat in one.
 */
export async function isStaff(db: Db | Tx, config: AppConfig, userId: string): Promise<boolean> {
  if ((await roleForUser(db, config, userId)).role !== "student") return true;
  const [row] = await db
    .select({
      pools: sql<boolean>`EXISTS (SELECT 1 FROM ${pools} WHERE ${pools.ownerId} = ${userId})
        OR EXISTS (SELECT 1 FROM ${poolMembers} WHERE ${poolMembers.userId} = ${userId})`,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row?.pools === true;
}

/** Why the account may not be pseudonymized by `by` now, or null; and whether it is staff. */
async function refusalOf(
  db: Db | Tx,
  config: AppConfig,
  userId: string,
  by: PseudonymizedBy,
  lock: boolean,
): Promise<{ refused: PseudonymizeRefusal | null; staff: boolean }> {
  const query = db
    .select({
      anonymizedAt: users.anonymizedAt,
      due: sql<boolean>`coalesce(${dueForPseudonymization}, false)`,
    })
    .from(users)
    .where(eq(users.id, userId));
  const [user] = lock ? await query.for("update") : await query;
  if (!user) return { refused: "not_found", staff: false };
  if (user.anonymizedAt !== null) return { refused: "already_anonymized", staff: false };
  if (by === "lifecycle" && !user.due) return { refused: "not_due", staff: false };
  // An exam the ticker has not closed yet (invariant 5). An exercise stays
  // open after its due date (#985), its attempt in progress for good: it
  // never blocks.
  const [open] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.state, "in_progress"),
        eq(evaluations.mode, "exam"),
        notInArray(evaluations.state, ["closed", "grading", "released"]),
      ),
    )
    .limit(1);
  if (open) return { refused: "open_attempt", staff: false };
  // A classroom runs until the end of its last month; an undated one never
  // blocks (product owner, 2026-11-05). The database's clock.
  const [running] = await db
    .select({ id: classrooms.id })
    .from(enrollments)
    .innerJoin(classrooms, eq(classrooms.id, enrollments.classroomId))
    .where(
      and(
        eq(enrollments.userId, userId),
        isNull(classrooms.archivedAt),
        isNotNull(classrooms.periodEnd),
        sql`${classrooms.periodEnd} >= to_char(now(), 'YYYY-MM')`,
      ),
    )
    .limit(1);
  if (running) return { refused: "running_classroom", staff: false };
  const staff = await isStaff(db, config, userId);
  if (staff && by !== "admin") return { refused: "staff", staff };
  return { refused: null, staff };
}

export interface PseudonymizeContext {
  by: PseudonymizedBy;
  /** Who acts, for the audit entries: the system for the lifecycle, the person, the administrator. */
  actor: AuditActor;
  config: AppConfig;
  log: FastifyBaseLogger;
  /** The server's instant, for the GitHub revocations' trace. */
  now: Date;
}

/**
 * Pseudonymizes account `userId` (ADR-117, amended by the product owner on
 * 2026-11-05). Refused ({@link AccountError}) for an account already
 * pseudonymized, with an exam attempt in progress, with a seat in a
 * classroom still running, or — unless an administrator asks — a staff
 * account; the lifecycle's call also when its term has not come.
 *
 * The guards are checked once without a lock, which spares one for a
 * refusal; then its GitHub accesses are revoked as a roster removal's
 * (`org` service; `502 revoke_failed` stops it, nothing written); then, in
 * one transaction on the locked row, the guards again (a sign-in may have
 * come between), the wipe list, the audit entry `user.anonymized`, which
 * names the id only. After the commit, its open streams close and, for a
 * staff account, its pools pass on (ADR-013 §5; its course seats stay).
 */
export async function pseudonymizeUser(db: Db, userId: string, ctx: PseudonymizeContext): Promise<void> {
  const before = await refusalOf(db, ctx.config, userId, ctx.by, false);
  if (before.refused) throw new AccountError(before.refused);
  // Outside the transaction, as a roster removal's (ADR-117 §10): its
  // `revoking_at` must be seen by a concurrent invitation. Should the locked
  // re-check below then refuse (a sign-in or an exam attempt raced it, a
  // window of milliseconds), the account keeps its data but has lost its
  // GitHub repository access, which the student gets back through "Request
  // access" (the on-demand pull of #899). Accepted.
  await revokeAccountAccess(db, userId, { config: ctx.config, actor: ctx.actor, now: ctx.now, log: ctx.log });
  const { staff, ended } = await db.transaction(async (tx) => {
    const now = await refusalOf(tx, ctx.config, userId, ctx.by, true);
    if (now.refused) throw new AccountError(now.refused);
    const gone = await tx
      .select({ sidHash: sessions.sidHash })
      .from(sessions)
      .where(or(eq(sessions.userId, userId), eq(sessions.actorUserId, userId)));
    const anonymous = anonymousIdentity(userId);
    await tx.execute(
      sql`SELECT quiz_pseudonymize_account(${userId}::uuid, ${ANONYMOUS_PREFIX}, ${anonymous.email},
        ${anonymous.givenName}, ${anonymous.familyName}, true)`,
    );
    await audit(tx, {
      ...ctx.actor,
      action: "user.anonymized",
      subjectType: "user",
      subjectId: userId,
      payload: { userId, by: ctx.by },
    });
    return { staff: now.staff, ended: gone.map((s) => s.sidHash) };
  });
  // Its open streams, and those of anyone who acted through it, close.
  sessionsEnded(ended);
  accessRevoked([userId]);
  // After the commit: the hand-over notifies; the heir's notice names the pseudonym.
  if (staff) await handOverPools(db, userId, "owner_pseudonymized");
}

/**
 * The last activity of an account, for the lifecycle (product owner,
 * 2026-11-05, decision 9): the latest of its last sign-in, its last own
 * request (`presence_last_seen`, never an impersonation's), and the last
 * use of its personal or OAuth tokens and OAuth grants; its creation when
 * none. A column expression on `users`, for a query over every account.
 */
export const lastActivity = (): SQL<Date> =>
  // Qualified by hand: drizzle drops the table name on a one-table select,
  // and a bare `id` would be the subquery's own.
  sql<Date>`coalesce(greatest(
    ${users}.last_login_at,
    (SELECT p.at FROM ${presenceLastSeen} p WHERE p.user_id = ${users}.id),
    (SELECT max(t.last_used_at) FROM ${apiTokens} t WHERE t.user_id = ${users}.id),
    (SELECT max(g.last_used_at) FROM ${oauthGrants} g WHERE g.user_id = ${users}.id)
  ), ${users}.created_at)`.mapWith(users.createdAt);

/**
 * A dormant account used since its notice (a token, or a session opened
 * before it): the dormancy is over, as a sign-in would have ended it.
 */
export const usedSinceNotice: SQL = sql`${lastActivity()} > ${users.inactivityNotifiedAt}`;

/**
 * Due for pseudonymization at `lateDays` past the term (ADR-117 §3, §10):
 * twelve months after the notice, three after the reminder, and no
 * activity since the notice (a token or a session used meanwhile ends the
 * dormancy as a sign-in does). The database's clock.
 */
function duePast(lateDays: number, activity: SQL = lastActivity()): SQL {
  const ago = (months: number) => sql`now() - make_interval(months => ${months}, days => ${lateDays})`;
  return and(
    lte(users.inactivityNotifiedAt, ago(LIFECYCLE.pseudonymizeAfterMonths)),
    lte(users.inactivityRemindedAt, ago(LIFECYCLE.afterReminderMonths)),
    not(sql`${activity} > ${users.inactivityNotifiedAt}`),
  )!;
}

/**
 * THE rule of when the lifecycle may pseudonymize an account: the locked
 * re-check of `pseudonymizeUser`, the job's selection and the System
 * status's count read this one condition on `users`.
 */
export const dueForPseudonymization: SQL = duePast(0);

/**
 * What the administration flags as due (ADR-117 §6), on the account's last
 * activity `activity` (`lastActivity()`, or a column a query computed from
 * it once): due for the lifecycle; or a staff account (by the stored role,
 * the one the list shows), which the lifecycle never notifies, without
 * activity for as long as the notice and its term add up to (three years).
 * A student is due only by its notice: the horizon counts from the notice,
 * and imported students carry old dates (ADR-117 §3).
 */
export function dueForReview(activity: SQL = lastActivity()): SQL<boolean> {
  const pastHorizon = sql`${users.role} <> 'student' AND ${users.inactivityNotifiedAt} IS NULL AND ${activity} <= now()
    - make_interval(years => ${LIFECYCLE.noticeAfterYears}, months => ${LIFECYCLE.pseudonymizeAfterMonths})`;
  return sql<boolean>`coalesce(${duePast(0, activity)}, false) OR coalesce(${pastHorizon}, false)`;
}

/**
 * What the System status's `accounts` check reads (ADR-117 §10): the
 * accounts due for pseudonymization now, and those still not pseudonymized
 * {@link HEALTH_THRESHOLDS.accountLateDays} days past their term, whatever
 * the cause (a refusal, GitHub, the cap).
 */
export async function lifecycleHealth(db: Db): Promise<{ due: number; late: number }> {
  const late = duePast(HEALTH_THRESHOLDS.accountLateDays);
  const [row] = await db
    .select({
      due: sql<number>`count(*) FILTER (WHERE ${dueForPseudonymization})::int`,
      late: sql<number>`count(*) FILTER (WHERE ${late})::int`,
    })
    .from(users)
    .where(isNull(users.anonymizedAt));
  return { due: row?.due ?? 0, late: row?.late ?? 0 };
}
