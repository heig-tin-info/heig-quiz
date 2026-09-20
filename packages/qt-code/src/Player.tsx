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
import { useState } from "react";

import type { MarkdownRenderer, PlayerProps } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";
import { compareOutput } from "@quiz/domain";

import { CodeArea } from "./MonacoHost.js";
import { initialRegions, stripMarkerLines, trimTrailingNewline } from "./segments.js";
import type { CodeAnswer, CodeStudent } from "./schema.js";
import { PLAYER_STRINGS, withStrings, type CodePlayerStrings } from "./strings.js";
import { badge, button, card, cx, hint, lockedBlock, sectionTitle, table } from "./styles.js";

export interface CodePlayerProps extends PlayerProps<CodeStudent, CodeAnswer> {
  /**
   * Runs the VISIBLE cases and resolves with the runner's outcome, whose
   * `cases` are those visible cases in order. The host posts to
   * `POST /attempts/:id/run`, which assembles the request server-side.
   * `"unavailable"` is the graceful path, not a failure.
   */
  onRun?: ((answer: CodeAnswer) => Promise<RunnerOutcome | "unavailable">) | undefined;
  strings?: Partial<CodePlayerStrings> | undefined;
  /** The host's sanitised markdown view; plain text when absent. */
  renderMarkdown?: MarkdownRenderer | undefined;
  /** Forces the Monaco path on or off (tests use the textarea). */
  monaco?: boolean | undefined;
}

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "unavailable" }
  | { status: "failed" }
  | { status: "done"; outcome: RunnerOutcome };

export function CodePlayer({
  student,
  answer,
  onChange,
  readOnly,
  onRun,
  strings,
  renderMarkdown,
  monaco,
}: CodePlayerProps) {
  const s = withStrings(PLAYER_STRINGS, strings);
  const [run, setRun] = useState<RunState>({ status: "idle" });

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
    setRun({ status: "running" });
    try {
      const outcome = await onRun({ regions });
      setRun(outcome === "unavailable" ? { status: "unavailable" } : { status: "done", outcome });
    } catch {
      setRun({ status: "failed" });
    }
  }

  const outcome = run.status === "done" ? run.outcome : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="whitespace-pre-wrap text-sm text-fg">
        {renderMarkdown ? renderMarkdown(student.prompt) : student.prompt}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={badge()}>{student.language}</span>
        <span className={badge()}>{s.limits(student.limits.timeMs, student.limits.memoryMb)}</span>
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
              label={s.editableRegion(index + 1)}
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
              disabled={readOnly || run.status === "running"}
              onClick={() => void runVisibleCases()}
            >
              {run.status === "running" ? s.running : s.run}
            </button>
          )}
        </div>
        <p className={hint}>{s.runHint}</p>

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
                  const passed =
                    result !== undefined &&
                    outcome !== null &&
                    outcome.compile.ok &&
                    result.exitCode === 0 &&
                    !result.timedOut &&
                    !result.oom &&
                    compareOutput(visibleCase.expected, result.stdout);
                  const verdict =
                    result === undefined
                      ? s.notRun
                      : result.timedOut
                        ? s.timedOut
                        : result.oom
                          ? s.outOfMemory
                          : passed
                            ? s.passed
                            : s.failed;
                  return (
                    <tr key={i} className={table.row}>
                      <td className={cx(table.td, "font-medium")}>{visibleCase.name}</td>
                      <td className={cx(table.td, "whitespace-pre-wrap font-mono")}>
                        {visibleCase.stdin || "—"}
                      </td>
                      <td className={cx(table.td, "whitespace-pre-wrap font-mono")}>
                        {visibleCase.expected || "—"}
                      </td>
                      <td className={cx(table.td, "whitespace-pre-wrap font-mono")}>
                        {result === undefined ? "—" : result.stdout || "—"}
                      </td>
                      <td className={table.td}>
                        <span
                          className={badge(
                            result === undefined ? "neutral" : passed ? "success" : "danger",
                          )}
                        >
                          {verdict}
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
          <p className={hint}>{s.hiddenCases(student.hiddenCount, student.hiddenPoints)}</p>
        ) : null}
      </section>
    </div>
  );
}

export default CodePlayer;
