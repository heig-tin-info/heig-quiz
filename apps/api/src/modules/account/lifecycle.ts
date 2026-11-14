/**
 * The student lifecycle (ADR-117 §3, §10; product owner, 2026-11-05): what
 * the daily `accounts.lifecycle` task does. Every instant is the database's
 * (`now()`), never the process's nor a client's; the terms are `LIFECYCLE`
 * and the rule of a due pseudonymization `dueForPseudonymization`, both in
 * `service.ts`.
 *
 * One run, in order:
 *  1. an account dormant that was used since its notice (a session older
 *     than the notice, a personal or OAuth token), or that became staff
 *     since (a role, a grant, a pool seat), is active again: both dates go,
 *     as a sign-in's do. Left dormant, a staff account would stay due and
 *     refused for good;
 *  2. the **notice**: a student account, not pseudonymized, not dormant,
 *     whose last activity (`lastActivity`) is two years old gets the
 *     `account_dormant` e-mail (`notice`) and is dormant from then on, at
 *     most `noticesPerRun` a run, the longest unused first;
 *  3. the **reminder**, nine months after the notice (`reminder`);
 *  4. the **pseudonymization**, through `pseudonymizeUser`, at most
 *     `perRun` a run, the oldest notices first. A refusal (`not_due`,
 *     `open_attempt`, `running_classroom`, `staff`) or a `502 revoke_failed`
 *     is logged with the account's id and tried again the next day.
 *
 * An e-mail stage marks only the accounts whose e-mail the queue accepted:
 * an account is never dormant without having been told. A crash between
 * the two repeats a notice the next day, which is accepted.
 *
 * A staff account (`isStaff`, ADR-117 §6) is never notified nor reminded
 * here, and `pseudonymizeUser` refuses it to the lifecycle anyway: the
 * administration lists them. The administrators hear of the lifecycle
 * through the System status's `accounts` check (`lifecycleHealth`).
 */
import type { FastifyBaseLogger } from "fastify";
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";

import { SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { classrooms, enrollments, users } from "../../db/schema.js";
import { DomainError } from "../http.js";
import { notifyManyEnqueued } from "../notifications/service.js";
import {
  AccountError,
  dueForPseudonymization,
  isStaff,
  lastActivity,
  LIFECYCLE,
  pseudonymizeUser,
  usedSinceNotice,
} from "./service.js";

const notPseudonymized = isNull(users.anonymizedAt);

/** A student by its stored role, no notice yet, no activity for two years. */
const dueForNotice: SQL = and(
  notPseudonymized,
  eq(users.role, "student"),
  isNull(users.inactivityNotifiedAt),
  sql`${lastActivity()} <= now() - make_interval(years => ${LIFECYCLE.noticeAfterYears})`,
)!;

/** Dormant for nine months, and not reminded yet. */
const dueForReminder: SQL = and(
  notPseudonymized,
  eq(users.role, "student"),
  lte(users.inactivityNotifiedAt, sql`now() - make_interval(months => ${LIFECYCLE.reminderAfterMonths})`),
  isNull(users.inactivityRemindedAt),
)!;

interface LifecycleContext {
  config: AppConfig;
  log: FastifyBaseLogger;
  /** The server's instant, for the GitHub revocations' trace only. */
  now: Date;
}

/** What one run did, for the scheduled tasks screen. */
interface LifecycleRun {
  /** False when `ACCOUNT_LIFECYCLE` is off: nothing was read nor written. */
  enabled: boolean;
  reactivated: number;
  notified: number;
  reminded: number;
  pseudonymized: number;
  /** Due accounts skipped this run (a refusal, a GitHub failure). */
  skipped: number;
  /** Due accounts left for the next run by the cap. */
  deferred: number;
}

/**
 * One stage of the e-mail: up to `limit` student accounts `due` matches, in
 * `order`, are told, then marked in `column` — only those whose e-mail the
 * queue accepted, and only while `due` still holds (a sign-in meanwhile).
 * `isStaff` adds to the stored role what makes an account staff without it
 * (a grant, a pool seat).
 */
async function tell(
  db: Db,
  config: AppConfig,
  stage: { due: SQL; order: SQL; limit: number; column: "inactivityNotifiedAt" | "inactivityRemindedAt"; state: "notice" | "reminder" },
): Promise<number> {
  const found = await db.select({ id: users.id }).from(users).where(stage.due).orderBy(stage.order, asc(users.id));
  const ids: string[] = [];
  for (const { id } of found) {
    if (ids.length === stage.limit) break;
    if (!(await isStaff(db, config, id))) ids.push(id);
  }
  if (ids.length === 0) return 0;
  const { enqueued } = await notifyManyEnqueued(
    db,
    ids.map((userId) => ({ userId, payload: { kind: "account_dormant", state: stage.state } })),
  );
  const told = ids.filter((_, i) => enqueued[i]!.includes("email"));
  if (told.length === 0) return 0;
  const marked = await db
    .update(users)
    .set({ [stage.column]: sql`now()` })
    .where(and(inArray(users.id, told), stage.due))
    .returning({ id: users.id });
  return marked.length;
}

/** The pseudonymization stage: at most `perRun` accounts, the oldest notices first. */
async function pseudonymizeDue(db: Db, ctx: LifecycleContext): Promise<Pick<LifecycleRun, "pseudonymized" | "skipped" | "deferred">> {
  const due = await db
    .select({ id: users.id })
    .from(users)
    .where(and(notPseudonymized, dueForPseudonymization))
    .orderBy(asc(users.inactivityNotifiedAt), asc(users.id));
  let pseudonymized = 0;
  let skipped = 0;
  let tried = 0;
  for (const { id } of due) {
    if (pseudonymized === LIFECYCLE.perRun) break;
    tried++;
    await logUndatedSeat(db, ctx.log, id);
    try {
      await pseudonymizeUser(db, id, { by: "lifecycle", actor: SYSTEM_ACTOR, config: ctx.config, log: ctx.log, now: ctx.now });
      pseudonymized++;
    } catch (err) {
      skipped++;
      if (err instanceof AccountError || (err instanceof DomainError && err.code === "revoke_failed")) {
        ctx.log.info({ userId: id, refused: err.code, details: err.details }, "account lifecycle: not pseudonymized, tried again tomorrow");
      } else {
        // One account must not stop the others; the run's summary counts it.
        ctx.log.error({ err, userId: id }, "account lifecycle: pseudonymization failed");
      }
    }
  }
  return { pseudonymized, skipped, deferred: due.length - tried };
}

/** ADR-117 §10: an undated classroom never blocks, and the job says it met one. */
async function logUndatedSeat(db: Db, log: FastifyBaseLogger, userId: string): Promise<void> {
  const [undated] = await db
    .select({ id: classrooms.id })
    .from(enrollments)
    .innerJoin(classrooms, eq(classrooms.id, enrollments.classroomId))
    .where(and(eq(enrollments.userId, userId), isNull(classrooms.archivedAt), isNull(classrooms.periodEnd)))
    .limit(1);
  if (undated) log.info({ userId, classroomId: undated.id }, "account lifecycle: a seat in an undated classroom, which does not block");
}

/** One run of the `accounts.lifecycle` task; nothing at all while `ACCOUNT_LIFECYCLE` is off. */
export async function runAccountLifecycle(db: Db, ctx: LifecycleContext): Promise<LifecycleRun> {
  if (!ctx.config.ACCOUNT_LIFECYCLE) {
    return { enabled: false, reactivated: 0, notified: 0, reminded: 0, pseudonymized: 0, skipped: 0, deferred: 0 };
  }
  const reactivated = await reactivate(db, ctx.config);
  const notified = await tell(db, ctx.config, {
    due: dueForNotice,
    order: asc(lastActivity()),
    limit: LIFECYCLE.noticesPerRun,
    column: "inactivityNotifiedAt",
    state: "notice",
  });
  const reminded = await tell(db, ctx.config, {
    due: dueForReminder,
    order: asc(users.inactivityNotifiedAt),
    limit: Number.POSITIVE_INFINITY,
    column: "inactivityRemindedAt",
    state: "reminder",
  });
  const pseudonymization = await pseudonymizeDue(db, ctx);
  return { enabled: true, reactivated, notified, reminded, ...pseudonymization };
}

/**
 * The dormant accounts used since their notice, or staff since: both dates
 * go. The stored role first, in SQL; `isStaff` for the dormant students left
 * (a grant, a pool seat).
 */
async function reactivate(db: Db, config: AppConfig): Promise<number> {
  const dormant = and(notPseudonymized, isNotNull(users.inactivityNotifiedAt));
  const wake = (where: SQL | undefined) =>
    db.update(users).set({ inactivityNotifiedAt: null, inactivityRemindedAt: null }).where(where).returning({ id: users.id });
  const first = await wake(and(dormant, or(usedSinceNotice, ne(users.role, "student"))));
  const students = await db.select({ id: users.id }).from(users).where(dormant);
  const staff: string[] = [];
  for (const { id } of students) if (await isStaff(db, config, id)) staff.push(id);
  const second = staff.length > 0 ? await wake(and(dormant, inArray(users.id, staff))) : [];
  return first.length + second.length;
}

/** The run's line on the scheduled tasks screen. */
export function lifecycleSummary(run: LifecycleRun): string {
  if (!run.enabled) return "off (ACCOUNT_LIFECYCLE=0)";
  const parts = [
    `${run.notified} notified`,
    `${run.reminded} reminded`,
    `${run.pseudonymized} pseudonymized`,
    `${run.skipped} skipped`,
    `${run.reactivated} active again`,
  ];
  if (run.deferred > 0) parts.push(`${run.deferred} left for tomorrow (at most ${LIFECYCLE.perRun} a run)`);
  return parts.join(", ");
}
