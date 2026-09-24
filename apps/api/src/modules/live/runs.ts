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
import { caseVerdict } from "@quiz/qt-code/server";

import type { Db } from "../../db/client.js";
import { loadConfig, typeOf } from "../pool/config.js";
import type { EvaluationRecord } from "../evaluation/service.js";
import { gradeDefaults } from "../evaluation/service.js";
import * as events from "./events.js";
import { studentView } from "./studentView.js";
import {
  type AttemptRecord,
  LiveError,
  AnswerInvalid,
  RateLimited,
  RunnerDown,
  NotRunnable,
  NothingToRun,
  assertWritable,
  itemOf,
} from "./attempt.js";
import { logAttemptEvent, countRecentEvents } from "./autosave.js";

// --- Running code (F-QST-09 for the student side) -------------------------

/** What `type.toStudent` exposes about running; read structurally, never cast. */
interface RunnableStudentView {
  runsPerMinute?: number;
  /** The same budget under the name the `circuit` type gives it (ADR-019). */
  simulationsPerMinute?: number;
  visibleCases?: {
    name: string;
    stdin: string;
    expected: string;
    compareStdout: boolean;
    expectedExitCode: number | null;
  }[];
  /** How a visible case's output is compared: the grade's own options (R-06). */
  compare?: CaseCompare;
}

type CaseCompare = NonNullable<Parameters<typeof caseVerdict>[2]>;

/** The comparison options of a student view, read field by field. */
function compareOf(raw: unknown): CaseCompare | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const out: CaseCompare = {};
  if (typeof c["trimTrailing"] === "boolean") out.trimTrailing = c["trimTrailing"];
  if (typeof c["ignoreCase"] === "boolean") out.ignoreCase = c["ignoreCase"];
  const numeric = c["numeric"];
  if (numeric === null) out.numeric = null;
  else if (typeof numeric === "object") {
    const { epsilon, mode } = numeric as Record<string, unknown>;
    if (typeof epsilon === "number" && (mode === "abs" || mode === "rel")) {
      out.numeric = { epsilon, mode };
    }
  }
  return out;
}

function runnableView(student: unknown): RunnableStudentView {
  if (student === null || typeof student !== "object") return {};
  const source = student as Record<string, unknown>;
  const out: RunnableStudentView = {};
  if (typeof source["runsPerMinute"] === "number") out.runsPerMinute = source["runsPerMinute"];
  if (typeof source["simulationsPerMinute"] === "number") {
    out.simulationsPerMinute = source["simulationsPerMinute"];
  }
  if (Array.isArray(source["visibleCases"])) {
    out.visibleCases = source["visibleCases"].flatMap((raw) => {
      if (raw === null || typeof raw !== "object") return [];
      const c = raw as Record<string, unknown>;
      // The two checks default the way the schema defaults them, so a type
      // that says nothing about them still means "compare stdout, want 0".
      return typeof c["name"] === "string"
        ? [
            {
              name: c["name"],
              stdin: typeof c["stdin"] === "string" ? c["stdin"] : "",
              expected: typeof c["expected"] === "string" ? c["expected"] : "",
              compareStdout: c["compareStdout"] !== false,
              expectedExitCode:
                c["expectedExitCode"] === null
                  ? null
                  : typeof c["expectedExitCode"] === "number"
                    ? c["expectedExitCode"]
                    : 0,
            },
          ]
        : [];
    });
  }
  const compare = compareOf(source["compare"]);
  if (compare !== undefined) out.compare = compare;
  return out;
}

const DEFAULT_RUNS_PER_MINUTE = 10;

/** The only check a free stdin try can make: the program exits 0. */
const FREE_TRY = { expected: "", compareStdout: false, expectedExitCode: 0 };

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
    capability: (type: AnyQuestionTypeServer) => T | undefined;
    /** The per-minute budget the type publishes in its student view. */
    budget: (student: RunnableStudentView) => number | undefined;
    answer: unknown;
  },
) {
  const { evaluation, attempt, itemId, now } = input;
  // The server owns the clock: a run is a write's worth of work, so it is
  // refused past the deadline exactly like an autosave (invariant 5).
  assertWritable(evaluation, attempt, now);
  const joined = await itemOf(db, evaluation.id, itemId);
  // 404 and not 403: an item of another evaluation is indistinguishable from
  // one that does not exist (invariant 6).
  if (!joined) throw new LiveError("not_found", 404);

  const type = typeOf(joined.question.type);
  const capability = input.capability(type);
  if (capability === undefined) throw new NotRunnable();

  const version = { config: joined.version.config, configVersion: joined.version.configVersion };
  const student = runnableView(
    studentView({ type: joined.question.type, version, seed: attempt.seed, itemId, shuffle: false }),
  );

  // N-SEC-07: the budget is the question's own, counted from the journal
  // rather than from a table of its own. Both buttons count `run` events, so
  // a student cannot double their budget by using both on one attempt.
  const limit = input.budget(student) ?? DEFAULT_RUNS_PER_MINUTE;
  const used = await countRecentEvents(db, attempt.id, "run", new Date(now.getTime() - 60_000));
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
export async function runVisibleCases(
  db: Db,
  input: {
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
     * and runs no case at all. It spends the same budget as a run — a
     * compilation is most of a run's cost — and journals `compileOnly: true`.
     */
    compileOnly?: boolean | undefined;
    now: Date;
  },
): Promise<{ requestId: string; result: RunnerResultEvent["result"] }> {
  const { attempt, itemId } = input;
  const prepared = await attemptRunContext(db, {
    ...input,
    // A type with no second half has nothing a runner could finish.
    capability: (type) => type.finalizeRunner,
    budget: (student) => student.runsPerMinute,
    answer: { regions: input.regions },
  });
  const { type, config, answer, ctx } = prepared;
  const first = await type.grade(config, answer, { ...ctx, runner: input.runner });
  // `grade` assembles the request server-side from the template and the
  // regions (invariant 14); nothing the browser sent becomes a file name.
  if (first.kind !== "pending" || first.via !== "runner") throw new NotRunnable();

  const visible = prepared.student.visibleCases ?? [];
  const visibleNames = new Set(visible.map((c) => c.name));
  const specOf = new Map(visible.map((c) => [c.name, c]));
  // Only what the student may already see: their own stdin, or the VISIBLE
  // cases. The hidden half never leaves the grading worker. A visible case
  // keeps the `args` the TYPE put in the request (invariant 14); only the
  // free-stdin try takes a command line from the browser.
  // A compile-only request carries NO case: the runner stops after the build
  // whatever the list holds, but an empty one also keeps its container TTL
  // (and the journal) honest about what was asked.
  const compileOnly = input.compileOnly === true;
  const cases = compileOnly
    ? []
    : input.stdin === undefined
      ? first.request.cases.filter((c) => visibleNames.has(c.name))
      : [{ name: "stdin", args: input.args ?? [], stdin: input.stdin }];
  const request: RunnerRequest = {
    ...first.request,
    ...(compileOnly ? { action: "check" as const } : {}),
    cases,
    priority: "interactive",
  };

  const { requestId, outcome } = await runForStudent(
    db,
    { ...input, request },
    compileOnly ? { itemId, compileOnly: true } : { itemId },
  );
  const result: RunnerResultEvent["result"] = {
    status: "ok",
    compile: { ok: outcome.compile.ok, stderr: outcome.compile.stderr },
    cases: cases.map((c, index) => {
      const run = outcome.cases[index];
      const spec = specOf.get(c.name);
      // Nothing to compare when the case does not compare stdout, and
      // nothing to show either.
      const expected = spec === undefined || !spec.compareStdout ? "" : spec.expected;
      // The grade's own rule, with the teacher's comparison options, so the
      // player's verdict and the grade cannot disagree (ADR-015, audit R-06).
      // A free stdin try has no case behind it: exit 0 is all it can mean.
      const verdict = caseVerdict(spec ?? FREE_TRY, run, prepared.student.compare);
      return {
        name: c.name,
        ok: verdict.ok,
        // The facts the player names the failure by ("exit 1 ≠ 0", "Output
        // differs", "Timed out"): the same fields a browser run reports.
        exitCode: run?.exitCode ?? null,
        stdout: run?.stdout ?? "",
        stderr: run?.stderr ?? "",
        expected,
        ms: run?.ms ?? 0,
        timedOut: run?.timedOut ?? false,
        oom: run?.oom ?? false,
        truncated: run?.truncated ?? false,
      };
    }),
  };

  // The result travels on the student's own topic (§4.8) AND in the response,
  // so a client that lost its stream is not left waiting.
  // `POST /attempts/:id/run` is reached through `ownAttempt`, so the owner
  // is always an account here; a poll runs no code.
  if (attempt.userId !== null) events.runnerResult(attempt.userId, requestId, itemId, result);
  return { requestId, result };
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
export async function simulateAnswer(
  db: Db,
  input: {
    runner: RunnerService;
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    answer: unknown;
    now: Date;
  },
): Promise<RunnerOutcome> {
  const prepared = await attemptRunContext(db, {
    ...input,
    // A type with no button of its own. `code` is not one of them: it keeps
    // its older, case-filtering `/run` route.
    capability: (type) => type.interactiveRequest?.bind(type),
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
