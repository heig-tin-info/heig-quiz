/**
 * The PROGRAM half of a student's player, shared by `code` and `codeimage`
 * (ADR-021): the statement with its badges, the template as a stack of
 * locked blocks and editable regions, and the Run button with the lines that
 * say where a run is and how it ended.
 *
 * What differs between the two types is what a run is judged against — a
 * table of visible cases, a picture — and each player renders that part
 * itself, around these pieces. Nothing here decides a verdict.
 */
import { useState, type ReactNode } from "react";

import { fmt } from "@quiz/core/client";
import type { MarkdownRenderer } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";

import { CodeArea } from "./MonacoHost.js";
import { initialRegions, stripMarkerLines, trimTrailingNewline } from "./segments.js";
import type { ProgramStudent } from "./schema.js";
import type { CodePlayerStrings } from "./strings.js";
import { badge, button, hint, lockedBlock, markdown } from "@quiz/ui";

/** Where a run is, for the one line the player shows while it gets there. */
export type CodeRunStage = "loading" | "compiling" | "running";

/** The keys of the player dictionary the program half reads. */
export type ProgramPlayerStrings = Pick<
  CodePlayerStrings,
  | "locked"
  | "editableRegion"
  | "run"
  | "running"
  | "loadingRuntime"
  | "inBrowser"
  | "runUnavailable"
  | "runFailed"
  | "files"
  | "compileFailed"
  | "compileOk"
  | "limits"
>;

/**
 * Where a run stands. `rate_limited` is the per-attempt budget of N-SEC-07,
 * which only a host that tells it apart reports; `code`'s host folds it into
 * `unavailable`.
 */
export type RunState =
  | { status: "idle" }
  | { status: "running"; stage: CodeRunStage }
  | { status: "unavailable" }
  | { status: "rate_limited" }
  | { status: "failed" }
  | { status: "done"; outcome: RunnerOutcome };

/** What a host's run resolves with; the two words are the graceful paths. */
export type ProgramRunResult = RunnerOutcome | "unavailable" | "rate_limited";

/**
 * One run slot: its state, and the function that fills it. The request, the
 * stages and the endings are the same for every run a player offers; only
 * what the host's function does differs.
 */
export function useRunSlot(): [
  RunState,
  (start: (onStage: (stage: CodeRunStage) => void) => Promise<ProgramRunResult>) => Promise<void>,
] {
  const [state, setState] = useState<RunState>({ status: "idle" });
  async function runInto(
    start: (onStage: (stage: CodeRunStage) => void) => Promise<ProgramRunResult>,
  ) {
    setState({ status: "running", stage: "loading" });
    try {
      const outcome = await start((stage) => setState({ status: "running", stage }));
      setState(
        outcome === "unavailable" || outcome === "rate_limited"
          ? { status: outcome }
          : { status: "done", outcome },
      );
    } catch {
      setState({ status: "failed" });
    }
  }
  return [state, runInto];
}

/** The regions as the student sees them: the answer's, else the template's own text. */
export function regionsOf(student: ProgramStudent, answer: { regions: string[] } | null): string[] {
  return initialRegions(student.segments).map((text, i) => answer?.regions[i] ?? text);
}

/** The statement, the language and limits as badges, and the extra files by name. */
export function ProgramStatement({
  student,
  s,
  renderMarkdown,
  badges,
}: {
  student: ProgramStudent;
  s: ProgramPlayerStrings;
  renderMarkdown: MarkdownRenderer | undefined;
  /** The type's own badges, after the shared ones. */
  badges?: ReactNode;
}): ReactNode {
  return (
    <>
      <div className="whitespace-pre-wrap text-sm text-fg">
        {markdown(renderMarkdown, student.prompt)}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={badge()}>{student.language}</span>
        <span className={badge()}>
          {fmt(s.limits, { timeMs: student.limits.timeMs, memoryMb: student.limits.memoryMb })}
        </span>
        {badges}
      </div>

      {student.filesPreview.length > 0 ? (
        <p className={hint}>
          {s.files} {student.filesPreview.map((f) => `${f.name} (${f.bytes} B)`).join(", ")}
        </p>
      ) : null}
    </>
  );
}

/**
 * The template as a STACK: one read-only block per locked segment, one editor
 * per editable region. A locked line is therefore never inside an editable
 * buffer; the server rebuilds the file from the stored template anyway
 * (invariant 14), and the stack is what makes that visible.
 */
export function ProgramRegions({
  student,
  regions,
  locked,
  onWrite,
  s,
  monaco,
}: {
  student: ProgramStudent;
  regions: readonly string[];
  locked: boolean;
  onWrite: (index: number, next: string) => void;
  s: ProgramPlayerStrings;
  monaco: boolean | undefined;
}): ReactNode {
  return (
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
            onChange={locked ? undefined : (next) => onWrite(index, next)}
            readOnly={locked}
            minLines={4}
            monaco={monaco}
          />
        );
      })}
    </div>
  );
}

/** The Run button: the primary action of a program question's run panel. */
export function RunButton({
  state,
  disabled,
  onClick,
  s,
}: {
  state: RunState;
  disabled: boolean;
  onClick: () => void;
  s: ProgramPlayerStrings;
}): ReactNode {
  return (
    <button
      type="button"
      className={button("primary", "sm", "ml-auto")}
      disabled={disabled}
      onClick={onClick}
    >
      {state.status === "running" ? s.running : s.run}
    </button>
  );
}

/**
 * The lines under the Run button: where the program runs, the one-time
 * runtime download, and how the last run ended — unavailable, refused by
 * the budget, failed, or compiled (with the compiler's words when it did
 * not).
 */
export function RunStatus({
  state,
  runtime,
  canRun,
  s,
  rateLimited,
}: {
  state: RunState;
  runtime: ProgramStudent["runtime"];
  canRun: boolean;
  s: ProgramPlayerStrings;
  /** The sentence for `rate_limited`; a host that never reports it passes none. */
  rateLimited?: string | undefined;
}): ReactNode {
  const outcome = state.status === "done" ? state.outcome : null;
  return (
    <>
      {/* One quiet line: where the program runs is a fact a student is owed,
          and it answers the question the button raises (ADR-015). */}
      {canRun && runtime === "runno" ? <p className={hint}>{s.inBrowser}</p> : null}
      {state.status === "running" && state.stage === "loading" ? (
        <p role="status" className={hint}>
          {s.loadingRuntime}
        </p>
      ) : null}

      {state.status === "unavailable" ? (
        <p role="status" className="rounded-field bg-warning-soft px-3 py-2 text-[13px] text-warning">
          {s.runUnavailable}
        </p>
      ) : null}
      {state.status === "rate_limited" && rateLimited !== undefined ? (
        <p role="status" className="rounded-field bg-warning-soft px-3 py-2 text-[13px] text-warning">
          {rateLimited}
        </p>
      ) : null}
      {state.status === "failed" ? (
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
    </>
  );
}
