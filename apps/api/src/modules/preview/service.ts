/**
 * The teacher's stateless preview of a whole evaluation (issue #75, ADR-018
 * fourth addendum).
 *
 * A preview is a SEED and nothing else. `startPreview` draws one and hands
 * back the evaluation as a student holding an attempt of that seed would get
 * it; the answers then live in the teacher's browser, and `gradePreview`
 * grades them all at once. Between the two, `runPreview` and
 * `simulatePreview` are the player's own buttons. Not one of these functions
 * writes a row: no attempt, no answer, no journal entry, no grading, no audit
 * entry (a preview changes nothing there would be to audit).
 *
 * What it reuses rather than re-implements, so that it cannot drift from the
 * real path:
 *   - the student payload is `live.previewView` with the drawn seed, which is
 *     the builder of `attemptView` (item order, shuffles, `toStudent`,
 *     invariant 4);
 *   - the item content is ALWAYS re-read from the evaluation's frozen
 *     versions; the browser sends answers and a seed, never a question, and a
 *     code source is rebuilt by the type from the template and the regions
 *     (invariant 14);
 *   - the grading is `type.grade` then, for a runner type, one run of the
 *     WHOLE request (hidden cases included) and `type.finalizeRunner` — the
 *     two halves the grading pass runs — with the evaluation's own settings
 *     (`gradeDefaults`, the item points, the scale);
 *   - a Run is `visibleRunRequest` / `visibleRunResult`, the helpers
 *     `POST /attempts/:id/run` uses.
 */
import { randomInt } from "node:crypto";

import type {
  EvaluationPreview,
  ItemPreview,
  PreviewCorrection,
  PreviewCorrectionItem,
  PreviewItemStatus,
  RunnerResultEvent,
} from "@quiz/contracts";
import {
  RunnerBusy,
  RunnerUnavailable,
  type FinalizeContext,
  type GradedResult,
  type RunnerOutcome,
  type RunnerService,
} from "@quiz/core/server";
import { compilesPerMinute, gradeFromPoints, previewDurationS, round2 } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import {
  gradeDefaults,
  joinedItem,
  joinedItems,
  scaleOf,
  settingsOf,
  totalPointsOf,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { verdictOf } from "../grading/service.js";
import * as live from "../live/service.js";
import { solutionView, studentView } from "../live/studentView.js";
import { runnableView, visibleRunRequest, visibleRunResult } from "../live/visibleRun.js";
import { hasKey, loadConfig, typeOf } from "../pool/config.js";

// --- Failures -------------------------------------------------------------

export class PreviewError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "PreviewError";
  }
}

const notFound = () => new PreviewError("not_found", 404);
const notRunnable = () =>
  new PreviewError("not_runnable", 422, { message: "this question type has nothing to run" });

/** `503 runner_unavailable` with its reason, like `POST /attempts/:id/run`. */
function runnerDown(error: unknown): PreviewError | null {
  if (error instanceof RunnerBusy) return new PreviewError("runner_unavailable", 503, { reason: "busy" });
  if (error instanceof RunnerUnavailable) {
    return new PreviewError("runner_unavailable", 503, { reason: error.reason });
  }
  return null;
}

// --- Budgets ----------------------------------------------------------------

/**
 * The per-minute budgets of a preview, in memory. An attempt counts its runs
 * in its journal (N-SEC-07); a preview has no journal and must not grow one,
 * so the window lives here: runs keyed by teacher AND evaluation (one budget
 * for all the items, like an attempt's), compilations likewise under a key
 * of their own, gradings by teacher. It is per process and lost on
 * restart, which is the right weight for a budget that protects the runner
 * from a held-down button, not from a determined colleague.
 */
class Budget {
  private readonly hits = new Map<string, number[]>();

  /** Spends one unit of `key`, or throws `429 rate_limited`. */
  spend(key: string, limit: number, now: Date): void {
    const since = now.getTime() - 60_000;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      throw new PreviewError("rate_limited", 429, { retryAfterS: 60 });
    }
    recent.push(now.getTime());
    this.hits.set(key, recent);
    // Keep the map from growing with every teacher who ever pressed a button.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => t <= since)) this.hits.delete(k);
    }
  }
}

const budget = new Budget();

/** A student's run budget when the question publishes none (`live/runs.ts`). */
const DEFAULT_RUNS_PER_MINUTE = 10;

/**
 * Gradings per minute and teacher. A grading may run every code question of
 * the evaluation with all its cases, so it is the expensive call; ten a
 * minute is far above what a person clicking "Submit" does.
 */
export const GRADES_PER_MINUTE = 10;

// --- Starting ---------------------------------------------------------------

/** A fresh seed, in the range an attempt's is drawn in. */
export function drawPreviewSeed(): number {
  return randomInt(0, 0x7fffffff);
}

/**
 * `POST /evaluations/:id/preview`: the evaluation as a student with an
 * attempt of `seed` would get it, with the clock the preview counts down.
 */
export async function startPreview(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
  seed: number,
): Promise<EvaluationPreview> {
  const settings = settingsOf(evaluation);
  const view = await live.previewView(db, evaluation, now, seed);
  return {
    seed,
    durationS: previewDurationS({
      timing: settings.timing,
      durationS: evaluation.durationS,
      opensAt: evaluation.opensAt,
      closesAt: evaluation.closesAt,
    }),
    view,
  };
}

/**
 * `GET /evaluations/:id/preview/items/:itemId`: one item, at the version the
 * evaluation froze, as a student will see it (issue #127). Seed 0 and no
 * shuffle, like the question editor's preview (decision D19), and through
 * `studentView` — the one student exit (invariant 4). The item is looked up
 * INSIDE the evaluation the guard loaded, so an item of another evaluation
 * is a 404 like a missing one (invariant 6), whoever owns its pool.
 */
export async function itemPreview(
  db: Db,
  evaluation: EvaluationRecord,
  itemId: string,
): Promise<ItemPreview> {
  const joined = await joinedItem(db, evaluation.id, itemId);
  if (!joined) throw notFound();
  const type = joined.question.type;
  const version = { config: joined.version.config, configVersion: joined.version.configVersion };
  return {
    itemId: joined.item.id,
    type,
    versionNumber: joined.version.number ?? 0,
    points: joined.item.points,
    student: studentView({ type, version, seed: 0, itemId: joined.item.id, shuffle: false }),
  };
}

// --- Running ------------------------------------------------------------------

/** One item of the evaluation, with its config read through the ONE pipeline. */
async function previewItem(db: Db, evaluation: EvaluationRecord, itemId: string, seed: number) {
  const joined = await joinedItem(db, evaluation.id, itemId);
  // An item of another evaluation is indistinguishable from none (invariant 6).
  if (!joined) throw notFound();
  const version = { config: joined.version.config, configVersion: joined.version.configVersion };
  return {
    joined,
    type: typeOf(joined.question.type),
    config: loadConfig(joined.question.type, version) as unknown,
    // What the Run button may see: the published half, never the hidden one.
    // No shuffle: a run is about cases, and `live/runs.ts` reads it the same way.
    student: runnableView(
      studentView({ type: joined.question.type, version, seed, itemId, shuffle: false }),
    ),
  };
}

function finalizeContext(
  evaluation: EvaluationRecord,
  item: JoinedItem,
  seed: number,
  now: Date,
): FinalizeContext {
  return {
    seed,
    itemId: item.item.id,
    attemptId: live.PREVIEW_ATTEMPT_ID,
    itemPoints: item.item.points,
    now,
    // The same per-type settings as the grading pass (an mcq's policy).
    defaults: gradeDefaults(evaluation),
  };
}

/**
 * `POST /evaluations/:id/preview/run`: the student's Run button, the VISIBLE
 * cases only (or the teacher's own stdin), the source rebuilt server-side.
 */
export async function runPreview(
  db: Db,
  input: {
    runner: RunnerService;
    evaluation: EvaluationRecord;
    userId: string;
    seed: number;
    itemId: string;
    regions: string[];
    stdin?: string | undefined;
    args?: string[] | undefined;
    compileOnly?: boolean | undefined;
    now: Date;
  },
): Promise<RunnerResultEvent["result"]> {
  const { evaluation, now } = input;
  const { joined, type, config, student } = await previewItem(db, evaluation, input.itemId, input.seed);
  if (!type.finalizeRunner) throw notRunnable();
  // A compilation spends its own, larger budget, never a test run's
  // (ADR-024, addendum of 2026-09-25) — the attempt's rule, keyed apart.
  const runs = student.runsPerMinute ?? DEFAULT_RUNS_PER_MINUTE;
  if (input.compileOnly === true) {
    budget.spend(`compile:${input.userId}:${evaluation.id}`, compilesPerMinute(runs), now);
  } else {
    budget.spend(`run:${input.userId}:${evaluation.id}`, runs, now);
  }
  const answer = type.answerSchema.safeParse({ regions: input.regions });
  if (!answer.success) {
    throw new PreviewError("answer_invalid", 422, { details: answer.error.issues });
  }
  const ctx = finalizeContext(evaluation, joined, input.seed, now);
  const first = await type.grade(config, answer.data, { ...ctx, runner: input.runner });
  if (first.kind !== "pending" || first.via !== "runner") throw notRunnable();
  const request = visibleRunRequest(first.request, student, input);
  let outcome: RunnerOutcome;
  try {
    outcome = await input.runner.run(request);
  } catch (error) {
    throw runnerDown(error) ?? error;
  }
  return visibleRunResult(request, outcome, student);
}

/**
 * `POST /evaluations/:id/preview/simulate`: the Simulate button of a type
 * that builds its own request (ADR-019), from the stored config and the
 * parsed answer (invariant 14).
 */
export async function simulatePreview(
  db: Db,
  input: {
    runner: RunnerService;
    evaluation: EvaluationRecord;
    userId: string;
    seed: number;
    itemId: string;
    answer: unknown;
    now: Date;
  },
): Promise<RunnerOutcome> {
  const { evaluation, now } = input;
  const { joined, type, config, student } = await previewItem(db, evaluation, input.itemId, input.seed);
  if (!type.interactiveRequest) throw notRunnable();
  budget.spend(
    `run:${input.userId}:${evaluation.id}`,
    student.simulationsPerMinute ?? student.runsPerMinute ?? DEFAULT_RUNS_PER_MINUTE,
    now,
  );
  const answer = type.answerSchema.safeParse(input.answer);
  if (!answer.success) {
    throw new PreviewError("answer_invalid", 422, { details: answer.error.issues });
  }
  const built = type.interactiveRequest(
    config,
    answer.data,
    finalizeContext(evaluation, joined, input.seed, now),
  );
  if (built === null) {
    throw new PreviewError("nothing_to_run", 422, { message: "this answer has nothing to run yet" });
  }
  try {
    return await input.runner.run({ ...built, priority: "interactive" });
  } catch (error) {
    throw runnerDown(error) ?? error;
  }
}

// --- Grading ------------------------------------------------------------------

interface ItemOutcome {
  status: PreviewItemStatus;
  points: number | null;
  details: unknown;
}

const ungraded = (status: PreviewItemStatus): ItemOutcome => ({ status, points: null, details: null });

/** One answer through both halves of a grading, exactly as the grading pass runs them. */
async function gradeItem(
  runner: RunnerService,
  evaluation: EvaluationRecord,
  item: JoinedItem,
  seed: number,
  payload: unknown,
  now: Date,
  log: (err: unknown, msg: string) => void,
): Promise<ItemOutcome> {
  const type = typeOf(item.question.type);
  let config: unknown;
  try {
    config = loadConfig(item.question.type, {
      config: item.version.config,
      configVersion: item.version.configVersion,
    });
  } catch (err) {
    log(err, "preview: unreadable question config");
    return ungraded("grader_error");
  }
  // An opinion question has nothing to be right about (ADR-014 addendum).
  if (!hasKey(item.question.type, config)) return ungraded("no_key");
  // F-GRADE-01: an item never touched is worth zero, and it is settled.
  if (payload === undefined) return { status: "graded", points: 0, details: null };

  let answer: unknown = null;
  if (payload !== null) {
    const parsed = type.answerSchema.safeParse(payload);
    if (!parsed.success) return { status: "answer_invalid", points: 0, details: null };
    answer = parsed.data;
  }

  const ctx = finalizeContext(evaluation, item, seed, now);
  const settle = (result: GradedResult<unknown>): ItemOutcome => ({
    status: "graded",
    points: round2(result.points),
    details: result.details,
  });
  try {
    const first = await type.grade(config, answer, { ...ctx, runner });
    if (first.kind === "graded") return settle(first);
    if (first.via === "llm") return ungraded("llm_unavailable");
    if (!type.finalizeRunner) return ungraded("runner_unavailable");
    // The WHOLE request, hidden cases included: this is the final grading.
    const outcome = await runner.run(first.request);
    return settle(type.finalizeRunner(config, answer, ctx, outcome));
  } catch (error) {
    if (error instanceof RunnerUnavailable || error instanceof RunnerBusy) {
      return ungraded("runner_unavailable");
    }
    log(error, "preview: grader threw");
    return ungraded("grader_error");
  }
}

/**
 * `POST /evaluations/:id/preview/grade`: every item of the evaluation graded
 * under its settings, and the full correction — whatever the feedback policy
 * says, because the reader is the teacher who wrote the key.
 *
 * The items come back in the order the preview was played in, which the seed
 * alone determines. Grading is sequential: a real grading pass runs the
 * runner at low priority for the same reason — one teacher's rehearsal must
 * not take every container a class is using.
 */
export async function gradePreview(
  db: Db,
  input: {
    runner: RunnerService;
    evaluation: EvaluationRecord;
    userId: string;
    seed: number;
    answers: Readonly<Record<string, unknown>>;
    now: Date;
    log: (err: unknown, msg: string) => void;
  },
): Promise<PreviewCorrection> {
  const { evaluation, seed, now } = input;
  budget.spend(`grade:${input.userId}`, GRADES_PER_MINUTE, now);

  const view = await live.previewView(db, evaluation, now, seed);
  const byId = new Map((await joinedItems(db, evaluation.id)).map((i) => [i.item.id, i]));
  // An answer to an item this evaluation does not hold is a stale tab (the
  // teacher edited the structure since): it is ignored, never trusted.
  const answers = new Map(Object.entries(input.answers));

  const items: PreviewCorrectionItem[] = [];
  let points = 0;
  let pending = 0;
  for (const [rank, shown] of view.items.entries()) {
    const item = byId.get(shown.id);
    // Removed between the two reads (a draft stays editable during a
    // preview): there is nothing left to grade, and no reason to fail.
    if (!item) continue;
    const payload = answers.has(shown.id) ? answers.get(shown.id) : undefined;
    const outcome = await gradeItem(input.runner, evaluation, item, seed, payload, now, input.log);
    if (outcome.points !== null) points += outcome.points;
    if (outcome.status !== "graded" && outcome.status !== "no_key") pending += 1;
    const version = { config: item.version.config, configVersion: item.version.configVersion };
    items.push({
      itemId: shown.id,
      position: rank,
      type: item.question.type,
      status: outcome.status,
      points: outcome.points,
      maxPoints: item.item.points,
      verdict:
        outcome.status === "graded" && outcome.points !== null
          ? verdictOf({ points: outcome.points, maxPoints: item.item.points, state: "validated" })
          : null,
      // The very payload the player showed: the same builder, the same seed.
      student: shown.student,
      answer: payload ?? null,
      // As the student's own feedback page builds it (`results/service.ts`).
      solution: outcome.status === "no_key"
        ? null
        : solutionView({ type: item.question.type, version, seed, itemId: shown.id }),
      explanation: item.version.explanation === "" ? null : item.version.explanation,
      details: outcome.details ?? null,
    });
  }

  points = round2(points);
  const totalPoints = totalPointsOf(view.items);
  const scale = scaleOf(evaluation);
  return {
    seed,
    points,
    totalPoints,
    grade: gradeFromPoints(points, totalPoints, scale),
    scale,
    ungraded: pending,
    items,
  };
}
