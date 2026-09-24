/**
 * The PROGRAM half of a student's player, shared by `code` and `codeimage`
 * (ADR-021): the statement with its badges, the program in one editor whose
 * locked lines are read-only, and the Run button with the lines that
 * say where a run is and how it ended.
 *
 * What differs between the two types is what a run is judged against — a
 * table of visible cases, a picture — and each player renders that part
 * itself, around these pieces. Nothing here decides a verdict.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { fmt } from "@quiz/core/client";
import { decayedUses, effectiveCooldownMs, type CooldownMode } from "@quiz/domain/cooldown";
import { mainFileName } from "@quiz/domain/lockedTemplate";
import type { MarkdownRenderer } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";

import { parseDiagnostics } from "./diagnostics.js";
import { LockedEditor } from "./LockedEditor.js";
import { initialRegions } from "./segments.js";
import type { ProgramStudent } from "./schema.js";
import type { CodePlayerStrings } from "./strings.js";
import { badge, button, cx, hint, markdown } from "@quiz/ui";

/** Where a run is, for the one line the player shows while it gets there. */
export type CodeRunStage = "loading" | "compiling" | "running";

/** The keys of the player dictionary the program half reads. */
export type ProgramPlayerStrings = Pick<
  CodePlayerStrings,
  | "locked"
  | "program"
  | "editableRegion"
  | "run"
  | "running"
  | "availableIn"
  | "unchangedRun"
  | "loadingRuntime"
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
 * One run slot: its state, the function that fills it, and the KEY of the
 * last run that completed. The request, the stages and the endings are the
 * same for every run a player offers; only what the host's function does
 * differs.
 *
 * The key is whatever the caller says the run was made of (the regions, and
 * for a free try the input too). A button whose current key equals it would
 * run the very same thing again and get the very same answer, so the player
 * disables it — the unchanged-code rule. Only a run that ended `done`
 * records its key: an unavailable runner, a refused budget or a failure
 * answered nothing, and pressing again is the right move.
 */
export function useRunSlot(): [
  RunState,
  (
    start: (onStage: (stage: CodeRunStage) => void) => Promise<ProgramRunResult>,
    key?: string,
  ) => Promise<void>,
  string | null,
] {
  const [state, setState] = useState<RunState>({ status: "idle" });
  const [doneKey, setDoneKey] = useState<string | null>(null);
  async function runInto(
    start: (onStage: (stage: CodeRunStage) => void) => Promise<ProgramRunResult>,
    key?: string,
  ) {
    setState({ status: "running", stage: "loading" });
    setDoneKey(null);
    try {
      const outcome = await start((stage) => setState({ status: "running", stage }));
      if (outcome === "unavailable" || outcome === "rate_limited") {
        setState({ status: outcome });
      } else {
        setState({ status: "done", outcome });
        setDoneKey(key ?? null);
      }
    } catch {
      setState({ status: "failed" });
    }
  }
  return [state, runInto, doneKey];
}

/** What a player's code is, as a run key: equal keys mean the same program. */
export const regionsKey = (regions: readonly string[]): string => JSON.stringify(regions);

/** Where a cooldown stands; `start` is called at the moment of a click. */
export interface Cooldown {
  cooling: boolean;
  /** The length of the current wait, 0 when there is none. */
  totalMs: number;
  remainingMs: number;
  /** When the current wait began (`Date.now()`); keys the fill animation. */
  startedAt: number;
  start: () => void;
}

/**
 * The refill of the run buttons after a use (`@quiz/domain/cooldown`).
 *
 * ONE counter per player, shared by every run it offers (Compile, Run the
 * tests, the free try): on the server the three spend one budget
 * (`runsPerMinute`, N-SEC-07), so they must wait on one clock, and in the
 * browser the same single rule keeps the toolbar predictable — a student
 * never has to work out which of three buttons is ready. The floor applies
 * when the question runs on the server; a `runno` question whose host falls
 * back to the server can still meet the budget, which the player reports as
 * `rate_limited` like before.
 */
export function useCooldown(
  mode: CooldownMode | undefined,
  runtime: ProgramStudent["runtime"],
  runsPerMinute: number,
): Cooldown {
  const uses = useRef(0);
  const lastUse = useRef<number | null>(null);
  const [wait, setWait] = useState<{ startedAt: number; totalMs: number } | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (wait === null) return;
    const end = wait.startedAt + wait.totalMs;
    // The end is a timeout of its own; the interval only refreshes the
    // "Available in N s" words, which change once a second.
    const done = setTimeout(() => setWait(null), Math.max(0, end - Date.now()));
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearTimeout(done);
      clearInterval(tick);
    };
  }, [wait]);

  const start = useCallback(() => {
    const t = Date.now();
    const recent = lastUse.current === null ? 0 : decayedUses(uses.current, t - lastUse.current);
    const totalMs = effectiveCooldownMs({
      mode: mode ?? "fixed",
      uses: recent,
      onServer: runtime !== "runno",
      runsPerMinute,
    });
    uses.current = recent + 1;
    lastUse.current = t;
    setNow(t);
    setWait({ startedAt: t, totalMs });
  }, [mode, runtime, runsPerMinute]);

  if (wait === null) return { cooling: false, totalMs: 0, remainingMs: 0, startedAt: 0, start };
  const remainingMs = Math.max(0, wait.startedAt + wait.totalMs - Math.max(now, wait.startedAt));
  return { cooling: true, totalMs: wait.totalMs, remainingMs, startedAt: wait.startedAt, start };
}

/**
 * The bar that fills the inside of a cooling button, left to right, over the
 * whole wait: one CSS width transition started a frame after mount. Under
 * `prefers-reduced-motion` it is not drawn at all (`motion-reduce:hidden`)
 * and the button shows the remaining seconds instead.
 */
function CooldownFill({ totalMs, primary }: { totalMs: number; primary: boolean }): ReactNode {
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    // Two states a frame apart, or the browser never sees the 0 % width.
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(() => setFilled(true));
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(() => setFilled(true), 16);
    return () => clearTimeout(id);
  }, []);
  return (
    <span
      aria-hidden="true"
      data-testid="cooldown-fill"
      className={cx(
        "pointer-events-none absolute inset-y-0 left-0 motion-reduce:hidden",
        primary ? "bg-on-fill/25" : "bg-accent/15",
      )}
      style={{ width: filled ? "100%" : "0%", transition: `width ${totalMs}ms linear` }}
    />
  );
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
 * The program: the whole file in one editor, the locked lines greyed and
 * read-only, with the compiler's complaints of the last run drawn on their
 * lines (`./LockedEditor.tsx`; a stack of blocks and textareas where Monaco
 * does not load). Only the regions come out of it; the server rebuilds the
 * file from the stored template anyway (invariant 14).
 */
export function ProgramRegions({
  student,
  regions,
  locked,
  onWrite,
  onWriteRegions,
  s,
  monaco,
  compileStderr,
}: {
  student: ProgramStudent;
  regions: readonly string[];
  locked: boolean;
  onWrite: (index: number, next: string) => void;
  /**
   * All the regions at once, preferred over `onWrite` when given: one edit
   * with several cursors may touch two regions, and two `onWrite` calls in
   * the same tick would each start from the same stale list.
   */
  onWriteRegions?: ((regions: string[]) => void) | undefined;
  s: ProgramPlayerStrings;
  monaco: boolean | undefined;
  /** The `compile.stderr` of the last run, read as diagnostics on the student's lines. */
  compileStderr?: string | undefined;
}): ReactNode {
  const diagnostics = useMemo(
    () => (compileStderr ? parseDiagnostics(compileStderr, mainFileName(student.language)) : []),
    [compileStderr, student.language],
  );
  const write = (next: string[]) => {
    if (onWriteRegions !== undefined) {
      onWriteRegions(next);
      return;
    }
    next.forEach((text, i) => {
      if (text !== regions[i]) onWrite(i, text);
    });
  };
  return (
    <LockedEditor
      segments={student.segments}
      regions={regions}
      onChange={locked ? undefined : write}
      language={student.language}
      label={s.program}
      regionLabel={s.editableRegion}
      lockedLabel={s.locked}
      diagnostics={diagnostics}
      monaco={monaco}
    />
  );
}

/**
 * A run button: Run, Compile, Run the tests, a free try's Run once. While its
 * slot runs it says so; while the player's cooldown lasts it is disabled and
 * refills (see {@link CooldownFill}), with "Available in N s" for a screen
 * reader and, under reduced motion, the seconds in plain sight.
 */
export function RunButton({
  state,
  disabled,
  onClick,
  s,
  label,
  busyLabel,
  icon,
  variant = "primary",
  cooldown,
  className = "ml-auto",
}: {
  state: RunState;
  disabled: boolean;
  onClick: () => void;
  s: ProgramPlayerStrings;
  /** The word of the button; "Run" when absent. */
  label?: string | undefined;
  /** What it says while its slot runs; "Running…" when absent. */
  busyLabel?: string | undefined;
  icon?: ReactNode;
  variant?: "primary" | "secondary";
  cooldown?: Cooldown | undefined;
  className?: string;
}): ReactNode {
  const cooling = cooldown?.cooling === true && state.status !== "running";
  const seconds = cooling ? Math.max(1, Math.ceil(cooldown.remainingMs / 1000)) : 0;
  return (
    <button
      type="button"
      className={button(variant, "sm", cx("relative overflow-hidden", className))}
      disabled={disabled || cooling}
      onClick={onClick}
    >
      {cooling ? (
        <CooldownFill key={cooldown.startedAt} totalMs={cooldown.totalMs} primary={variant === "primary"} />
      ) : null}
      <span className="relative inline-flex items-center gap-1.5">
        {icon}
        {state.status === "running" ? (busyLabel ?? s.running) : (label ?? s.run)}
        {cooling ? (
          <>
            <span aria-hidden="true" className="hidden tabular-nums motion-reduce:inline">
              {seconds} s
            </span>
            <span className="sr-only">{`. ${fmt(s.availableIn, { seconds })}`}</span>
          </>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The lines under the run buttons: the one-time runtime download, and how
 * the last run ended — unavailable, refused by the budget, failed, or
 * compiled (with the compiler's words when it did not).
 *
 * WHERE the program runs is not said: it does not change what a student
 * does, and the one moment it shows — the first download — has its line.
 */
export function RunStatus({
  state,
  s,
  rateLimited,
}: {
  state: RunState;
  s: ProgramPlayerStrings;
  /** The sentence for `rate_limited`; a host that never reports it passes none. */
  rateLimited?: string | undefined;
}): ReactNode {
  const outcome = state.status === "done" ? state.outcome : null;
  return (
    <>
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
