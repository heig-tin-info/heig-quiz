/**
 * The pure half of the student's Run button (F-QST-09): what a student view
 * says about running, which cases a run may carry, and how its outcome is
 * judged. Shared by `POST /attempts/:id/run` (`./runs.ts`) and by the
 * teacher's stateless preview (`modules/preview`), so a visible case is
 * filtered and judged by one piece of code whoever pressed the button.
 * Nothing here reads the database or calls the runner.
 */
import type { RunnerResultEvent } from "@quiz/contracts";
import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";
import { caseVerdict } from "@quiz/qt-code/server";

/** What `type.toStudent` exposes about running; read structurally, never cast. */
export interface RunnableStudentView {
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

export function runnableView(student: unknown): RunnableStudentView {
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

/** The only check a free stdin try can make: the program exits 0. */
const FREE_TRY = { expected: "", compareStdout: false, expectedExitCode: 0 };

/**
 * The request of a Run, from the FIRST half of a grading (`type.grade`, which
 * assembled it server-side from the template and the regions — invariant 14).
 *
 * Only what the student may already see: their own stdin, or the VISIBLE
 * cases. The hidden half never leaves the grading worker. A visible case
 * keeps the `args` the TYPE put in the request; only the free-stdin try takes
 * a command line from the browser. A compile-only request carries NO case:
 * the runner stops after the build whatever the list holds, but an empty one
 * also keeps its container TTL (and the journal) honest about what was asked.
 */
export function visibleRunRequest(
  first: RunnerRequest,
  student: RunnableStudentView,
  input: {
    stdin?: string | undefined;
    args?: string[] | undefined;
    compileOnly?: boolean | undefined;
  },
): RunnerRequest {
  const visibleNames = new Set((student.visibleCases ?? []).map((c) => c.name));
  const compileOnly = input.compileOnly === true;
  const cases = compileOnly
    ? []
    : input.stdin === undefined
      ? first.cases.filter((c) => visibleNames.has(c.name))
      : [{ name: "stdin", args: input.args ?? [], stdin: input.stdin }];
  return {
    ...first,
    ...(compileOnly ? { action: "check" as const } : {}),
    cases,
    priority: "interactive",
  };
}

/** The outcome of a {@link visibleRunRequest}, judged case by case for the player. */
export function visibleRunResult(
  request: RunnerRequest,
  outcome: RunnerOutcome,
  student: RunnableStudentView,
): RunnerResultEvent["result"] {
  const specOf = new Map((student.visibleCases ?? []).map((c) => [c.name, c]));
  return {
    status: "ok",
    compile: { ok: outcome.compile.ok, stderr: outcome.compile.stderr },
    cases: request.cases.map((c, index) => {
      const run = outcome.cases[index];
      const spec = specOf.get(c.name);
      // Nothing to compare when the case does not compare stdout, and
      // nothing to show either.
      const expected = spec === undefined || !spec.compareStdout ? "" : spec.expected;
      // The grade's own rule, with the teacher's comparison options, so the
      // player's verdict and the grade cannot disagree (ADR-015, audit R-06).
      // A free stdin try has no case behind it: exit 0 is all it can mean.
      const verdict = caseVerdict(spec ?? FREE_TRY, run, student.compare);
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
}
