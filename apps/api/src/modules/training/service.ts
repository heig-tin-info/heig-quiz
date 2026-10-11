/**
 * The training course of a new teacher (ADR-105, F-ORG-17).
 *
 *  - `install`: the `training.install` admin task puts the content of
 *    `content.ts` into ONE public pool, found by `pools.is_training`, through
 *    the ordinary pool services: a missing question is created and
 *    published, one whose config or explanation differs from its latest
 *    published version gets a new version, an unchanged one is left alone.
 *  - `provision`: one course per teacher, with the ordinary `org`,
 *    `evaluation` and `live` services; `courses_training_for_uq` is the
 *    idempotence. Nothing else: no seat, no private pool (§1).
 *  - `status`: the progress card, derived from the tables (§4), never stored.
 *
 * This module writes none of the tables it reads: every row goes through
 * the service of the module that owns it.
 */
import { isDeepStrictEqual } from "node:util";

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { Locale } from "@quiz/domain";
import { currentOrNextSemester, semesterMonths } from "@quiz/domain";
import type { TrainingInstallResult, TrainingProvisionResponse, TrainingStatus } from "@quiz/contracts";
import { TRAINING_MISSIONS, type TrainingMissionState } from "@quiz/contracts";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { isUniqueViolation, type Db } from "../../db/client.js";
import {
  apiTokens,
  assistConversations,
  attempts,
  categories,
  classrooms,
  coursePools,
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
import { normalizeEmail, ownersOf } from "../../identity.js";
import * as evaluationService from "../evaluation/service.js";
import { DomainError } from "../http.js";
import * as live from "../live/service.js";
import * as orgService from "../org/service.js";
import * as poolService from "../pool/service.js";
import { TRAINING_CONTENT } from "./content.js";
import type { TrainingContent, TrainingEvaluationSpec, TrainingQuestionSpec } from "./content-types.js";

/** `409 training_not_installed`: no admin has run the `training.install` task yet (§1). */
export class TrainingNotInstalled extends DomainError {
  constructor() {
    super("training_not_installed", 409, "The training content is not installed");
  }
}

type PoolRow = typeof pools.$inferSelect;
type CourseRow = typeof courses.$inferSelect;

/** The one pool marked `is_training`, or null before the install. */
export async function trainingPool(db: Db): Promise<PoolRow | null> {
  const [row] = await db.select().from(pools).where(eq(pools.isTraining, true)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Install (§2)
// ---------------------------------------------------------------------------

/**
 * The super admin's account (Assumption 1): the one signed in under
 * `SUPER_ADMIN_EMAIL`, by its primary address or any verified one.
 */
async function superAdminId(db: Db, email: string): Promise<string | null> {
  if (!email) return null;
  const [byPrimary] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
    .limit(1);
  if (byPrimary) return byPrimary.id;
  return (await ownersOf(db, email))[0] ?? null;
}

/** Find-or-create of the pool, under the partial unique index. */
async function ensureTrainingPool(
  db: Db,
  content: TrainingContent,
  ownerId: string,
): Promise<{ pool: PoolRow; created: boolean }> {
  const existing = await trainingPool(db);
  if (existing) {
    // A read link needs the pool public (ADR-095 §4): re-asserted, nothing else of the owner's edits is touched.
    if (!existing.isPublic) await poolService.updatePool(db, existing.id, { isPublic: true });
    return { pool: existing, created: false };
  }
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

async function questionByName(db: Db, poolId: string, internalName: string) {
  const [row] = await db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.poolId, poolId),
        isNull(questions.deletedAt),
        sql`lower(${questions.internalName}) = lower(${internalName})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

async function latestPublished(db: Db, questionId: string) {
  const [row] = await db
    .select({ config: questionVersions.config, configVersion: questionVersions.configVersion, explanation: questionVersions.explanation })
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), isNotNull(questionVersions.number)))
    .orderBy(sql`${questionVersions.number} desc`)
    .limit(1);
  return row ?? null;
}

/** Through a JSON round trip, as the stored jsonb went: an `undefined` member is no member. */
const asStored = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/**
 * Whether the spec would publish the same thing again: the config as the
 * draft stores it (`saveConfig`, the type's own parse) and the explanation.
 */
function matchesPublished(spec: TrainingQuestionSpec, latest: NonNullable<Awaited<ReturnType<typeof latestPublished>>>): boolean {
  const written = poolService.saveConfig(spec.type, spec.config);
  return (
    written.configVersion === latest.configVersion &&
    isDeepStrictEqual(asStored(written.config), asStored(latest.config)) &&
    spec.explanation === latest.explanation
  );
}

/** A draft that the type's schema refuses is the content author's error, named. */
async function publishSpec(db: Db, row: typeof questions.$inferSelect, spec: TrainingQuestionSpec, ownerId: string, note: string) {
  await poolService.putDraft(db, row, { config: spec.config, explanation: spec.explanation });
  try {
    await poolService.publishQuestion(db, row, { userId: ownerId, changeNote: note });
  } catch (err) {
    throw new Error(`training content: "${spec.internalName}" cannot be published: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * Installs `content` (the module's by default; a test injects its own). The
 * task's caller is an admin; the pool's owner is the super admin's account
 * (Assumption 1), without which there is nothing to install into.
 */
export async function install(
  db: Db,
  config: Pick<AppConfig, "SUPER_ADMIN_EMAIL">,
  now: Date,
  content: TrainingContent = TRAINING_CONTENT,
): Promise<TrainingInstallResult> {
  const ownerId = await superAdminId(db, config.SUPER_ADMIN_EMAIL);
  if (!ownerId) throw new Error("training content: the super administrator (SUPER_ADMIN_EMAIL) has no account yet");
  const { pool, created: poolCreated } = await ensureTrainingPool(db, content, ownerId);
  const actor: AuditActor = SYSTEM_ACTOR;
  const writer = { userId: ownerId, lang: "fr" as const, actor };

  const categoryIds = new Map<string, string>();
  const categoryOf = async (name: string): Promise<string> => {
    const known = categoryIds.get(name);
    if (known) return known;
    const [row] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.poolId, pool.id), eq(categories.name, name)))
      .limit(1);
    const id = row?.id ?? (await poolService.createCategory(db, pool.id, { name })).id;
    categoryIds.set(name, id);
    return id;
  };

  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const spec of content.questions) {
    const existing = await questionByName(db, pool.id, spec.internalName);
    if (!existing) {
      const row = await poolService.createQuestion(db, {
        poolId: pool.id,
        type: spec.type,
        internalName: spec.internalName,
        categoryId: await categoryOf(spec.category),
        createdBy: ownerId,
      });
      await poolService.patchQuestion(db, row, { difficulty: spec.difficulty }, writer);
      await publishSpec(db, row, spec, ownerId, "Training content (install)");
      counts.created += 1;
      continue;
    }
    const latest = await latestPublished(db, existing.id);
    if (latest && matchesPublished(spec, latest)) {
      counts.unchanged += 1;
      continue;
    }
    await publishSpec(db, existing, spec, ownerId, "Training content (update)");
    counts.updated += 1;
  }

  if (poolCreated || counts.created + counts.updated > 0) {
    await audit(db, {
      ...actor,
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

async function courseOf(db: Db, userId: string): Promise<CourseRow | null> {
  const [row] = await db.select().from(courses).where(eq(courses.trainingFor, userId)).limit(1);
  return row ?? null;
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

/** `INIT-<n>`, the smallest free `n`: the teacher may rename it afterwards. */
async function freeCode(db: Db): Promise<string> {
  const rows = await db
    .select({ code: courses.code })
    .from(courses)
    .where(sql`${courses.code} ~ '^INIT-[0-9]+$'`);
  const taken = new Set(rows.map((r) => Number(r.code.slice("INIT-".length))));
  let n = 1;
  while (taken.has(n)) n += 1;
  return `INIT-${n}`;
}

/** The last second of a `YYYY-MM` month, UTC: when the ticker closes the welcome quiz. */
function endOfMonth(ym: string): Date {
  const [year, month] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1) - 1000);
}

/** F-EVAL-02: the type decides an item's default weight, from its own config. */
const defaultPoints = (type: string, version: typeof questionVersions.$inferSelect): number =>
  poolService.typeOf(type).defaultPoints(poolService.exampleConfig(type, version));

/** The published questions of the training pool the spec names, in its order; a name the pool lacks is skipped. */
async function questionIdsOf(db: Db, poolId: string, names: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const row = await questionByName(db, poolId, name);
    if (row && (await latestPublished(db, row.id))) ids.push(row.id);
  }
  return ids;
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
  ctx: { classroomId: string; poolId: string; userId: string; periodEnd: string; now: Date },
): Promise<void> {
  let row = await evaluationService.createEvaluation(db, {
    classroomId: ctx.classroomId,
    title: spec.title,
    mode: spec.mode,
    preset: spec.mode,
    createdBy: ctx.userId,
  });
  const questionIds = await questionIdsOf(db, ctx.poolId, spec.questions);
  await evaluationService.addItems(db, row, questionIds, defaultPoints, { attemptCount: 0 });
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
  // Without a question there is nothing to open (the content is not installed yet): it stays a draft.
  if (questionIds.length === 0) return;
  evaluationService.guardTransition(row, "running", {
    items: await evaluationService.itemRows(db, row.id),
    attemptCount: 0,
    now: ctx.now,
  });
  await live.startEvaluation(db, row, ctx.now);
}

/** The classroom, the read link and the two evaluations of a course that has none yet. */
async function buildClassroom(
  db: Db,
  course: CourseRow,
  pool: PoolRow,
  input: { userId: string; lang: Locale; now: Date; content: TrainingContent },
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
  await poolService.setCoursePools(db, course.id, [{ poolId: pool.id, mode: "read" }], undefined, {
    id: input.userId,
    role: "teacher",
    reach: "seats",
  });
  for (const spec of input.content.evaluations) {
    await instantiate(db, spec, {
      classroomId: room.id,
      poolId: pool.id,
      userId: input.userId,
      periodEnd: months.end,
      now: input.now,
    });
  }
  return room.id;
}

/**
 * The caller's training course, created or found (§1). The course row is the
 * claim: `createCourse` with `trainingFor` answers null on EITHER unique, and
 * the course read back says which — the teacher's exists (the loser of a race
 * returns it, `created: false`) or the code was taken (another one is tried).
 * The classroom and what hangs off it follow the claim. A course found
 * without a classroom — the teacher deleted it, or a loser read the winner's
 * course in the few writes before its room — gets one built: the oldest
 * room is the course's from then on (`classroomIdOf`).
 */
export async function provision(
  db: Db,
  input: { userId: string; lang: Locale; now: Date; actor: AuditActor; content?: TrainingContent },
): Promise<TrainingProvisionResponse> {
  const content = input.content ?? TRAINING_CONTENT;
  const pool = await trainingPool(db);
  if (!pool) throw new TrainingNotInstalled();

  const found = async (course: CourseRow): Promise<TrainingProvisionResponse> => ({
    courseId: course.id,
    classroomId: (await classroomIdOf(db, course.id)) ?? (await buildClassroom(db, course, pool, { ...input, content })),
    created: false,
  });
  const existing = await courseOf(db, input.userId);
  if (existing) return found(existing);

  let course: CourseRow | null = null;
  for (let attempt = 0; course === null && attempt < 5; attempt += 1) {
    course = await orgService.createCourse(
      db,
      { name: WORDS[input.lang].course, code: await freeCode(db) },
      input.userId,
      { trainingFor: input.userId },
    );
    if (course === null) {
      const theirs = await courseOf(db, input.userId);
      if (theirs) return found(theirs);
    }
  }
  if (course === null) throw new Error("training: no free INIT code after five tries");

  const classroomId = await buildClassroom(db, course, pool, { ...input, content });
  await audit(db, {
    ...input.actor,
    action: "training.provision",
    subjectType: "course",
    subjectId: course.id,
    payload: { classroomId, code: course.code },
    at: input.now,
  });
  return { courseId: course.id, classroomId, created: true };
}

// ---------------------------------------------------------------------------
// Status (§4)
// ---------------------------------------------------------------------------

async function exists(db: Db, query: Promise<unknown[]>): Promise<boolean> {
  return (await query).length > 0;
}

/**
 * The four mission states of the table of §4, from the tables alone:
 *  1. a handed-in staff attempt of the caller on an exercise of the course;
 *  2. a released evaluation of the course;
 *  3. a published question in a pool linked `edit` to the course AND a template in the course;
 *  4. an `api_tokens` or `oauth_grants` row of the caller, ever, or an assistant conversation
 *     of theirs; `unavailable` when the LLM gateway is off AND OAuth has no client.
 */
async function missionsOf(
  db: Db,
  courseId: string,
  userId: string,
  llmEnabled: boolean,
): Promise<Record<(typeof TRAINING_MISSIONS)[number], TrainingMissionState>> {
  const ofCourse = (classroomId: typeof evaluations.classroomId) =>
    sql`EXISTS (SELECT 1 FROM ${classrooms} WHERE ${classrooms.id} = ${classroomId} AND ${classrooms.courseId} = ${courseId})`;
  const [student, released, ownQuestion, template, toolUsed, oauthClient] = await Promise.all([
    exists(
      db,
      db
        .select({ id: attempts.id })
        .from(attempts)
        .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
        .where(
          and(
            ofCourse(evaluations.classroomId),
            eq(evaluations.mode, "exercise"),
            eq(attempts.userId, userId),
            eq(attempts.state, "submitted"),
            isStaffAttempt,
          ),
        )
        .limit(1),
    ),
    exists(
      db,
      db
        .select({ id: evaluations.id })
        .from(evaluations)
        .where(and(ofCourse(evaluations.classroomId), isNotNull(evaluations.releasedAt)))
        .limit(1),
    ),
    exists(
      db,
      db
        .select({ id: questions.id })
        .from(questions)
        .innerJoin(coursePools, and(eq(coursePools.poolId, questions.poolId), eq(coursePools.courseId, courseId), eq(coursePools.mode, "edit")))
        .innerJoin(questionVersions, and(eq(questionVersions.questionId, questions.id), isNotNull(questionVersions.number)))
        .where(isNull(questions.deletedAt))
        .limit(1),
    ),
    exists(
      db,
      db
        .select({ id: evaluations.id })
        .from(evaluations)
        .where(and(eq(evaluations.courseId, courseId), isNotNull(evaluations.revision)))
        .limit(1),
    ),
    exists(
      db,
      db
        .select({ one: sql`1` })
        .from(users)
        .where(
          and(
            eq(users.id, userId),
            sql`(EXISTS (SELECT 1 FROM ${apiTokens} WHERE ${apiTokens.userId} = ${users.id})
              OR EXISTS (SELECT 1 FROM ${oauthGrants} WHERE ${oauthGrants.userId} = ${users.id})
              OR EXISTS (SELECT 1 FROM ${assistConversations} WHERE ${assistConversations.userId} = ${users.id}))`,
          ),
        )
        .limit(1),
    ),
    exists(db, db.select({ id: oauthClients.id }).from(oauthClients).limit(1)),
  ]);
  const state = (done: boolean): TrainingMissionState => (done ? "done" : "todo");
  return {
    student: state(student),
    run: state(released),
    own: state(ownQuestion && template),
    tools: toolUsed ? "done" : !llmEnabled && !oauthClient ? "unavailable" : "todo",
  };
}

/** `GET /app/api/training`: installed, the caller's course, the missions — `todo` everywhere without a course. */
export async function status(db: Db, input: { userId: string; llmEnabled: boolean }): Promise<TrainingStatus> {
  const [pool, course] = await Promise.all([trainingPool(db), courseOf(db, input.userId)]);
  const classroomId = course ? await classroomIdOf(db, course.id) : null;
  const missions =
    course && classroomId
      ? await missionsOf(db, course.id, input.userId, input.llmEnabled)
      : { student: "todo" as const, run: "todo" as const, own: "todo" as const, tools: "todo" as const };
  return {
    installed: pool !== null,
    course: course && classroomId ? { id: course.id, classroomId } : null,
    missions: TRAINING_MISSIONS.map((key) => ({ key, state: missions[key] })),
  };
}
