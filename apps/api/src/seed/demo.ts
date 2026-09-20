/**
 * How the demo world of `./content.ts` is built: through the SERVICES, never
 * by raw inserts. Publishing goes through `pool/service.ts`, an item freezes a
 * version through `evaluation/service.ts`, an attempt is started and answered
 * through `live/service.ts`, and the correction is the real grading pass. A
 * row this file writes is therefore a row the application itself would have
 * written, invariants included.
 *
 * Everything is keyed on stable names — the pool name, the question's
 * `internalName`, the evaluation title — so a second run creates nothing.
 */
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { PERSONAS, devSub } from "../auth/dev.js";
import type { Db } from "../db/client.js";
import {
  attempts,
  categories,
  evaluations,
  gradings,
  pools,
  questionVersions,
  questions,
  users,
} from "../db/schema.js";
import * as evaluationService from "../modules/evaluation/service.js";
import { runEvaluationGrading } from "../modules/grading/jobs.js";
import * as live from "../modules/live/service.js";
import { loadConfig, typeOf } from "../modules/pool/config.js";
import * as poolService from "../modules/pool/service.js";
import {
  CLOSED_TITLE,
  EVALUATIONS,
  PAPERS,
  POOLS,
  type EvaluationSpec,
  type PoolSpec,
  type QuestionSpec,
} from "./content.js";

export interface DemoCounts {
  pools: number;
  categories: number;
  questions: number;
  evaluations: number;
  attempts: number;
  gradings: number;
}

const MINUTE = 60_000;

/** F-EVAL-02: the type decides an item's default weight, from its own config. */
const defaultPoints = (
  type: string,
  version: typeof questionVersions.$inferSelect,
): number =>
  typeOf(type).defaultPoints(
    loadConfig(type, { config: version.config, configVersion: version.configVersion }),
  );

// ---------------------------------------------------------------------------
// Pools, categories, questions
// ---------------------------------------------------------------------------

async function poolIdByName(db: Db, ownerId: string, name: string): Promise<string | null> {
  const [row] = await db
    .select({ id: pools.id })
    .from(pools)
    .where(and(eq(pools.ownerId, ownerId), eq(pools.name, name)))
    .limit(1);
  return row?.id ?? null;
}

async function categoryIdByName(db: Db, poolId: string, name: string): Promise<string | null> {
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.poolId, poolId), eq(categories.name, name)))
    .limit(1);
  return row?.id ?? null;
}

async function questionByName(db: Db, poolId: string, internalName: string) {
  const [row] = await db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.poolId, poolId),
        sql`lower(${questions.internalName}) = lower(${internalName})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

async function isPublished(db: Db, questionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: questionVersions.id })
    .from(questionVersions)
    .where(
      and(eq(questionVersions.questionId, questionId), isNotNull(questionVersions.number)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * One question, from nothing to a published version. Re-runnable: an existing
 * question is left alone, and one that somehow lost its publication is
 * published again.
 */
async function ensureQuestion(
  db: Db,
  spec: QuestionSpec,
  ctx: { poolId: string; teacherId: string; categoryId: string | null },
): Promise<{ id: string; created: boolean }> {
  const existing = await questionByName(db, ctx.poolId, spec.internalName);
  if (existing) {
    if (!(await isPublished(db, existing.id))) {
      await poolService.publishQuestion(db, existing, { userId: ctx.teacherId });
    }
    return { id: existing.id, created: false };
  }

  const id = await poolService.createQuestion(db, {
    poolId: ctx.poolId,
    type: spec.type,
    internalName: spec.internalName,
    categoryId: ctx.categoryId,
    createdBy: ctx.teacherId,
  });
  const row = (await questionByName(db, ctx.poolId, spec.internalName))!;
  await poolService.patchQuestion(db, row, { difficulty: spec.difficulty, tags: spec.tags });
  await poolService.putDraft(db, row, { config: spec.config, explanation: spec.explanation });
  // Throws `DraftInvalid` when the demo config does not satisfy the type's
  // schema — which is exactly the feedback the author of `content.ts` needs.
  await poolService.publishQuestion(db, row, {
    userId: ctx.teacherId,
    changeNote: "Version initiale (seed)",
  });
  return { id, created: true };
}

async function ensurePool(
  db: Db,
  spec: PoolSpec,
  teacherId: string,
  counts: DemoCounts,
  questionIds: Map<string, string>,
): Promise<string> {
  let poolId = await poolIdByName(db, teacherId, spec.name);
  if (!poolId) {
    poolId = (
      await poolService.createPool(db, {
        name: spec.name,
        visibility: "shared",
        ownerId: teacherId,
      })
    ).id;
    counts.pools += 1;
  }

  const categoryIds = new Map<string, string>();
  for (const name of spec.categories) {
    let id = await categoryIdByName(db, poolId, name);
    if (!id) {
      id = (await poolService.createCategory(db, poolId, { name })).id;
      counts.categories += 1;
    }
    categoryIds.set(name, id);
  }

  for (const question of spec.questions) {
    const result = await ensureQuestion(db, question, {
      poolId,
      teacherId,
      categoryId: categoryIds.get(question.category) ?? null,
    });
    if (result.created) counts.questions += 1;
    questionIds.set(question.internalName, result.id);
  }
  return poolId;
}

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

async function evaluationByTitle(db: Db, classroomId: string, title: string) {
  const [row] = await db
    .select()
    .from(evaluations)
    .where(and(eq(evaluations.classroomId, classroomId), eq(evaluations.title, title)))
    .limit(1);
  return row ?? null;
}

/** The timing each preset needs before it may leave `draft` (F-EVAL-04). */
async function applyTiming(
  db: Db,
  row: evaluationService.EvaluationRecord,
  spec: EvaluationSpec,
  now: Date,
): Promise<evaluationService.EvaluationRecord> {
  if (spec.target === "scheduled") {
    const opensAt = new Date(now.getTime() + (spec.opensInDays ?? 2) * 24 * 60 * MINUTE);
    const closesAt = new Date(opensAt.getTime() + (spec.windowMinutes ?? 90) * MINUTE);
    return evaluationService.patchEvaluation(
      db,
      row,
      {
        settings: { timing: "deadline" },
        opensAt: opensAt.toISOString(),
        closesAt: closesAt.toISOString(),
      },
      { attemptCount: 0 },
    );
  }
  if (spec.durationS !== undefined) {
    return evaluationService.patchEvaluation(db, row, { durationS: spec.durationS }, {
      attemptCount: 0,
    });
  }
  return row;
}

/**
 * The closed evaluation: it really ran. The attempts are started, answered and
 * handed in through the live service at instants BEFORE `now`, so the grid
 * shows a session that ended rather than one that never opened.
 */
async function playClosedEvaluation(
  app: FastifyInstance,
  db: Db,
  row: evaluationService.EvaluationRecord,
  now: Date,
  questionIds: Map<string, string>,
  counts: DemoCounts,
): Promise<void> {
  const startedAt = new Date(now.getTime() - 50 * MINUTE);
  const closedAt = new Date(now.getTime() - 5 * MINUTE);
  const items = await evaluationService.itemRows(db, row.id);
  const itemIdByQuestion = new Map(items.map((i) => [i.questionId, i.id]));

  let evaluation = await live.startEvaluation(db, row, startedAt);

  for (const [index, paper] of PAPERS.entries()) {
    const userId = await userIdOfPersona(db, paper.persona);
    if (!userId) continue;
    const participant = await live.participantOf(db, evaluation, userId);
    if (!participant) continue;

    const created = await live.ensureAttempt(db, evaluation, participant, startedAt);
    const attempt = await live.beginAttempt(db, evaluation, created, participant, startedAt);
    counts.attempts += 1;

    // Spread the writes over the session so the timeline is not one instant.
    let at = new Date(startedAt.getTime() + (5 + index) * MINUTE);
    for (const [internalName, payload] of Object.entries(paper.answers)) {
      const questionId = questionIds.get(internalName);
      const itemId = questionId ? itemIdByQuestion.get(questionId) : undefined;
      if (!itemId) continue;
      at = new Date(at.getTime() + 2 * MINUTE);
      await live.saveAnswer(db, {
        evaluation,
        attempt,
        itemId,
        payload,
        revision: 1,
        now: at,
      });
      await live.markDone(db, { evaluation, attempt, itemId, done: true, now: at });
    }
    if (paper.submits) {
      await live.submitAttempt(db, evaluation, attempt, new Date(at.getTime() + MINUTE));
    }
  }

  // No `app` here: the pass is run explicitly below, so the seed can wait for
  // it instead of racing a queue.
  evaluation = await live.closeEvaluation(db, evaluation, closedAt);
  await runEvaluationGrading(app, { evaluationId: evaluation.id });
  counts.gradings = await gradingCount(db, evaluation.id);
  // Deliberately NOT released: the panel must have something to validate.
}

async function userIdOfPersona(db: Db, key: string): Promise<string | null> {
  const persona = PERSONAS.find((p) => p.key === key);
  if (!persona) return null;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.oidcSub, devSub(persona)))
    .limit(1);
  return row?.id ?? null;
}

async function gradingCount(db: Db, evaluationId: string): Promise<number> {
  const rows = await db
    .select({ state: gradings.state })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(and(eq(attempts.evaluationId, evaluationId), ne(gradings.state, "superseded")));
  return rows.length;
}

async function ensureEvaluation(
  app: FastifyInstance,
  db: Db,
  spec: EvaluationSpec,
  ctx: { classroomId: string; teacherId: string; questionIds: Map<string, string> },
  now: Date,
  counts: DemoCounts,
): Promise<boolean> {
  if (await evaluationByTitle(db, ctx.classroomId, spec.title)) return false;

  let row = await evaluationService.createEvaluation(db, {
    classroomId: ctx.classroomId,
    title: spec.title,
    mode: spec.mode,
    preset: spec.preset,
    createdBy: ctx.teacherId,
  });
  row = await applyTiming(db, row, spec, now);

  const questionIds = spec.questions
    .map((name) => ctx.questionIds.get(name))
    .filter((id): id is string => id !== undefined);
  await evaluationService.addItems(db, row, questionIds, defaultPoints, { attemptCount: 0 });
  row = (await evaluationService.byId(db, row.id))!;

  if (spec.target === "scheduled" || spec.target === "lobby") {
    await evaluationService.transition(db, row, spec.target, now);
  } else if (spec.target === "closed") {
    await playClosedEvaluation(app, db, row, now, ctx.questionIds, counts);
  }
  counts.evaluations += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface DemoContext {
  courseId: string;
  courseCode: string;
  classroomId: string;
  teacherId: string;
}

/**
 * Builds pools, questions and evaluations on top of the organisation the
 * caller has already seeded. Returns what it created, for the summary.
 */
export async function seedDemoContent(
  app: FastifyInstance,
  ctx: DemoContext,
  now: Date,
): Promise<DemoCounts> {
  const db = app.db;
  const counts: DemoCounts = {
    pools: 0,
    categories: 0,
    questions: 0,
    evaluations: 0,
    attempts: 0,
    gradings: 0,
  };
  const questionIds = new Map<string, string>();
  const linked: string[] = [];

  for (const spec of POOLS) {
    const poolId = await ensurePool(db, spec, ctx.teacherId, counts, questionIds);
    if (spec.courseCode === ctx.courseCode) linked.push(poolId);
  }
  // F-EVAL-01: an evaluation may only draw from the pools of its course.
  // `undefined` as the reachability predicate is the seed's privilege: it
  // runs as the owner of every pool it just created.
  await poolService.setCoursePools(db, ctx.courseId, linked, undefined);

  for (const spec of EVALUATIONS) {
    await ensureEvaluation(app, db, spec, { ...ctx, questionIds }, now, counts);
  }

  // Re-running the seed leaves the counter at zero; report what stands.
  if (counts.gradings === 0) {
    const row = await evaluationByTitle(db, ctx.classroomId, CLOSED_TITLE);
    if (row) counts.gradings = await gradingCount(db, row.id);
  }
  return counts;
}
