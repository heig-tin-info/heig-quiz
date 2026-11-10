/**
 * The evaluation pass (`grading.evaluation`, see `jobs.ts`): one walk over
 * (attempts × items), and the check of one exercise question (ADR-124 §3)
 * graded by the same cell grader.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";

import type { GradeContext, GradeResult, LlmGradeRequest, RunnerRequest } from "@quiz/core/server";
import {
  INSTANCE_WARNING_KEY,
  type GradingConfidence,
  type GradingSource,
  type GradingState,
} from "@quiz/contracts";
import { isGraded, isPendingRunner } from "@quiz/core/server";
import { gradableNow, itemPoints, round2, rulesForAttempt, type AcceptanceRule } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { answers, attempts, officialAttempt } from "../../db/schema.js";
import { GRADING_LLM_QUEUE, GRADING_RUNNER_QUEUE } from "../../jobs.js";
import {
  byId,
  gradeDefaults,
  joinedItems,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { hasKey, typeOf } from "../pool/config.js";
import { studentViewOf } from "../live/studentView.js";
import { configPerAttempt, exampleConfig, isParameterized } from "../pool/service.js";
import type { StoredInstance } from "../../db/columns.js";
import * as events from "./events.js";
import { keepsLlmProposal, offersLlm, runLlmGrading } from "./llmPass.js";
import {
  endOf,
  failedProposal,
  passGuard,
  type EvaluationGradingJob,
  type LlmGradingJob,
  type RunnerGradingJob,
} from "./passCommon.js";
import {
  acceptanceGuard,
  acceptanceHook,
  acceptancesOf,
  type ItemRules,
  type RuleBound,
} from "./acceptanceRules.js";
import { announceGradingReady } from "./ready.js";
import { standingGradings } from "./reads.js";
import { pairKey, type AttemptRecord, type GradingRecord, type PairKey } from "./records.js";
import { runRunnerGrading } from "./runnerPass.js";
import { writeGradings, type WriteGradingInput } from "./writer.js";

/** How often the progress event goes out while a pass is running (§5.4). */
const PROGRESS_EVERY = 25;

/** Low priority: a container run must never delay the deterministic half. */
const RUNNER_PRIORITY = -10;

/** What one pass reads up front: the grid, and what already stands on it. */
interface Pass {
  items: JoinedItem[];
  attempts: AttemptRecord[];
  answers: Map<PairKey, typeof answers.$inferSelect>;
  standing: Map<PairKey, GradingRecord>;
  teacherIds: string[];
  /** The answers accepted at grading time on each item (ADR-128). */
  acceptances: ItemRules;
}

/** The reads of a pass, or `null` when the grid is empty and there is nothing to do. */
async function loadPass(
  db: Db,
  evaluation: EvaluationRecord,
  job: EvaluationGradingJob,
): Promise<Pass | null> {
  const allItems = await joinedItems(db, evaluation.id);
  const items = job.itemIds ? allItems.filter((i) => job.itemIds!.includes(i.item.id)) : allItems;
  const attemptRows = await db
    .select()
    .from(attempts)
    .where(
      job.attemptIds
        ? and(eq(attempts.evaluationId, evaluation.id), inArray(attempts.id, job.attemptIds))
        : // The close's pass, a re-run, a regrade: the official attempts. A
          // practice attempt (ADR-122) is graded by its own hand-in's pass.
          and(eq(attempts.evaluationId, evaluation.id), officialAttempt),
    );
  // While the evaluation runs, only a finished attempt is graded (ADR-067):
  // one reopened since the hand-in that sent this pass is graded at its next.
  // A practice attempt, only once finished. The write checks it again,
  // under the attempt's lock (`passGuard`).
  const gradable = attemptRows.filter((a) => gradableNow(evaluation.state, a));
  if (items.length === 0 || gradable.length === 0) return null;

  const answerRows = await db
    .select()
    .from(answers)
    .where(
      inArray(
        answers.attemptId,
        gradable.map((a) => a.id),
      ),
    );
  return {
    items,
    attempts: gradable,
    answers: new Map(answerRows.map((a) => [pairKey(a.attemptId, a.itemId), a])),
    standing: await standingGradings(db, evaluation.id, { attemptIds: gradable.map((a) => a.id) }),
    teacherIds: await events.staffOf(db, evaluation),
    acceptances: await acceptancesOf(db, items.map((i) => i.item.id)),
  };
}

/**
 * The progress events of a pass (§5.4): one every {@link PROGRESS_EVERY}
 * cells walked, skipped or graded alike, and a final one, once the batch is
 * written, that says what is left.
 */
function progressReporter(evaluation: EvaluationRecord, teacherIds: string[], total: number) {
  let done = 0;
  let sinceEvent = 0;
  return {
    /** One cell walked. */
    tick(): void {
      done += 1;
      sinceEvent += 1;
      if (sinceEvent < PROGRESS_EVERY) return;
      sinceEvent = 0;
      events.progress(evaluation, teacherIds, { done, total, phase: "auto" });
    },
    finish(phase: "pending" | "done"): void {
      events.progress(evaluation, teacherIds, { done, total, phase });
    },
  };
}

/** One item's config for one attempt, and the warning of its instance (ADR-056 §7). */
export interface CellConfig {
  config: unknown;
  warning?: StoredInstance["fallback"];
}

/**
 * The stored config of one item through `loadConfig`, the ONE read pipeline
 * (§1.6): migrated and parsed once per item, not once per attempt — but for
 * a parameterized question, whose every attempt has its own instance, read
 * from the values the attempt stored (ADR-056 §5; replayed under a version
 * a regrade retargeted). `null` when it cannot be read, and the cell
 * becomes a proposal.
 */
export function readConfig(
  app: FastifyInstance,
  item: JoinedItem,
): { configOf: (attempt: AttemptRecord) => CellConfig | null; keyed: boolean } {
  const type = item.question.type;
  const unreadable = (err: unknown) => {
    app.log.error({ err, itemId: item.item.id }, "grading: unreadable question config");
    return null;
  };
  let perAttempt: ReturnType<typeof configPerAttempt>;
  let keyed: boolean;
  try {
    perAttempt = configPerAttempt(item);
    // Whether it holds a key is a matter of structure: the config already
    // parsed when static (it ignores the attempt), the example instance when
    // parameterized.
    keyed = hasKey(type, isParameterized(item.version) ? exampleConfig(type, item.version) : perAttempt(NO_ATTEMPT));
  } catch (err) {
    // Unreadable: every cell says so on its own (`config_unreadable`).
    unreadable(err);
    return { configOf: () => null, keyed: true };
  }
  return {
    keyed,
    configOf: (attempt) => {
      try {
        const config = perAttempt(attempt);
        // A draw served from a fallback (ADR-056 §7): the teacher is told.
        const warning = attempt.instances[item.item.id]?.fallback;
        return warning ? { config, warning } : { config };
      } catch (err) {
        return unreadable(err);
      }
    },
  };
}

/** No attempt at all: what a static item's config, which reads none, is asked with. */
export const NO_ATTEMPT = { seed: 0, instances: {} };

/**
 * One cell that no teacher has settled yet: the grading to write, or the
 * runner job it needs. The pass writes the gradings in one batch, and
 * enqueues the runner jobs only once that batch is written. The answers
 * accepted at grading time (ADR-128) reach the type through its context.
 */
export async function gradeCell(
  app: FastifyInstance,
  cell: {
    evaluation: EvaluationRecord;
    job: EvaluationGradingJob;
    item: JoinedItem;
    config: CellConfig | null;
    attempt: AttemptRecord;
    answer: typeof answers.$inferSelect | null;
    /** Whether a model may be asked (`offersLlm`), decided once per pass. */
    llm: boolean;
    /**
     * The acceptances in force on the item (ADR-128): the cell is graded
     * with those for everyone and the attempt's own — none on a practice
     * attempt (ADR-122), graded against the pool's key like the drill.
     */
    rules: readonly AcceptanceRule[];
  },
): Promise<{ write: WriteGradingInput } | { runner: RunnerGradingJob } | { llm: LlmGradingJob }> {
  const { evaluation, job, item, attempt, answer } = cell;
  const base = {
    attemptId: attempt.id,
    itemId: item.item.id,
    answerId: answer?.id ?? null,
    maxPoints: item.item.points,
    now: app.clock.now(),
    ...(job.regradeNote === undefined ? {} : { regradeNote: job.regradeNote }),
  };

  if (cell.config === null) return { write: { ...base, ...failedProposal("config_unreadable") } };
  const { config, warning } = cell.config;
  if (answer === null) {
    // ADR-125 §14: on a paper copy, a written answer nobody typed in is not
    // a blank — the scan may hold it. Proposed at zero, no grader, no model.
    if (attempt.origin === "paper" && freeZonesOnly(item, config, attempt)) {
      return { write: { ...base, ...failedProposal("paper_free_zone") } };
    }
    // F-GRADE-01: an absent answer is worth zero, and it is settled.
    //
    // With NO details: `gradings.details` is the question type's own
    // breakdown, and no type ever ran here. A marker of another shape is
    // handed to that type's `Review` further down the line, which is how
    // a feedback page dies on `details.cases.filter`. The record of what
    // happened is `answerId: null` beside the zero.
    return { write: { ...base, points: 0, source: "auto", state: "validated", details: null } };
  }

  const outcome = await gradeOne(app, {
    type: item.question.type,
    config,
    payload: answer.payload,
    ctx: {
      seed: attempt.seed,
      itemId: item.item.id,
      attemptId: attempt.id,
      itemPoints: item.item.points,
      now: base.now,
      runner: app.runner,
      ...(cell.llm ? { llm: true as const } : {}),
      // The evaluation's per-type settings: what a question config
      // that says "inherit" defers to (an mcq's scoring policy).
      defaults: gradeDefaults(evaluation),
      ...acceptedContext(rulesForAttempt(cell.rules, { id: attempt.id, practice: attempt.afterDue })),
    },
  });
  if (outcome.kind === "written") {
    // The one place an automatic grade becomes an item's points: stored raw,
    // a bonus floored where the sums read it (ADR-108).
    const points = itemPoints(outcome.grading.points);
    return { write: { ...base, ...outcome.grading, details: withWarning(outcome.grading.details, warning), points } };
  }
  const cellOf = {
    evaluationId: evaluation.id,
    attemptId: attempt.id,
    itemId: item.item.id,
    answerId: answer.id,
    ...(job.regradeNote === undefined ? {} : { regradeNote: job.regradeNote }),
  };
  if (outcome.kind === "llm") {
    const details = withWarning(outcome.details, warning);
    return { llm: { ...cellOf, request: outcome.request, details, ...(attempt.afterDue ? { practice: true } : {}) } };
  }
  return {
    runner: {
      ...cellOf,
      revision: answer.revision,
      request: outcome.request,
      finalizeState: outcome.finalizeState,
    },
  };
}

/** The context's `accepted`, left out when there is none (ADR-128). */
const acceptedContext = (accepted: readonly { part: string; answer: string }[]) =>
  accepted.length === 0 ? {} : { accepted };

/**
 * A cell to grade, bound to the rules it is graded with (ADR-128): its
 * grading now, and how to grade it again should the rules move before the
 * write (`acceptanceGuard`).
 */
export async function boundCell(
  app: FastifyInstance,
  cell: Parameters<typeof gradeCell>[1],
): Promise<{ graded: Awaited<ReturnType<typeof gradeCell>>; bound: RuleBound }> {
  const regrade = async (rules: readonly AcceptanceRule[]) => {
    const again = await gradeCell(app, { ...cell, rules });
    return "write" in again ? again.write : null;
  };
  return {
    graded: await gradeCell(app, cell),
    bound: { rules: cell.rules, versionId: cell.item.item.questionVersionId, regrade },
  };
}

/**
 * Whether every answer zone the item prints is `free` (ADR-125 §6, §14) —
 * an essay's: what the type declares through `answerZone` on the view the
 * paper was printed in. A type without the hook prints nothing, and is no
 * free zone.
 */
function freeZonesOnly(item: JoinedItem, config: unknown, attempt: AttemptRecord): boolean {
  const type = item.question.type;
  const zoneOf = typeOf(type).answerZone;
  if (!zoneOf) return false;
  const student = studentViewOf(type, config, { seed: attempt.seed, itemId: item.item.id, shuffle: false });
  const zones = zoneOf(student).filter((block) => block.kind === "answerZone");
  return zones.length > 0 && zones.every((zone) => zone.zone === "free");
}

/**
 * The details of a grading, with the warning of an instance served from a
 * fallback draw (ADR-056 §7) for the teacher; untouched otherwise. Never a
 * student's: `filterDetails` strips the key under every policy.
 */
function withWarning(details: unknown, warning: CellConfig["warning"]): unknown {
  if (warning === undefined) return details;
  const own = details !== null && typeof details === "object" && !Array.isArray(details) ? details : {};
  return { ...own, [INSTANCE_WARNING_KEY]: warning };
}

/**
 * One pass over (attempts × items). Exported because it IS the unit under
 * test: a db test calls it directly and asserts the rows it wrote, with no
 * queue and no timer anywhere.
 */
export async function runEvaluationGrading(
  app: FastifyInstance,
  job: EvaluationGradingJob,
): Promise<void> {
  const evaluation = await byId(app.db, job.evaluationId);
  if (!evaluation) return;
  const pass = await loadPass(app.db, evaluation, job);
  if (!pass) return;

  const progress = progressReporter(
    evaluation,
    pass.teacherIds,
    pass.items.length * pass.attempts.length,
  );
  const llm = await offersLlm(app, evaluation);
  const runnerJobs: RunnerGradingJob[] = [];
  const llmJobs: LlmGradingJob[] = [];
  // Every grading of the pass, written at the end by ONE batched writer
  // (D-01): a transaction per 500 cells instead of one per cell. A pass that
  // dies half-way writes nothing and is simply run again (idempotency).
  const writes: WriteGradingInput[] = [];
  // ADR-128: the cells of an item that takes acceptances, written only with
  // the rules in force at the write (`acceptanceGuard`).
  const bound = new Map<PairKey, RuleBound>();
  for (const item of pass.items) {
    const { configOf, keyed } = readConfig(app, item);
    const accepting = acceptanceHook(item.question.type, evaluation.mode) !== undefined;
    // An opinion poll's question has no key (ADR-014, addendum 2026-09-23):
    // there is nothing to be right about, so nothing is written — not a
    // zero per answer, which would mark the whole room wrong.
    if (!keyed) {
      for (const _ of pass.attempts) progress.tick();
      continue;
    }
    for (const attempt of pass.attempts) {
      const key = pairKey(attempt.id, item.item.id);
      const standing = pass.standing.get(key);
      const answer = pass.answers.get(key) ?? null;
      // Idempotency (§5.4): a cell a teacher already settled is never
      // touched again, so running the job twice changes nothing; nor is a
      // model asked twice for the same answer (ADR-063 §3).
      if (standing?.state !== "validated" && !(standing && keepsLlmProposal(standing, answer, job))) {
        const config = configOf(attempt);
        const rules = pass.acceptances.get(item.item.id) ?? [];
        const { graded, bound: cell } = await boundCell(app, { evaluation, job, item, config, attempt, answer, llm, rules });
        if ("write" in graded) {
          writes.push(graded.write);
          if (accepting) bound.set(key, cell);
        }
        else if ("runner" in graded) runnerJobs.push(graded.runner);
        else llmJobs.push(graded.llm);
      }
      progress.tick();
    }
  }
  await writeGradings(
    app.db,
    writes,
    acceptanceGuard(passGuard(new Map(pass.attempts.map((a) => [a.id, endOf(a.closedAt)]))), bound),
  );
  progress.finish(runnerJobs.length + llmJobs.length > 0 ? "pending" : "done");
  for (const runnerJob of runnerJobs) {
    await enqueueOrRun(app, GRADING_RUNNER_QUEUE, runnerJob, runRunnerGrading, { priority: RUNNER_PRIORITY });
  }
  for (const llmJob of llmJobs) await enqueueOrRun(app, GRADING_LLM_QUEUE, llmJob, runLlmGrading);
  // After its own write, whatever the pass filled: the grid as it stands
  // now, with every runner job that committed meanwhile (#286).
  await announceGradingReady(app, evaluation);
}

/**
 * What a check of one question of an exercise (ADR-124 §3) settles, graded
 * by the pass's own cell grader — the same `type.grade`, config and context
 * as the hand-in's, so the check and the hand-in can never disagree. Writes
 * nothing:
 *
 *   - `write`: a VALIDATED automatic grade, the instant verdict, which the
 *     check writes with {@link writeCheckGrading} once the question is
 *     marked checked;
 *   - `runner` (code, circuit): the job the check sends with
 *     {@link enqueueCheckRun} once the question is checked;
 *   - `null`: a proposal (an essay, a manual circuit, an unreadable answer),
 *     `pending: llm`, or a question with no key — no model is asked while the
 *     evaluation runs (ADR-067 §1, F-LLM-03), and the hand-in's or the
 *     close's pass grades the cell as it grades every other.
 */
export async function checkGrading(
  app: FastifyInstance,
  cell: {
    evaluation: EvaluationRecord;
    item: JoinedItem;
    attempt: AttemptRecord;
    answer: typeof answers.$inferSelect;
  },
): Promise<{ write: WriteGradingInput; bound: RuleBound | null } | { runner: RunnerGradingJob } | null> {
  const { evaluation, item, attempt, answer } = cell;
  const { configOf, keyed } = readConfig(app, item);
  // A question with no key (an opinion) has nothing to be right about.
  if (!keyed) return null;
  const { graded, bound } = await boundCell(app, {
    evaluation,
    job: { evaluationId: evaluation.id },
    item,
    config: configOf(attempt),
    attempt,
    answer,
    llm: false,
    // ADR-124: the check of an exercise is graded with the acceptances too.
    rules: (await acceptancesOf(app.db, [item.item.id])).get(item.item.id) ?? [],
  });
  if ("runner" in graded) return graded;
  if (!("write" in graded) || graded.write.state !== "validated") return null;
  // Written through the acceptances' guard, as the pass's (ADR-128 §13).
  return { write: graded.write, bound: acceptanceHook(item.question.type, evaluation.mode) ? bound : null };
}

/**
 * The instant verdict of a check, written once the question is marked
 * checked, under the attempt's row lock (`passGuard`, which keeps a checked
 * cell gradable while its attempt is open). The checked answer cannot move:
 * every write statement refuses a checked row. `null` when the guard
 * dropped the write.
 */
export async function writeCheckGrading(
  app: FastifyInstance,
  { write, bound }: { write: WriteGradingInput; bound: RuleBound | null },
): Promise<GradingRecord | null> {
  const cells = new Map(bound ? [[pairKey(write.attemptId, write.itemId), bound]] : []);
  const [written] = await writeGradings(app.db, [write], acceptanceGuard(passGuard(), cells));
  return written ?? null;
}

/**
 * A check's runner job, sent once the question is checked, at the queue's
 * default priority: ahead of the hand-in passes' jobs, since a student
 * waits on it. Its verdict lands on the cell later; the player reads the
 * attempt again.
 *
 * Handed in while this job still waits, the attempt's pass finds no
 * validated grading on the cell and sends a job of its own: a bounded
 * duplicate, accepted rather than tracked by an in-flight marker — the
 * runner jobs run one at a time in order of priority, so the check's runs
 * first, and the pass's then finds the cell validated (`isValidated`) and
 * runs nothing.
 *
 * Without a queue (`JOBS_DISABLED`, development on PGlite, the route tests)
 * the job runs inline, and the check's request waits for the runner.
 */
export async function enqueueCheckRun(app: FastifyInstance, job: RunnerGradingJob): Promise<void> {
  await enqueueOrRun(app, GRADING_RUNNER_QUEUE, job, runRunnerGrading);
}

type GradeOutcome =
  | {
      kind: "written";
      grading: {
        points: number;
        source: GradingSource;
        state: Exclude<GradingState, "superseded">;
        details: unknown;
        comment?: string;
        confidence?: GradingConfidence;
      };
    }
  | { kind: "runner"; request: RunnerRequest; finalizeState?: unknown }
  | { kind: "llm"; request: LlmGradeRequest; details?: unknown };

/**
 * One answer through `type.grade`. Everything that can go wrong — an answer
 * that no longer satisfies the type's own schema, a grader that throws — ends
 * as a PROPOSAL with a machine reason, never as a crash and never as a silent
 * zero: a teacher decides.
 */
async function gradeOne(
  app: FastifyInstance,
  input: {
    type: string;
    config: unknown;
    payload: unknown;
    ctx: GradeContext;
  },
): Promise<GradeOutcome> {
  const type = typeOf(input.type);
  // W5-5: the JSON value `null` is "seen, nothing typed", and that is exactly
  // what `grade(config, null, …)` means (F-GRADE-01).
  let answer: unknown = null;
  if (input.payload !== null) {
    const parsed = type.answerSchema.safeParse(input.payload);
    if (!parsed.success) {
      return { kind: "written", grading: failedProposal("answer_invalid") };
    }
    answer = parsed.data;
  }

  let result: GradeResult<unknown>;
  try {
    result = await type.grade(input.config, answer, input.ctx);
  } catch (err) {
    app.log.error({ err, itemId: input.ctx.itemId }, "grading: grader threw");
    return { kind: "written", grading: failedProposal("grader_error") };
  }

  if (isGraded(result)) {
    return {
      kind: "written",
      grading: {
        points: round2(result.points),
        source: "auto",
        state: result.state ?? "validated",
        details: result.details,
        ...(result.comment === undefined ? {} : { comment: result.comment }),
      },
    };
  }
  if (isPendingRunner(result)) {
    return {
      kind: "runner",
      request: result.request,
      finalizeState: result.finalizeState,
    };
  }
  // A type asks for a model only when `ctx.llm` is offered (F-LLM-03).
  if (!input.ctx.llm) return { kind: "written", grading: failedProposal("llm_not_configured", "llm") };
  return { kind: "llm", request: result.request, details: result.details };
}

/** One job of a pass on its queue, or run inline when this process has none (see `enqueueEvaluationGrading`). */
async function enqueueOrRun<T extends object>(
  app: FastifyInstance,
  name: string,
  job: T,
  run: (app: FastifyInstance, job: T) => Promise<void>,
  options?: { priority: number },
): Promise<void> {
  if (!app.boss) {
    await run(app, job);
    return;
  }
  await app.boss.send(name, job, options);
}
