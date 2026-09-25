/**
 * The student's view of a `code` question (docs/spec/04 §4.7).
 *
 * The program is ONE editor whose locked lines are read-only (`LockedEditor`,
 * ADR-024); the answer is exactly what the contract says it is — the editable
 * regions, in order. The server rebuilds the file from the stored template
 * anyway (invariant 14), so the locked lines are a display, not a guard.
 *
 * "Run" is optional. With `RUNNER_MODE=stub` — the default until a machine
 * with Podman exists (decision D14) — `onRun` resolves with `"unavailable"`
 * and the panel says so in one line: the answer is still saved and still
 * graded, by hand if need be. Nothing about the question stops working.
 *
 * Under the code, three tools: Compile (the compiler's words, nothing run),
 * Run the tests (the visible cases — the primary action) and Free try (a
 * panel with a command line and a stdin of the student's own). They share
 * one cooldown (`useCooldown`) and each rests while what it would run is
 * what it last ran.
 */
import { useId, useState } from "react";

import { fmt, plural, resolveStrings } from "@quiz/core/client";
import type { MarkdownRenderer, PlayerProps } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";

import { ArgsInput } from "./ArgsInput.js";
import { HammerIcon, ListChecksIcon, TerminalIcon } from "./icons.js";
import {
  ProgramRegions,
  ProgramStatement,
  regionsKey,
  regionsOf,
  RunButton,
  RunStatus,
  useCooldown,
  useRunSlot,
  type CodeRunStage,
} from "./ProgramPlayer.js";
import type { CodeAnswer, CodeStudent } from "./schema.js";
import { PLAYER_STRINGS, type CodePlayerStrings } from "./strings.js";
import {
  badge,
  button,
  card,
  cx,
  hint,
  input,
  isLocked,
  lockedBlock,
  sectionTitle,
  table,
  Verdict,
  verdictTone,
} from "@quiz/ui";
import { caseVerdict } from "./verdict.js";

export type { CodeRunStage } from "./ProgramPlayer.js";

export interface CodeRunOptions {
  /**
   * Replaces the visible cases with a single input of the student's own — the
   * free stdin box of docs/spec/04 §4.7. Only honoured when the host says it
   * can (`allowManualRun`).
   */
  manual?: { args: string[]; stdin: string } | undefined;
  /**
   * Compile only, run nothing: the student's "Compile" button. The host
   * resolves with the compile step filled and `cases: []`.
   */
  compileOnly?: boolean | undefined;
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
  /**
   * Whether "Run the tests" is the screen's primary action (the default). The
   * teacher's try panel says no: its own "Run all the tests" grades the whole
   * answer, and one screen has one primary action.
   */
  testsPrimary?: boolean | undefined;
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean | undefined;
  strings?: Partial<CodePlayerStrings> | undefined;
  /** The host's sanitised markdown view; plain text when absent. */
  renderMarkdown?: MarkdownRenderer | undefined;
  /** Forces the Monaco path on or off (tests use the textarea). */
  monaco?: boolean | undefined;
}

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
  compare: CodeStudent["compare"] | undefined,
  s: CodePlayerStrings,
): { label: string; ok: boolean | null } {
  // The grade's own rule, with the teacher's comparison options (audit R-06);
  // this function only words its answer.
  const verdict = caseVerdict(visibleCase, compileOk ? result : undefined, compare);
  switch (verdict.failure) {
    case null:
      return { label: s.passed, ok: true };
    case "not_run":
      return { label: s.notRun, ok: null };
    case "timed_out":
      return { label: s.timedOut, ok: false };
    case "oom":
      return { label: s.outOfMemory, ok: false };
    case "crashed":
      return { label: s.crashed, ok: false };
    case "exit": {
      // A payload older than the two checks meant "exit 0".
      const want = visibleCase.expectedExitCode === undefined ? 0 : visibleCase.expectedExitCode;
      return { label: fmt(s.exitMismatch, { got: String(result!.exitCode), want: want ?? 0 }), ok: false };
    }
    case "output":
      return { label: s.outputMismatch, ok: false };
  }
}

export function CodePlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  onRun,
  allowManualRun,
  testsPrimary = true,
  strings,
  renderMarkdown,
  monaco,
}: CodePlayerProps) {
  const s = resolveStrings(PLAYER_STRINGS, strings);
  const locked = isLocked(readOnly, disabled);
  const ids = useId();
  const [compile, compileInto, compiledKey] = useRunSlot();
  const [run, runVisibleInto, testedKey] = useRunSlot();
  const [manual, runManualInto, triedKey] = useRunSlot();
  /** The free input of §4.7: a command line and a stdin of the student's own. */
  const [manualArgs, setManualArgs] = useState<string[]>([]);
  const [manualStdin, setManualStdin] = useState("");
  const [freeOpen, setFreeOpen] = useState(false);
  /** Which of Compile / Run the tests spoke last: its status is the one under the toolbar. */
  const [lastAction, setLastAction] = useState<"compile" | "tests">("tests");
  const cooldown = useCooldown(student.cooldown, student.runtime, student.runsPerMinute);

  const regions = regionsOf(student, answer);
  const codeKey = regionsKey(regions);
  const manualKey = JSON.stringify([regions, manualArgs, manualStdin]);

  const writeRegions = (updated: string[]) =>
    onChange(
      answer?.lastRun === undefined || answer.lastRun === null
        ? { regions: updated }
        : { regions: updated, lastRun: answer.lastRun },
    );
  const writeRegion = (index: number, next: string) =>
    writeRegions(regions.map((text, i) => (i === index ? next : text)));
  /** The compiler's words of the last run that compiled, whichever tool ran it. */
  const [compileStderr, setCompileStderr] = useState("");

  /*
   * One run, written into one of the three slots: the compiler alone, the
   * visible cases, or the student's own input. The request, the stages, the
   * endings and the cooldown are the same; only the slot and its options
   * differ.
   */
  async function runInto(
    slot: typeof runVisibleInto,
    key: string,
    options: Omit<CodeRunOptions, "onStage">,
  ) {
    if (onRun === undefined) return;
    cooldown.start();
    await slot(async (onStage) => {
      const result = await onRun({ regions }, { ...options, onStage });
      if (typeof result === "object") setCompileStderr(result.compile.ok ? "" : result.compile.stderr);
      return result;
    }, key);
  }

  const busy =
    compile.status === "running" || run.status === "running" || manual.status === "running";
  /*
   * The unchanged-code rule: a button whose last COMPLETED run was made of
   * exactly what is on screen now would answer the same thing again, so it
   * rests, and the answer it gave stays shown. A test run compiles too, so
   * it answers Compile as well.
   */
  const testsUnchanged = testedKey === codeKey;
  const compileUnchanged = compiledKey === codeKey || testsUnchanged;
  const manualUnchanged = triedKey === manualKey;

  const outcome = run.status === "done" ? run.outcome : null;
  const manualResult = manual.status === "done" ? (manual.outcome.cases[0] ?? null) : null;
  const status = lastAction === "compile" ? compile : run;
  const canRun = onRun !== undefined;
  const canFreeTry = canRun && allowManualRun === true;

  return (
    <div className="flex flex-col gap-5">
      <ProgramStatement
        student={student}
        s={s}
        renderMarkdown={renderMarkdown}
        badges={
          student.allOrNothing ? <span className={badge("warning")}>{s.allOrNothing}</span> : null
        }
      />

      <div className="flex flex-col gap-2">
        <ProgramRegions
          student={student}
          regions={regions}
          locked={locked}
          onWrite={writeRegion}
          onWriteRegions={writeRegions}
          s={s}
          monaco={monaco}
          compileStderr={compileStderr}
        />

        {/*
         * The toolbar of the student's tools, right under the code. ONE
         * primary action — Run the tests, the question's own check — and
         * two secondary ones: Compile, the quick look at the compiler's
         * words, and Free try, which opens a panel rather than running.
         */}
        {canRun ? (
          <div className="flex flex-wrap items-center gap-2">
            <RunButton
              state={compile}
              variant="secondary"
              className=""
              icon={<HammerIcon />}
              label={s.compile}
              busyLabel={s.compiling}
              disabled={locked || busy || compileUnchanged}
              cooldown={cooldown}
              onClick={() => {
                setLastAction("compile");
                void runInto(compileInto, codeKey, { compileOnly: true });
              }}
              s={s}
            />
            <RunButton
              state={run}
              className=""
              icon={<ListChecksIcon />}
              label={s.runTests}
              variant={testsPrimary ? "primary" : "secondary"}
              disabled={locked || busy || testsUnchanged}
              cooldown={cooldown}
              onClick={() => {
                setLastAction("tests");
                void runInto(runVisibleInto, codeKey, {});
              }}
              s={s}
            />
            {canFreeTry ? (
              <button
                type="button"
                className={button(freeOpen ? "subtle" : "secondary", "sm")}
                aria-expanded={freeOpen}
                aria-controls={`${ids}-free`}
                onClick={() => setFreeOpen((open) => !open)}
              >
                <TerminalIcon />
                {s.freeTry}
              </button>
            ) : null}
          </div>
        ) : null}
        {canRun && testsUnchanged && !busy && !locked ? (
          <p className={hint}>{s.unchangedTests}</p>
        ) : null}
        <RunStatus state={status} s={s} />
      </div>

      {/*
       * The free try of §4.7: one command line and one stdin of the student's
       * own. It is the ONE thing a client chooses about a run — the visible
       * cases keep the arguments the teacher wrote, assembled server-side
       * (invariant 14) — and it exists only where the host can honour it.
       */}
      {canFreeTry && freeOpen ? (
        <section id={`${ids}-free`} className={cx(card, "flex flex-col gap-3 p-4")}>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className={sectionTitle}>{s.manual}</h3>
            <RunButton
              state={manual}
              variant="secondary"
              label={s.manualRun}
              disabled={locked || busy || manualUnchanged}
              cooldown={cooldown}
              onClick={() =>
                void runInto(runManualInto, manualKey, {
                  manual: { args: manualArgs, stdin: manualStdin },
                })
              }
              s={s}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span id={`${ids}-manual-args`} className="text-[13px] font-medium text-fg">
                {s.manualArgs}
              </span>
              <ArgsInput
                value={manualArgs}
                onChange={setManualArgs}
                language={student.language}
                s={s}
                disabled={locked}
                labelledBy={`${ids}-manual-args`}
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
                rows={3}
                aria-label={s.stdin}
                className={cx(input, "w-full py-1.5 font-mono")}
                disabled={locked}
                value={manualStdin}
                onChange={(e) => setManualStdin(e.target.value)}
              />
            </div>
          </div>
          {manualUnchanged && !busy && !locked ? (
            <p className={hint}>{s.unchangedManual}</p>
          ) : null}
          <RunStatus state={manual} s={s} />
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

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <h3 className={sectionTitle}>{s.visibleCases}</h3>

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
                    student.compare,
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
                        <Verdict tone={verdictTone(verdict.ok)}>{verdict.label}</Verdict>
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
    </div>
  );
}

export default CodePlayer;
