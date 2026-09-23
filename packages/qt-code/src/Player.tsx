/**
 * The student's view of a `code` question (docs/spec/04 §4.7).
 *
 * The template is rendered as a STACK: one read-only block per locked segment,
 * one editor per editable region. A locked line is therefore never inside an
 * editable buffer, and the answer is exactly what the contract says it is —
 * the editable regions, in order. The server rebuilds the file from the stored
 * template anyway (invariant 14); the stack is what makes that visible.
 *
 * "Run" is optional. With `RUNNER_MODE=stub` — the default until a machine
 * with Podman exists (decision D14) — `onRun` resolves with `"unavailable"`
 * and the panel says so in one line: the answer is still saved and still
 * graded, by hand if need be. Nothing about the question stops working.
 */
import { useId, useState } from "react";

import { fmt, plural, resolveStrings } from "@quiz/core/client";
import type { MarkdownRenderer, PlayerProps } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";
import { compareOutput } from "@quiz/domain/compareOutput";

import { CodeArea } from "./MonacoHost.js";
import { initialRegions, stripMarkerLines, trimTrailingNewline } from "./segments.js";
import type { CodeAnswer, CodeStudent } from "./schema.js";
import { PLAYER_STRINGS, type CodePlayerStrings } from "./strings.js";
import { badge, button, card, cx, hint, input, lockedBlock, sectionTitle, table } from "./styles.js";

/** Where a run is, for the one line the player shows while it gets there. */
export type CodeRunStage = "loading" | "compiling" | "running";

export interface CodeRunOptions {
  /**
   * Replaces the visible cases with a single input of the student's own — the
   * free stdin box of docs/spec/04 §4.7. Only honoured when the host says it
   * can (`allowManualRun`).
   */
  manual?: { args: string[]; stdin: string } | undefined;
  /**
   * Called as the run advances. The first run of a session downloads tens of
   * megabytes of language runtime; a button that just stays pressed for twenty
   * seconds reads as a broken page.
   */
  onStage?: ((stage: CodeRunStage) => void) | undefined;
}

interface CodePlayerProps extends PlayerProps<CodeStudent, CodeAnswer> {
  /**
   * Runs the VISIBLE cases and resolves with the runner's outcome, whose
   * `cases` are those visible cases in order. The host posts to
   * `POST /attempts/:id/run`, which assembles the request server-side.
   * `"unavailable"` is the graceful path, not a failure.
   */
  onRun?:
    | ((answer: CodeAnswer, options?: CodeRunOptions) => Promise<RunnerOutcome | "unavailable">)
    | undefined;
  /**
   * Whether the host can honour `CodeRunOptions.manual`. The student's player
   * can (both `POST /attempts/:id/run` and the browser runner take a free
   * input); the teacher's try panel cannot, because the API has no route that
   * RUNS a question outside an attempt.
   */
  allowManualRun?: boolean | undefined;
  strings?: Partial<CodePlayerStrings> | undefined;
  /** The host's sanitised markdown view; plain text when absent. */
  renderMarkdown?: MarkdownRenderer | undefined;
  /** Forces the Monaco path on or off (tests use the textarea). */
  monaco?: boolean | undefined;
}

type RunState =
  | { status: "idle" }
  | { status: "running"; stage: CodeRunStage }
  | { status: "unavailable" }
  | { status: "failed" }
  | { status: "done"; outcome: RunnerOutcome };

type VisibleCase = CodeStudent["visibleCases"][number];
type CaseResult = RunnerOutcome["cases"][number];

/**
 * What a case's result says, in the student's words.
 *
 * A case now carries two checks — the exit code and, optionally, the output —
 * so "Failed" alone no longer tells a student what to look at. The order is
 * the order a person debugs in: it did not run, it did not finish, it finished
 * wrong, it printed the wrong thing.
 */
function verdictOf(
  visibleCase: VisibleCase,
  result: CaseResult | undefined,
  compileOk: boolean,
  s: CodePlayerStrings,
): { label: string; ok: boolean | null } {
  if (!compileOk || result === undefined) return { label: s.notRun, ok: null };
  if (result.timedOut) return { label: s.timedOut, ok: false };
  if (result.oom) return { label: s.outOfMemory, ok: false };
  if (result.exitCode === null) return { label: s.crashed, ok: false };
  // A payload written before the case shape gained its two checks reads as
  // "exit 0 and the output matches", which is what it meant.
  const wantExit =
    visibleCase.expectedExitCode === undefined ? 0 : visibleCase.expectedExitCode;
  if (wantExit !== null && result.exitCode !== wantExit) {
    return { label: fmt(s.exitMismatch, { got: String(result.exitCode), want: wantExit }), ok: false };
  }
  if (
    visibleCase.compareStdout !== false &&
    !compareOutput(visibleCase.expected, result.stdout)
  ) {
    return { label: s.outputMismatch, ok: false };
  }
  return { label: s.passed, ok: true };
}

export function CodePlayer({
  student,
  answer,
  onChange,
  readOnly,
  onRun,
  allowManualRun,
  strings,
  renderMarkdown,
  monaco,
}: CodePlayerProps) {
  const s = resolveStrings(PLAYER_STRINGS, strings);
  const ids = useId();
  const [run, setRun] = useState<RunState>({ status: "idle" });
  /** The free input of §4.7: one argument per line, and a stdin of your own. */
  const [manualArgs, setManualArgs] = useState("");
  const [manualStdin, setManualStdin] = useState("");
  const [manual, setManual] = useState<RunState>({ status: "idle" });

  const seeded = initialRegions(student.segments);
  const regions = seeded.map((text, i) => answer?.regions[i] ?? text);

  const writeRegion = (index: number, next: string) => {
    const updated = regions.map((text, i) => (i === index ? next : text));
    onChange(
      answer?.lastRun === undefined || answer.lastRun === null
        ? { regions: updated }
        : { regions: updated, lastRun: answer.lastRun },
    );
  };

  async function runVisibleCases() {
    if (onRun === undefined) return;
    setRun({ status: "running", stage: "loading" });
    try {
      const outcome = await onRun(
        { regions },
        { onStage: (stage) => setRun({ status: "running", stage }) },
      );
      setRun(outcome === "unavailable" ? { status: "unavailable" } : { status: "done", outcome });
    } catch {
      setRun({ status: "failed" });
    }
  }

  async function runManual() {
    if (onRun === undefined) return;
    setManual({ status: "running", stage: "loading" });
    try {
      const outcome = await onRun(
        { regions },
        {
          manual: {
            args: manualArgs
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line !== ""),
            stdin: manualStdin,
          },
          onStage: (stage) => setManual({ status: "running", stage }),
        },
      );
      setManual(
        outcome === "unavailable" ? { status: "unavailable" } : { status: "done", outcome },
      );
    } catch {
      setManual({ status: "failed" });
    }
  }

  const outcome = run.status === "done" ? run.outcome : null;
  const manualResult = manual.status === "done" ? (manual.outcome.cases[0] ?? null) : null;
  const busy = run.status === "running" || manual.status === "running";

  return (
    <div className="flex flex-col gap-5">
      <div className="whitespace-pre-wrap text-sm text-fg">
        {renderMarkdown ? renderMarkdown(student.prompt) : student.prompt}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={badge()}>{student.language}</span>
        <span className={badge()}>
          {fmt(s.limits, { timeMs: student.limits.timeMs, memoryMb: student.limits.memoryMb })}
        </span>
        {student.allOrNothing ? <span className={badge("warning")}>{s.allOrNothing}</span> : null}
      </div>

      {student.filesPreview.length > 0 ? (
        <p className={hint}>
          {s.files}{" "}
          {student.filesPreview.map((f) => `${f.name} (${f.bytes} B)`).join(", ")}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        {student.segments.map((segment, i) => {
          if (segment.kind === "locked") {
            const text = trimTrailingNewline(stripMarkerLines(segment.text));
            if (text === "") return null;
            return (
              <pre key={i} className={lockedBlock} aria-label={s.locked} title={s.locked}>
                <code>{text}</code>
              </pre>
            );
          }
          const index = segment.index ?? 0;
          return (
            <CodeArea
              key={i}
              label={fmt(s.editableRegion, { n: index + 1 })}
              language={student.language}
              value={regions[index] ?? ""}
              onChange={readOnly ? undefined : (next) => writeRegion(index, next)}
              readOnly={readOnly}
              minLines={4}
              monaco={monaco}
            />
          );
        })}
      </div>

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center gap-3">
          <h3 className={sectionTitle}>{s.visibleCases}</h3>
          {onRun === undefined ? null : (
            <button
              type="button"
              className={button("primary", "sm", "ml-auto")}
              disabled={readOnly || busy}
              onClick={() => void runVisibleCases()}
            >
              {run.status === "running" ? s.running : s.run}
            </button>
          )}
        </div>
        <p className={hint}>{s.runHint}</p>
        {/* One quiet line: where the program runs is a fact a student is owed,
            and it answers the question the button raises (ADR-015). */}
        {onRun !== undefined && student.runtime === "runno" ? (
          <p className={hint}>{s.inBrowser}</p>
        ) : null}
        {run.status === "running" && run.stage === "loading" ? (
          <p role="status" className={hint}>
            {s.loadingRuntime}
          </p>
        ) : null}

        {run.status === "unavailable" ? (
          <p role="status" className="rounded-field bg-warning-soft px-3 py-2 text-[13px] text-warning">
            {s.runUnavailable}
          </p>
        ) : null}
        {run.status === "failed" ? (
          <p role="status" className="rounded-field bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {s.runFailed}
          </p>
        ) : null}
        {outcome !== null ? (
          <p role="status" className={hint}>
            {outcome.compile.ok ? s.compileOk : s.compileFailed}
            {outcome.compile.ok || outcome.compile.stderr === "" ? null : (
              <code className="mt-1 block whitespace-pre-wrap font-mono text-[13px] text-danger">
                {outcome.compile.stderr}
              </code>
            )}
          </p>
        ) : null}

        {student.visibleCases.length === 0 ? (
          <p className={hint}>{s.noVisibleCases}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th scope="col" className={table.th}>
                    {s.caseName}
                  </th>
                  <th scope="col" className={table.th}>
                    {s.stdin}
                  </th>
                  <th scope="col" className={table.th}>
                    {s.expected}
                  </th>
                  <th scope="col" className={table.th}>
                    {s.got}
                  </th>
                  <th scope="col" className={table.th}>
                    {s.verdict}
                  </th>
                </tr>
              </thead>
              <tbody>
                {student.visibleCases.map((visibleCase, i) => {
                  const result = outcome?.cases[i];
                  const verdict = verdictOf(
                    visibleCase,
                    result,
                    outcome?.compile.ok ?? false,
                    s,
                  );
                  return (
                    <tr key={i} className={table.row}>
                      <td className={cx(table.td, "font-medium")}>{visibleCase.name}</td>
                      <td className={cx(table.td, "whitespace-pre-wrap font-mono")}>
                        {/* The command line comes FIRST: a case that takes its
                            input from argv and nothing from stdin used to read
                            as "no input at all". */}
                        {(visibleCase.args ?? []).length > 0 ? (
                          <span className="block text-fg-muted">
                            {fmt(s.command, { args: (visibleCase.args ?? []).join(" ") })}
                          </span>
                        ) : null}
                        {visibleCase.stdin ||
                          ((visibleCase.args ?? []).length > 0 ? null : s.noStdin)}
                      </td>
                      <td className={cx(table.td, "whitespace-pre-wrap font-mono")}>
                        {visibleCase.compareStdout === false
                          ? s.expectedAnyOutput
                          : visibleCase.expected || "—"}
                      </td>
                      <td className={cx(table.td, "whitespace-pre-wrap font-mono")}>
                        {result === undefined ? "—" : result.stdout || "—"}
                        {result?.truncated ? (
                          <span className={badge("warning", "ml-1")}>{s.truncated}</span>
                        ) : null}
                      </td>
                      <td className={table.td}>
                        <span
                          className={badge(
                            verdict.ok === null ? "neutral" : verdict.ok ? "success" : "danger",
                          )}
                        >
                          {verdict.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {student.hiddenCount > 0 ? (
          <p className={hint}>{plural(s, "hiddenCases", student.hiddenCount, {
              count: student.hiddenCount,
              points: student.hiddenPoints,
            })}</p>
        ) : null}
      </section>

      {/*
       * The free try of §4.7: one command line and one stdin of the student's
       * own. It is the ONE thing a client chooses about a run — the visible
       * cases keep the arguments the teacher wrote, assembled server-side
       * (invariant 14) — and it exists only where the host can honour it.
       */}
      {onRun !== undefined && allowManualRun === true ? (
        <section className={cx(card, "flex flex-col gap-3 p-4")}>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className={sectionTitle}>{s.manual}</h3>
            <button
              type="button"
              className={button("secondary", "sm", "ml-auto")}
              disabled={readOnly || busy}
              onClick={() => void runManual()}
            >
              {manual.status === "running" ? s.running : s.manualRun}
            </button>
          </div>
          <p className={hint}>{s.manualHint}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label
                className="text-[13px] font-medium text-fg"
                htmlFor={`${ids}-manual-args`}
              >
                {s.manualArgs}
              </label>
              <textarea
                id={`${ids}-manual-args`}
                rows={2}
                aria-label={s.manualArgs}
                className={cx(input, "w-full py-1.5 font-mono")}
                disabled={readOnly}
                value={manualArgs}
                onChange={(e) => setManualArgs(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label
                className="text-[13px] font-medium text-fg"
                htmlFor={`${ids}-manual-stdin`}
              >
                {s.stdin}
              </label>
              <textarea
                id={`${ids}-manual-stdin`}
                rows={2}
                aria-label={s.stdin}
                className={cx(input, "w-full py-1.5 font-mono")}
                disabled={readOnly}
                value={manualStdin}
                onChange={(e) => setManualStdin(e.target.value)}
              />
            </div>
          </div>
          {manual.status === "unavailable" ? (
            <p role="status" className="rounded-field bg-warning-soft px-3 py-2 text-[13px] text-warning">
              {s.runUnavailable}
            </p>
          ) : null}
          {manual.status === "failed" ? (
            <p role="status" className="rounded-field bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {s.runFailed}
            </p>
          ) : null}
          {manualResult === null ? null : (
            <div className="flex flex-col gap-1.5">
              <h4 className="text-[13px] font-medium text-fg-muted">{s.manualOutput}</h4>
              <pre className={lockedBlock} aria-label={s.manualOutput}>
                <code>
                  {manualResult.stdout || manualResult.stderr || "—"}
                </code>
              </pre>
              <p className={hint}>
                {manualResult.timedOut
                  ? s.timedOut
                  : manualResult.oom
                    ? s.outOfMemory
                    : manualResult.exitCode === null
                      ? s.crashed
                      : fmt(s.exitCode, { code: String(manualResult.exitCode) })}
              </p>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

export default CodePlayer;
