/**
 * The training course of a new teacher (ADR-105, F-ORG-17).
 *
 *  - `install`: the `training.install` task puts the content of `content.ts`
 *    into ONE public pool, found by `pools.is_training`, through the pool
 *    services: a missing question is created and published, one whose config
 *    or explanation differs from its latest published version gets a new
 *    version, an unchanged one is left alone (§2).
 *  - `provision`: one course per teacher, with the ordinary `org`,
 *    `evaluation` and `live` services; the mark `courses.training_for` is the
 *    LAST write, so a course is a training course only once whole, and its
 *    unique index is the idempotence. Nothing else: no seat, no private pool (§1).
 *  - `status`: the progress card, derived from the tables (§4), never stored.
 *
 * This module writes none of the tables it reads: every row goes through
 * the service of the module that owns it.
 */
import { isDeepStrictEqual } from "node:util";

import { and, asc, eq, exists, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import type { Locale } from "@quiz/domain";
import { clockChoiceOf, currentOrNextSemester, semesterMonths } from "@quiz/domain";
import {
  TRAINING_MISSIONS,
  type TrainingInstallResult,
  type TrainingMissionState,
  type TrainingProvisionResponse,
  type TrainingStatus,
} from "@quiz/contracts";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { isUniqueViolation, type Db } from "../../db/client.js";
import {
  apiTokens,
  assistConversations,
  attempts,
  classrooms,
  coursePools,
  courseStaff,
  courses,
  evaluations,
  isStaffAttempt,
  oauthClients,
  oauthGrants,
  pools,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";
import { ownersOf } from "../../identity.js";
import * as evaluationService from "../evaluation/service.js";
import { DomainError } from "../http.js";
import * as live from "../live/service.js";
import * as orgService from "../org/service.js";
import * as poolService from "../pool/service.js";
import { TRAINING_CONTENT } from "./content.js";
import type { TrainingContent, TrainingEvaluationSpec, TrainingQuestionSpec } from "./content-types.js";

/** `409 training_not_installed`: no public training pool — never installed, or unpublished since (§1, §2). */
export class TrainingNotInstalled extends DomainError {
  constructor() {
    super("training_not_installed", 409, "The training content is not installed");
  }
}

type PoolRow = typeof pools.$inferSelect;
type CourseRow = typeof courses.$inferSelect;
type VersionRow = typeof questionVersions.$inferSelect;

/** The one pool marked `is_training`, public or not; null before the install. */
export async function trainingPool(db: Db): Promise<PoolRow | null> {
  const [row] = await db.select().from(pools).where(eq(pools.isTraining, true)).limit(1);
  return row ?? null;
}

/** "Installed" (§2): the training pool exists AND is public — an unpublication (ADR-095 §5) uninstalls. */
async function installedPool(db: Db): Promise<PoolRow | null> {
  const pool = await trainingPool(db);
  return pool?.isPublic ? pool : null;
}

// ---------------------------------------------------------------------------
// Install (§2)
// ---------------------------------------------------------------------------

/** The task's outcome: what it installed, or why it had nothing to do (an ok run, not a failure). */
export type InstallOutcome = TrainingInstallResult | { skipped: string };

/**
 * Find-or-create of the pool under the partial unique index. Public at its
 * creation and never flipped afterwards: an unpublication is the owner's
 * deliberate act (ADR-095 §5), not something a nightly run undoes.
 */
async function ensureTrainingPool(db: Db, content: TrainingContent, ownerId: string): Promise<{ pool: PoolRow; created: boolean }> {
  const existing = await trainingPool(db);
  if (existing) return { pool: existing, created: false };
  try {
    const created = await poolService.createPool(db, {
      name: content.pool.name,
      icon: content.pool.icon,
      ownerId,
      isPublic: true,
      isTraining: true,
    });
    await poolService.updatePool(db, created.id, { description: content.pool.description });
    return { pool: (await trainingPool(db))!, created: true };
  } catch (err) {
    // Two installs at once: the loser reads the winner's pool.
    if (!isUniqueViolation(err, "pools_training_uq")) throw err;
    return { pool: (await trainingPool(db))!, created: false };
  }
}

/** The pool's live questions by lower-cased `internalName`, each with its latest published version: one query, one batch. */
async function questionsOf(db: Db, poolId: string) {
  const rows = await db
    .select()
    .from(questions)
    .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)));
  const latest = await evaluationService.latestPublished(db, rows.map((r) => r.id));
  return new Map(rows.map((row) => [row.internalName.toLowerCase(), { row, latest: latest.get(row.id) ?? null }]));
}

/** Through a JSON round trip, as the stored jsonb went: an `undefined` member is no member. */
const asStored = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/**
 * Whether the spec would publish the same thing again: the config as the
 * draft stores it (`saveConfig`, the type's own parse) against the stored one
 * raised to the type's current shape (`loadConfig`), so a version bump of a
 * type republishes nothing by itself; and the explanation.
 */
function matchesPublished(spec: TrainingQuestionSpec, latest: VersionRow): boolean {
  return (
    isDeepStrictEqual(asStored(poolService.saveConfig(spec.type, spec.config).config), asStored(poolService.loadConfig(spec.type, latest))) &&
    spec.explanation === latest.explanation
  );
}

/** A config the type refuses is the content author's error: named after the question. */
async function named<T>(spec: TrainingQuestionSpec, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    throw new Error(`training content: "${spec.internalName}" cannot be published: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

/**
 * Installs `content` (the module's by default; a test injects its own) as the
 * super admin's account (Assumption 1), resolved through its verified
 * addresses alone. Nothing to install — no question in the content, no such
 * account yet — is a skipped run, not a failure; two accounts sharing the
 * address is one. A run that changed nothing traces nothing.
 */
export async function install(
  db: Db,
  config: Pick<AppConfig, "SUPER_ADMIN_EMAIL">,
  now: Date,
  content: TrainingContent = TRAINING_CONTENT,
): Promise<InstallOutcome> {
  if (content.questions.length === 0) return { skipped: "nothing to install: the content holds no question" };
  const owners = config.SUPER_ADMIN_EMAIL ? await ownersOf(db, config.SUPER_ADMIN_EMAIL) : [];
  if (owners.length === 0) return { skipped: "the super administrator (SUPER_ADMIN_EMAIL) has no account yet" };
  if (owners.length > 1) throw new Error(`training content: SUPER_ADMIN_EMAIL is a verified address of ${owners.length} accounts, not one`);
  const ownerId = owners[0]!;
  const { pool, created: poolCreated } = await ensureTrainingPool(db, content, ownerId);
  const writer = { userId: ownerId, lang: "fr" as const, actor: SYSTEM_ACTOR };
  const known = await questionsOf(db, pool.id);

  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const spec of content.questions) {
    const found = known.get(spec.internalName.toLowerCase());
    if (!found) {
      const { id: categoryId } = await poolService.ensureCategory(db, pool.id, spec.category);
      await named(spec, () =>
        poolService.createPublished(db, pool.id, { ...spec, categoryId, changeNote: "Training content (install)" }, writer),
      );
      counts.created += 1;
    } else if (found.latest && matchesPublished(spec, found.latest)) {
      counts.unchanged += 1;
    } else {
      await named(spec, async () => {
        await poolService.putDraft(db, found.row, { config: spec.config, explanation: spec.explanation });
        await poolService.publishQuestion(db, found.row, { userId: ownerId, changeNote: "Training content (update)" });
      });
      counts.updated += 1;
    }
  }

  if (poolCreated || counts.created + counts.updated > 0) {
    await audit(db, {
      ...SYSTEM_ACTOR,
      action: "training.install",
      subjectType: "pool",
      subjectId: pool.id,
      payload: { poolCreated, questions: counts },
      at: now,
    });
  }
  return { poolId: pool.id, questions: counts };
}

// ---------------------------------------------------------------------------
// Provision (§1)
// ---------------------------------------------------------------------------

/** The course's name and the classroom's period label, in the caller's UI language (§1). */
const WORDS: Record<Locale, { course: string; autumn: string; spring: string }> = {
  fr: { course: "Prise en main de Quiz", autumn: "Automne", spring: "Printemps" },
  en: { course: "Getting started with Quiz", autumn: "Autumn", spring: "Spring" },
};

/** The classroom of the training course (§1): one, named so whatever the language. */
const CLASSROOM_NAME = "Initiation";

/** The training course's code (§1): the same for every teacher, a free label (ADR-120). */
const TRAINING_CODE = "INIT";

/**
 * The caller's training course: marked for them AND reached through their
 * own seat on its staff (invariant 6, the seat branch — never Super Powers).
 * A course whose seat the teacher lost is nobody's training course any more;
 * `changeStaffSeat` unmarks it with the seat.
 */
async function courseOf(db: Db, userId: string): Promise<CourseRow | null> {
  const [row] = await db
    .select({ course: courses })
    .from(courses)
    .innerJoin(courseStaff, and(eq(courseStaff.courseId, courses.id), eq(courseStaff.userId, userId)))
    .where(eq(courses.trainingFor, userId))
    .limit(1);
  return row?.course ?? null;
}

/** The course's oldest classroom: the one the provisioning made, unless the teacher deleted it. */
async function classroomIdOf(db: Db, courseId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: classrooms.id })
    .from(classrooms)
    .where(eq(classrooms.courseId, courseId))
    .orderBy(asc(classrooms.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** The last second of a `YYYY-MM` month, UTC: when the ticker closes the welcome quiz. */
function endOfMonth(ym: string): Date {
  const [year, month] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1) - 1000);
}

/**
 * One evaluation of §3 from its definition. `scheduled` (the welcome quiz):
 * Scheduled per ADR-086 (`deadline` timing, no waiting room), open from now
 * to the end of the classroom's period, retakes allowed (ADR-025), the
 * exercise preset's free navigation and immediate correction kept, the
 * drill setting left to its default — and started at once, as **Open now**
 * does, so the ticker has only its end to enforce. `draft` (the live quiz):
 * the exam preset, Live mode, left to the teacher.
 */
async function instantiate(
  db: Db,
  spec: TrainingEvaluationSpec,
  questionIds: readonly string[],
  ctx: { classroomId: string; userId: string; periodEnd: string; now: Date },
): Promise<void> {
  let row = await evaluationService.createEvaluation(db, {
    classroomId: ctx.classroomId,
    title: spec.title,
    mode: spec.mode,
    preset: spec.mode,
    createdBy: ctx.userId,
  });
  await evaluationService.addItems(db, row, [...questionIds], evaluationService.defaultPoints, { attemptCount: 0 });
  if (spec.target !== "scheduled") return;
  row = await evaluationService.patchEvaluation(
    db,
    row,
    {
      settings: { timing: "deadline", retakes: { enabled: true, keep: "best", maxAttempts: null } },
      opensAt: ctx.now.toISOString(),
      closesAt: endOfMonth(ctx.periodEnd).toISOString(),
    },
    { attemptCount: 0, now: ctx.now },
  );
  // Without a question there is nothing to open: it stays a draft.
  if (questionIds.length === 0) return;
  evaluationService.guardTransition(row, "running", {
    items: await evaluationService.itemRows(db, row.id),
    attemptCount: 0,
    now: ctx.now,
  });
  await live.startEvaluation(db, row, ctx.now);
}

/** The request's logger, or the app's: where an undo that failed is told. */
type Log = Pick<FastifyBaseLogger, "error">;

interface BuildInput {
  userId: string;
  lang: Locale;
  now: Date;
  content: TrainingContent;
  log: Log;
}

/**
 * The classroom, the pool links and the two evaluations of a course that has
 * no classroom: at the provisioning, and again when the teacher deleted it
 * (the rebuild, §1). `links` are kept beside the training pool's read link —
 * a pool the teacher linked in mission 3 is theirs and stays.
 */
async function buildClassroom(
  db: Db,
  course: CourseRow,
  pool: PoolRow,
  input: BuildInput,
  links: readonly { poolId: string; mode: "edit" | "read" }[],
): Promise<string> {
  const semester = currentOrNextSemester(input.now);
  const months = semesterMonths(semester);
  const words = WORDS[input.lang];
  const room = await orgService.createClassroom(db, course.id, {
    name: CLASSROOM_NAME,
    period: `${semester.season === "autumn" ? words.autumn : words.spring} ${semester.year}`,
    periodStart: months.start,
    periodEnd: months.end,
  });
  try {
    await poolService.setCoursePools(db, course.id, [...links, { poolId: pool.id, mode: "read" }], undefined, {
      id: input.userId,
      role: "teacher",
      reach: "seats",
    });
    // The published questions of the pool, by name, once for both evaluations.
    const published = await questionsOf(db, pool.id);
    const idsOf = (names: readonly string[]) =>
      names.map((name) => published.get(name.toLowerCase())).flatMap((q) => (q?.latest ? [q.row.id] : []));
    for (const spec of input.content.evaluations) {
      await instantiate(db, spec, idsOf(spec.questions), {
        classroomId: room.id,
        userId: input.userId,
        periodEnd: months.end,
        now: input.now,
      });
    }
  } catch (err) {
    // A classroom without its evaluations would be what the next call answers: it goes with the failure.
    await discard(() => orgService.deleteClassroom(db, room.id), input.log, { classroomId: room.id }, err);
    throw err;
  }
  return room.id;
}

/**
 * Undoes a write of a failed provisioning. Its own failure is logged with
 * the original error and never replaces it: the caller rethrows the cause.
 */
async function discard(undo: () => Promise<void>, log: Log, subject: Record<string, string>, cause: unknown): Promise<void> {
  try {
    await undo();
  } catch (err) {
    log.error({ err, cause, ...subject }, "training: a failed provisioning could not be undone");
  }
}

/** `training.provision`, once per course built — at the provisioning, and at a rebuild (`rebuilt: true`). */
async function traceProvision(db: Db, actor: AuditActor, course: CourseRow, classroomId: string, now: Date, rebuilt: boolean) {
  await audit(db, {
    ...actor,
    action: "training.provision",
    subjectType: "course",
    subjectId: course.id,
    payload: { classroomId, code: course.code, ...(rebuilt ? { rebuilt } : {}) },
    at: now,
  });
}

/**
 * The caller's training course, created or found (§1). Refused up front
 * while the content is not installed. A found course without a classroom
 * (the teacher deleted it) is rebuilt with its links kept. Otherwise the
 * course is built whole — course, classroom, links, evaluations — and marked
 * LAST (`claimTrainingCourse`): until then it is an ordinary course of the
 * caller's that no reader of `training_for` sees, so a failure on the way
 * deletes it and a race's loser deletes its own and answers the winner's.
 */
export async function provision(
  db: Db,
  input: { userId: string; lang: Locale; now: Date; actor: AuditActor; log: Log; content?: TrainingContent },
): Promise<TrainingProvisionResponse> {
  const content = input.content ?? TRAINING_CONTENT;
  const pool = await installedPool(db);
  if (!pool) throw new TrainingNotInstalled();
  const build = { ...input, content };

  const found = async (course: CourseRow): Promise<TrainingProvisionResponse> => {
    let classroomId = await classroomIdOf(db, course.id);
    if (classroomId === null) {
      const links = (await poolService.poolsOfCourse(db, course.id)).map((p) => ({ poolId: p.id, mode: p.mode }));
      classroomId = await buildClassroom(db, course, pool, build, links);
      await traceProvision(db, input.actor, course, classroomId, input.now, true);
    }
    return { courseId: course.id, classroomId, created: false };
  };
  const existing = await courseOf(db, input.userId);
  if (existing) return found(existing);

  const course = await orgService.createCourse(db, { name: WORDS[input.lang].course, code: TRAINING_CODE }, input.userId);

  let classroomId: string;
  try {
    classroomId = await buildClassroom(db, course, pool, build, []);
  } catch (err) {
    // No half-built course survives: unmarked, it would be an ordinary course of the teacher's.
    await discard(() => orgService.deleteCourse(db, course.id), input.log, { courseId: course.id }, err);
    throw err;
  }
  if (!(await orgService.claimTrainingCourse(db, course.id, input.userId))) {
    // The same teacher's other call claimed first: theirs is the course, this one goes.
    await orgService.deleteCourse(db, course.id);
    const theirs = await courseOf(db, input.userId);
    if (!theirs) throw new Error("training: the course was claimed by another call but is unreadable");
    return found(theirs);
  }
  await traceProvision(db, input.actor, course, classroomId, input.now, false);
  return { courseId: course.id, classroomId, created: true };
}

// ---------------------------------------------------------------------------
// Status (§4)
// ---------------------------------------------------------------------------

type Missions = Record<(typeof TRAINING_MISSIONS)[number], TrainingMissionState>;
const ALL_TODO: Missions = { student: "todo", run: "todo", own: "todo", tools: "todo" };

/**
 * The four mission states of the table of §4, from the tables alone, in one
 * round trip:
 *  1. a handed-in staff attempt of the caller on an exercise of the course;
 *  2. a released evaluation of the course;
 *  3. a published question in a pool linked `edit` to the course AND a template in the course;
 *  4. an `api_tokens` or `oauth_grants` row of the caller, ever, or an assistant conversation
 *     of theirs; `unavailable` when the LLM gateway is off AND OAuth has no client.
 */
async function missionsOf(db: Db, courseId: string, userId: string, llmEnabled: boolean): Promise<Missions> {
  // Each fact is an EXISTS over the owning modules' tables, as select builders
  // so the compiler checks every column. The one shared definition of a staff
  // attempt (`isStaffAttempt`, db/live.ts) is reused as it is.
  const one = { one: sql`1` };
  const classroomsOfCourse = db.select({ id: classrooms.id }).from(classrooms).where(eq(classrooms.courseId, courseId));
  const inCourse = inArray(evaluations.classroomId, classroomsOfCourse);
  const fact = (query: Parameters<typeof exists>[0]) => exists(query).mapWith(Boolean);
  const [facts] = await db
    .select({
      student: fact(
        db
          .select(one)
          .from(attempts)
          .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
          .where(and(inCourse, eq(evaluations.mode, "exercise"), eq(attempts.userId, userId), eq(attempts.state, "submitted"), isStaffAttempt)),
      ),
      released: fact(db.select(one).from(evaluations).where(and(inCourse, isNotNull(evaluations.releasedAt)))),
      ownQuestion: fact(
        db
          .select(one)
          .from(questions)
          .innerJoin(coursePools, and(eq(coursePools.poolId, questions.poolId), eq(coursePools.courseId, courseId), eq(coursePools.mode, "edit")))
          .innerJoin(questionVersions, and(eq(questionVersions.questionId, questions.id), isNotNull(questionVersions.number)))
          .where(isNull(questions.deletedAt)),
      ),
      template: fact(db.select(one).from(evaluations).where(and(eq(evaluations.courseId, courseId), isNotNull(evaluations.revision)))),
      toolUsed: or(
        exists(db.select(one).from(apiTokens).where(eq(apiTokens.userId, userId))),
        exists(db.select(one).from(oauthGrants).where(eq(oauthGrants.userId, userId))),
        exists(db.select(one).from(assistConversations).where(eq(assistConversations.userId, userId))),
      )!.mapWith(Boolean),
      oauthClient: fact(db.select(one).from(oauthClients)),
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!facts) return ALL_TODO;
  const state = (done: boolean): TrainingMissionState => (done ? "done" : "todo");
  return {
    student: state(facts.student),
    run: state(facts.released),
    own: state(facts.ownQuestion && facts.template),
    tools: facts.toolUsed ? "done" : !llmEnabled && !facts.oauthClient ? "unavailable" : "todo",
  };
}

/**
 * The live quiz of mission 2 (§4): the classroom's oldest evaluation in Live
 * mode — the clock rule of ADR-086 (`clockChoiceOf`), read from each row's
 * settings, never a title the teacher may rename. Null once it is deleted.
 */
async function liveEvaluationIdOf(db: Db, classroomId: string): Promise<string | null> {
  const rows = await db.select().from(evaluations).where(eq(evaluations.classroomId, classroomId)).orderBy(asc(evaluations.createdAt));
  return rows.find((row) => clockChoiceOf(evaluationService.settingsOf(row)).mode === "live")?.id ?? null;
}

/** `GET /app/api/training`: installed, the caller's course, the missions — `todo` everywhere without a course. */
export async function status(db: Db, input: { userId: string; llmEnabled: boolean }): Promise<TrainingStatus> {
  const [pool, course] = await Promise.all([installedPool(db), courseOf(db, input.userId)]);
  const classroomId = course ? await classroomIdOf(db, course.id) : null;
  const [missions, liveEvaluationId] =
    course && classroomId
      ? await Promise.all([missionsOf(db, course.id, input.userId, input.llmEnabled), liveEvaluationIdOf(db, classroomId)])
      : [ALL_TODO, null];
  return {
    installed: pool !== null,
    course: course && classroomId ? { id: course.id, classroomId, liveEvaluationId } : null,
    missions: TRAINING_MISSIONS.map((key) => ({ key, state: missions[key] })),
  };
}
