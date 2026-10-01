/**
 * Running code and simulating a schematic for a student (F-QST-09), behind
 * the same gate as an answer write and the per-attempt rate limit. Imported
 * through `./service.ts`.
 */
import { randomUUID } from "node:crypto";

import type { RunnerResultEvent } from "@quiz/contracts";
import {
  RunnerBusy,
  RunnerUnavailable,
  type AnyQuestionTypeServer,
  type FinalizeContext,
  type RunnerOutcome,
  type RunnerRequest,
  type RunnerService,
} from "@quiz/core/server";
import { shuffle } from "@quiz/core/rng";
import { compilesPerMinute } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { itemInstance } from "../pool/service.js";
import type { EvaluationRecord } from "../evaluation/service.js";
import { gradeDefaults, joinedItem } from "../evaluation/service.js";
import * as events from "./events.js";
import { studentView } from "./studentView.js";
import {
  runButton,
  runnableView,
  visibleRunRequest,
  visibleRunResult,
  type RunnableStudentView,
} from "./visibleRun.js";
import {
  type AttemptRecord,
  LiveError,
  AnswerInvalid,
  RateLimited,
  RunnerDown,
  NotRunnable,
  NothingToRun,
  assertWritable,
} from "./attempt.js";
import { logAttemptEvent, countRecentEvents } from "./autosave.js";

// --- Running code (F-QST-09 for the student side) -------------------------

const DEFAULT_RUNS_PER_MINUTE = 10;

/**
 * The common gate of `POST /attempts/:id/run` and `/simulate`, in this order:
 * the attempt is writable (invariant 5), the item belongs to the evaluation,
 * the type has the capability the button needs, the journal-counted budget
 * is not spent (N-SEC-07), the answer parses under the type's own schema
 * (invariant 7), and the stored config loads.
 */
async function attemptRunContext<T>(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    now: Date;
    /** The hook the button runs through; `undefined` is `not_runnable`. */
    capability: (type: AnyQuestionTypeServer, student: RunnableStudentView) => T | undefined;
    /** The per-minute budget the type publishes in its student view. */
    budget: (student: RunnableStudentView) => number | undefined;
    /**
     * The Compile button's run: it spends its own, larger budget
     * (`compilesPerMinute`), never the test runs' (ADR-024, addendum of
     * 2026-09-25). Every other run leaves the compilations out of its count.
     */
    compileOnly?: boolean | undefined;
    answer: unknown;
  },
) {
  const { evaluation, attempt, itemId, now } = input;
  // The server owns the clock: a run is a write's worth of work, so it is
  // refused past the deadline exactly like an autosave (invariant 5).
  assertWritable(evaluation, attempt, now);
  const joined = await joinedItem(db, evaluation.id, itemId);
  // 404 and not 403: an item of another evaluation is indistinguishable from
  // one that does not exist (invariant 6).
  if (!joined) throw new LiveError("not_found", 404);

  const type = typeOf(joined.question.type);
  const { version } = itemInstance(joined, attempt);
  const student = runnableView(
    studentView({ type: joined.question.type, version, seed: attempt.seed, itemId, shuffle: false }),
  );
  const capability = input.capability(type, student);
  if (capability === undefined) throw new NotRunnable();

  // N-SEC-07: the budget is the question's own, counted from the journal
  // rather than from a table of its own. Both buttons count `run` events, so
  // a student cannot double their budget by using both on one attempt. A
  // compilation is counted apart, against its own budget: compiling never
  // costs a test run, and a spent test budget still lets the student compile.
  const compileOnly = input.compileOnly === true;
  const runs = input.budget(student) ?? DEFAULT_RUNS_PER_MINUTE;
  const limit = compileOnly ? compilesPerMinute(runs) : runs;
  const used = await countRecentEvents(db, attempt.id, "run", new Date(now.getTime() - 60_000), {
    compileOnly,
  });
  if (used >= limit) throw new RateLimited(60);

  const answer = type.answerSchema.safeParse(input.answer);
  if (!answer.success) throw new AnswerInvalid(answer.error.issues);

  const config: unknown = loadConfig(joined.question.type, version);
  const ctx: FinalizeContext = {
    seed: attempt.seed,
    itemId,
    attemptId: attempt.id,
    itemPoints: joined.item.points,
    now,
    // Same per-type settings as the grading pass: what the student tries
    // must not be scored under a different policy than the final grading.
    defaults: gradeDefaults(evaluation),
  };
  return { type, capability, student, config, answer: answer.data as unknown, ctx };
}

/**
 * The attempts with a run in flight. The journal-counted budget is
 * count-then-insert, so parallel requests of one attempt would all read the
 * same count and all pass; one run at a time per attempt closes that race,
 * and keeps one student from filling the runner's few slots. In memory: the
 * API is one process (ADR-001), like the SSE bus and the preview budget.
 */
const inFlight = new Set<string>();

async function oneAtATime<R>(attemptId: string, run: () => Promise<R>): Promise<R> {
  if (inFlight.has(attemptId)) throw new RateLimited(1);
  inFlight.add(attemptId);
  try {
    return await run();
  } finally {
    inFlight.delete(attemptId);
  }
}

/** {@link runVisibleCasesNow}, one at a time per attempt. */
export function runVisibleCases(db: Db, input: RunInput) {
  return oneAtATime(input.attempt.id, () => runVisibleCasesNow(db, input));
}

/** {@link simulateAnswerNow}, one at a time per attempt. */
export function simulateAnswer(db: Db, input: SimulateInput) {
  return oneAtATime(input.attempt.id, () => simulateAnswerNow(db, input));
}

/**
 * Journals a student's run (nothing student-supplied: the file names are the
 * type's, invariant 14), then runs it; a busy or absent runner is the 503.
 */
async function runForStudent(
  db: Db,
  input: { runner: RunnerService; attempt: AttemptRecord; request: RunnerRequest; now: Date },
  details: Record<string, unknown>,
): Promise<{ requestId: string; outcome: RunnerOutcome }> {
  const requestId = randomUUID();
  await logAttemptEvent(db, input.attempt.id, "run", { ...details, requestId }, input.now);
  try {
    return { requestId, outcome: await input.runner.run(input.request) };
  } catch (error) {
    if (error instanceof RunnerBusy) throw new RunnerDown("busy");
    if (error instanceof RunnerUnavailable) throw new RunnerDown(error.reason);
    throw error;
  }
}

interface RunInput {
  runner: RunnerService;
  evaluation: EvaluationRecord;
  attempt: AttemptRecord;
  itemId: string;
  regions: string[];
  stdin?: string | undefined;
  /** The command line of the free-stdin try; a visible case keeps the teacher's. */
  args?: string[] | undefined;
  /**
   * The Compile button: the runner builds the program (`action: "check"`)
   * and runs no case at all. It spends its own budget, `compilesPerMinute`,
   * never a test run's (ADR-024, addendum of 2026-09-25), and journals
   * `compileOnly: true`, which is how the two budgets are told apart.
   */
  compileOnly?: boolean | undefined;
  now: Date;
}

/**
 * `POST /attempts/:id/run` — the student's Run button.
 *
 * Only the VISIBLE cases are sent (or the student's own stdin), the source is
 * rebuilt server-side from the template and the editable regions (invariant
 * 14), and the outcome is published as `runner.result` on the student's own
 * topic. With `RUNNER_MODE=stub` — the default everywhere until a machine
 * with Podman exists (decision D14) — this ends in `503 runner_unavailable`,
 * which is a configuration, not a failure.
 */
async function runVisibleCasesNow(
  db: Db,
  input: RunInput,
): Promise<{ requestId: string; result: RunnerResultEvent["result"] }> {
  const { attempt, itemId } = input;
  const prepared = await attemptRunContext(db, {
    ...input,
    // The button of a type judged case by case (`runButton`); a type with no
    // second half has nothing a runner could finish.
    capability: (type, student) =>
      runButton(type, student) === "run" ? type.interactiveRequest?.bind(type) : undefined,
    budget: (student) => student.runsPerMinute,
    compileOnly: input.compileOnly,
    answer: { regions: input.regions },
  });
  // The type assembles the request server-side from the template and the
  // regions (invariant 14), the visible cases only; nothing the browser sent
  // becomes a file name. `null`: an empty answer, or one that no longer fits.
  const visible = prepared.capability(prepared.config, prepared.answer, prepared.ctx);
  if (visible === null) throw new NotRunnable();

  const request = visibleRunRequest(visible, input);
  const { requestId, outcome } = await runForStudent(
    db,
    { ...input, request },
    input.compileOnly === true ? { itemId, compileOnly: true } : { itemId },
  );
  const result = visibleRunResult(request, outcome, prepared.student, input.stdin !== undefined);

  // The result travels on the student's own topic (§4.8) AND in the response,
  // so a client that lost its stream is not left waiting.
  // `POST /attempts/:id/run` is reached through `ownAttempt`, so the owner
  // is always an account here; a poll runs no code.
  if (attempt.userId !== null) events.runnerResult(attempt.userId, requestId, itemId, result);
  return { requestId, result };
}

interface SimulateInput {
  runner: RunnerService;
  evaluation: EvaluationRecord;
  attempt: AttemptRecord;
  itemId: string;
  answer: unknown;
  now: Date;
}

/**
 * `POST /attempts/:id/simulate` — the student's own button, for a type that
 * builds its OWN request (ADR-019).
 *
 * The generic half of `runVisibleCases`: same gate, same budget, same
 * journal, but the request comes from `type.interactiveRequest` instead of
 * from the first half of a grading. The type assembles it server-side from
 * the STORED config and the parsed answer (invariant 14) and puts in it only
 * what the student may already see — a `circuit` sends the visible stimuli
 * and never the reference's waveform. Nothing here inspects the request: the
 * live module does not know what a netlist is.
 *
 * The outcome comes back raw, in the response and nowhere else. A `code` run
 * needs an SSE frame because its result is a verdict the dashboard also
 * cares about; a simulation is a curve the student asked for, so the response
 * is the delivery.
 */
async function simulateAnswerNow(db: Db, input: SimulateInput): Promise<RunnerOutcome> {
  const prepared = await attemptRunContext(db, {
    ...input,
    // A type with a button of its own; one judged case by case goes through
    // `/run` and nowhere else (`runButton`).
    capability: (type, student) =>
      runButton(type, student) === "simulate" ? type.interactiveRequest?.bind(type) : undefined,
    // The same budget as `/run`, under whichever name the type publishes it:
    // a circuit says `simulationsPerMinute`, a code question `runsPerMinute`.
    budget: (student) => student.simulationsPerMinute ?? student.runsPerMinute,
    // Invariant 7's second half: the envelope was parsed by `SimulateBody`,
    // the payload is parsed by the schema the type and the client share.
    answer: input.answer,
  });
  const built = prepared.capability(prepared.config, prepared.answer, prepared.ctx);
  if (built === null) throw new NothingToRun();

  // `kind: "simulate"` tells the two buttons apart in the journal; the EVENT
  // stays a `run`, because the budget is one and the audit union is closed
  // (invariant 9).
  const request: RunnerRequest = { ...built, priority: "interactive" };
  const { outcome } = await runForStudent(db, { ...input, request }, {
    itemId: input.itemId,
    kind: "simulate",
  });
  return outcome;
}
