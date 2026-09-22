/**
 * The teacher's editor for a `code` question (mockup `02-editeur-code.html`).
 *
 * One primary path — statement, starting code, cases — with everything a
 * teacher rarely touches folded into "Advanced options". The reference
 * solution sits next to the cases because it exists to check them: pressing
 * "Try" runs it and says how many pass. It is never part of what a student
 * receives (`toStudent` drops it).
 */
import { useId, useState } from "react";

import type { EditorProps, MarkdownRenderer } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";
import { compareOutput } from "@quiz/domain/compareOutput";

import { CodeArea } from "./MonacoHost.js";
import { referenceRegions } from "./reference.js";
import { splitForDisplay } from "./segments.js";
import {
  CODE_LANGUAGES,
  DEFAULT_LIMITS,
  RUNNO_LANGUAGES,
  totalCasePoints,
  type CodeCase,
  type CodeConfig,
  type CodeLanguage,
  type CodeRuntime,
} from "./schema.js";
import { EDITOR_STRINGS, withStrings, type CodeEditorStrings } from "./strings.js";
import { badge, button, card, cx, hint, input, inputSm, label, sectionTitle } from "./styles.js";

export interface CodeEditorProps extends EditorProps<CodeConfig> {
  /**
   * Runs the reference solution against every case. The host decides WHERE
   * (`CodeConfig.runtime`: the browser runner, or `POST /questions/:id/try`)
   * and rebuilds the source itself from the template and
   * {@link referenceRegions}; this component never builds a request.
   *
   * Three answers, because the two runners do not return the same thing:
   * a {@link RunnerOutcome} when the run was raw and the cases still have to
   * be judged (the browser), `{ graded }` when the SERVER already judged them
   * (`POST /try` returns a grading, not a run — `TryResult` in
   * `@quiz/contracts` carries no per-case runner outcome), and
   * `"unavailable"` when no runner could, which is a configuration and not an
   * error (`RUNNER_MODE=stub` is the default).
   */
  onTry?: ((config: CodeConfig) => Promise<CodeTryOutcome>) | undefined;
  strings?: Partial<CodeEditorStrings> | undefined;
  /**
   * The host's sanitised markdown view, used to preview the statement under
   * its textarea. Absent, the preview is not drawn at all: the textarea
   * already shows the source, so there is nothing to fall back to.
   */
  renderMarkdown?: MarkdownRenderer | undefined;
  /** Forces the Monaco path on or off (tests use the textarea). */
  monaco?: boolean | undefined;
}

/** What the reference run came back with; see `CodeEditorProps.onTry`. */
export type CodeTryOutcome =
  | RunnerOutcome
  | "unavailable"
  | { graded: { compileOk: boolean; passed: number; total: number } };

type TryState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "unavailable" }
  /**
   * `compile`: the reference solution does not build. `regions`: it does not
   * MATCH the template — the two are different mistakes and the teacher fixes
   * them in different places, so they never share a sentence.
   */
  | { status: "failed"; reason: "compile" | "regions" }
  | { status: "done"; passed: number; total: number };

const NEW_CASE: CodeCase = {
  name: "",
  args: [],
  stdin: "",
  expected: "",
  compareStdout: true,
  expectedExitCode: 0,
  visible: false,
  points: 1,
  timeMs: null,
};

/** The languages the browser runner can run; anything else is the server's. */
const browserCapable = (language: CodeLanguage): boolean =>
  (RUNNO_LANGUAGES as readonly string[]).includes(language);

export function CodeEditor({
  config,
  onChange,
  disabled,
  onTry,
  strings,
  RichText,
  uploadAsset,
  monaco,
}: CodeEditorProps) {
  const s = withStrings(EDITOR_STRINGS, strings);
  const ids = useId();
  const [tryState, setTryState] = useState<TryState>({ status: "idle" });
  /*
   * One argument per LINE, and the textarea keeps its own text while it is
   * being typed: `args.join("\n")` would swallow the newline the teacher just
   * pressed (an empty last line is not an argument) and move the caret.
   */
  const [argsDraft, setArgsDraft] = useState<Record<number, string>>({});

  const patch = (next: Partial<CodeConfig>) => onChange({ ...config, ...next });
  const patchTests = (next: Partial<CodeConfig["tests"]>) =>
    patch({ tests: { ...config.tests, ...next } });
  const patchCase = (index: number, next: Partial<CodeCase>) =>
    patchTests({
      cases: config.tests.cases.map((c, i) => (i === index ? { ...c, ...next } : c)),
    });
  const setCases = (cases: CodeCase[]) => {
    // The drafts are keyed by position, so a removal would shift them onto the
    // wrong case. Dropping them re-reads every row from the config.
    setArgsDraft({});
    patchTests({ cases });
  };
  const writeArgs = (index: number, text: string) => {
    setArgsDraft((draft) => ({ ...draft, [index]: text }));
    patchCase(index, {
      args: text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    });
  };

  const segments = splitForDisplay(config.template, config.language);
  const lockedCount = segments.filter((seg) => seg.kind === "locked").length;

  async function runReference() {
    if (onTry === undefined) return;
    /*
     * The split is checked HERE, before anything leaves: a reference solution
     * whose `@@next` pieces do not match the template's editable regions is a
     * mistake in the text on this screen, and the teacher must read it as one
     * — not as a compiler error from a program that was never assembled.
     */
    if (referenceRegions(config) === null) {
      setTryState({ status: "failed", reason: "regions" });
      return;
    }
    setTryState({ status: "running" });
    try {
      const outcome = await onTry(config);
      if (outcome === "unavailable") {
        setTryState({ status: "unavailable" });
        return;
      }
      if ("graded" in outcome) {
        // The server judged the cases: its verdict is the answer, and
        // re-deciding it here from an output we do not have would be a guess.
        const { compileOk, passed, total } = outcome.graded;
        setTryState(
          compileOk ? { status: "done", passed, total } : { status: "failed", reason: "compile" },
        );
        return;
      }
      if (!outcome.compile.ok) {
        setTryState({ status: "failed", reason: "compile" });
        return;
      }
      const passed = config.tests.cases.reduce((count, testCase, i) => {
        const run = outcome.cases[i];
        const ok =
          run !== undefined &&
          !run.timedOut &&
          !run.oom &&
          (testCase.expectedExitCode === null
            ? run.exitCode !== null
            : run.exitCode === (testCase.expectedExitCode ?? 0)) &&
          (testCase.compareStdout === false ||
            compareOutput(testCase.expected, run.stdout, config.tests.compare));
        return ok ? count + 1 : count;
      }, 0);
      setTryState({ status: "done", passed, total: config.tests.cases.length });
    } catch {
      setTryState({ status: "failed", reason: "compile" });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className={cx(card, "flex flex-col gap-4 p-4")}>
        <h3 className={sectionTitle}>{s.questionSection}</h3>
        <div className="flex flex-col gap-1.5">
          {/*
           * A caption and not a `<label for>` when the host lent its rich
           * editor: its surface is a contenteditable, which is not a labelable
           * element — the browser reports such a `for` as matching no control,
           * and the field takes its name from `aria-label` instead. The
           * textarea fallback is a real control and keeps its label.
           */}
          {RichText ? (
            <span className={label}>{s.prompt}</span>
          ) : (
            <label className={label} htmlFor={`${ids}-prompt`}>
              {s.prompt}
            </label>
          )}
          {/*
           * The host's WYSIWYG editor when it lent one (`EditorProps.RichText`),
           * the textarea otherwise. No preview under either: the rich field IS
           * the preview, and under a textarea a second rendering of the string
           * the teacher is looking at is noise.
           */}
          {RichText ? (
            <RichText
              id={`${ids}-prompt`}
              aria-label={s.prompt}
              value={config.prompt}
              onChange={(prompt) => patch({ prompt })}
              {...(disabled === undefined ? {} : { disabled })}
              {...(uploadAsset === undefined ? {} : { uploadImage: uploadAsset })}
            />
          ) : (
            <textarea
              id={`${ids}-prompt`}
              rows={5}
              disabled={disabled}
              value={config.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
              className={cx(input, "w-full py-2 leading-relaxed")}
            />
          )}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-language`}>
              {s.language}
            </label>
            <select
              id={`${ids}-language`}
              disabled={disabled}
              value={config.language}
              onChange={(e) => patch({ language: e.target.value as CodeLanguage })}
              className={cx(input, "h-8.5 w-52")}
            >
              {CODE_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </div>
          {/*
           * Only for a language the browser runner ships (ADR-015). For every
           * other one the question has no choice to offer, and a disabled
           * control that can never be enabled is worse than no control.
           */}
          {browserCapable(config.language) ? (
            <div className="flex flex-col gap-1.5">
              <label className={label} htmlFor={`${ids}-runtime`}>
                {s.runtime}
              </label>
              <select
                id={`${ids}-runtime`}
                disabled={disabled}
                value={config.runtime ?? "backend"}
                onChange={(e) => patch({ runtime: e.target.value as CodeRuntime })}
                className={cx(input, "h-8.5 w-52")}
              >
                <option value="backend">{s.runtimeBackend}</option>
                <option value="runno">{s.runtimeBrowser}</option>
              </select>
            </div>
          ) : null}
        </div>
        {browserCapable(config.language) ? <p className={hint}>{s.runtimeHint}</p> : null}
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={sectionTitle}>
            {s.template}
          </h3>
          <span className={badge(lockedCount > 0 ? "accent" : "neutral")}>
            {s.lockedRegions(lockedCount)}
          </span>
        </div>
        <p className={hint}>{s.templateHint}</p>
        <CodeArea
          label={s.template}
          language={config.language}
          value={config.template}
          onChange={disabled ? undefined : (next) => patch({ template: next })}
          minLines={10}
          monaco={monaco}
        />
        <h4 className="text-[13px] font-medium text-fg-muted">{s.studentPreview}</h4>
        <ol className="flex flex-col gap-1">
          {segments.map((segment, i) => (
            <li
              key={i}
              className="flex items-baseline gap-2 text-[13px]"
              data-kind={segment.kind}
            >
              <span className={badge(segment.kind === "locked" ? "neutral" : "success")}>
                {segment.kind === "locked" ? s.locked : s.editable}
              </span>
              <span className="truncate font-mono text-fg-muted">
                {segment.display.split("\n")[0] || "—"}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <h3 className={sectionTitle}>
          {s.referenceSolution}
        </h3>
        <p className={hint}>{s.referenceSolutionHint}</p>
        <CodeArea
          label={s.referenceSolution}
          language={config.language}
          value={config.referenceSolution}
          onChange={disabled ? undefined : (next) => patch({ referenceSolution: next })}
          minLines={6}
          monaco={monaco}
        />
        {onTry === undefined ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={button("secondary", "sm")}
              disabled={disabled || tryState.status === "running"}
              onClick={() => void runReference()}
            >
              {tryState.status === "running" ? s.trying : s.tryReference}
            </button>
            {tryState.status === "unavailable" ? (
              <p role="status" className={hint}>
                {s.tryUnavailable}
              </p>
            ) : null}
            {tryState.status === "failed" ? (
              <p role="status" className="text-[13px] text-danger">
                {tryState.reason === "regions" ? s.tryRegionsMismatch : s.tryCompileFailed}
              </p>
            ) : null}
            {tryState.status === "done" ? (
              <p role="status" className={hint}>
                {s.tryResult(tryState.passed, tryState.total)}
              </p>
            ) : null}
          </div>
        )}
      </section>

      {/*
       * One PANEL per case, not one table row.
       *
       * A case now carries ten fields — a name, a command line, an input, an
       * expected output and the two checks that decide whether it passed, plus
       * its points, its budget and its visibility. Ten columns is not a table
       * a teacher can read at 1440 px, let alone on a laptop; a panel gives
       * each case a heading and three short lines (DESIGN.md, tables).
       */}
      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={sectionTitle}>{s.cases}</h3>
          <span className={badge()}>{s.totalPoints(totalCasePoints(config))}</span>
          <button
            type="button"
            className={button("secondary", "sm", "ml-auto")}
            disabled={disabled}
            onClick={() => setCases([...config.tests.cases, { ...NEW_CASE }])}
          >
            {s.addCase}
          </button>
        </div>

        <ol className="flex flex-col gap-3">
          {config.tests.cases.map((testCase, i) => (
            <li key={i} className="rounded-card border border-line bg-surface-2 p-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <label className={label} htmlFor={`${ids}-name-${i}`}>
                    {s.case(i + 1)}
                  </label>
                  <input
                    id={`${ids}-name-${i}`}
                    className={cx(inputSm, "w-full font-medium")}
                    aria-label={`${s.caseName} ${i + 1}`}
                    disabled={disabled}
                    value={testCase.name}
                    onChange={(e) => patchCase(i, { name: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className={label} htmlFor={`${ids}-points-${i}`}>
                    {s.points}
                  </label>
                  <input
                    id={`${ids}-points-${i}`}
                    type="number"
                    min={0}
                    step={0.5}
                    className={cx(inputSm, "w-20 text-right tabular-nums")}
                    aria-label={`${s.points} ${i + 1}`}
                    disabled={disabled}
                    value={testCase.points}
                    onChange={(e) => patchCase(i, { points: Number(e.target.value) || 0 })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className={label} htmlFor={`${ids}-time-${i}`}>
                    {s.timeMs}
                  </label>
                  <input
                    id={`${ids}-time-${i}`}
                    type="number"
                    min={100}
                    step={100}
                    placeholder={String(config.limits.timeMs)}
                    className={cx(inputSm, "w-24 text-right tabular-nums")}
                    aria-label={`${s.timeMs} ${i + 1}`}
                    disabled={disabled}
                    value={testCase.timeMs ?? ""}
                    onChange={(e) =>
                      patchCase(i, {
                        timeMs: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </div>
                <label className="flex h-7 items-center gap-2 text-[13px] text-fg-muted">
                  <input
                    type="checkbox"
                    aria-label={`${s.hidden} ${i + 1}`}
                    disabled={disabled}
                    checked={!testCase.visible}
                    onChange={(e) => patchCase(i, { visible: !e.target.checked })}
                  />
                  {s.hidden}
                </label>
                <button
                  type="button"
                  className={button("ghost", "sm")}
                  aria-label={s.removeCase(testCase.name)}
                  disabled={disabled || config.tests.cases.length <= 1}
                  onClick={() => setCases(config.tests.cases.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label className={label} htmlFor={`${ids}-args-${i}`}>
                    {s.args}
                  </label>
                  <textarea
                    id={`${ids}-args-${i}`}
                    rows={2}
                    className={cx(input, "w-full py-1.5 font-mono")}
                    aria-label={`${s.args} ${i + 1}`}
                    disabled={disabled}
                    value={argsDraft[i] ?? (testCase.args ?? []).join("\n")}
                    onChange={(e) => writeArgs(i, e.target.value)}
                  />
                  <p className={hint}>{s.argsHint}</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className={label} htmlFor={`${ids}-stdin-${i}`}>
                    {s.stdin}
                  </label>
                  <textarea
                    id={`${ids}-stdin-${i}`}
                    rows={2}
                    className={cx(input, "w-full py-1.5 font-mono")}
                    aria-label={`${s.stdin} ${i + 1}`}
                    disabled={disabled}
                    value={testCase.stdin}
                    onChange={(e) => patchCase(i, { stdin: e.target.value })}
                  />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="flex h-8.5 items-center gap-2 text-[13px] text-fg">
                  <input
                    type="checkbox"
                    aria-label={`${s.compareStdout} ${i + 1}`}
                    disabled={disabled}
                    checked={testCase.compareStdout !== false}
                    onChange={(e) => patchCase(i, { compareStdout: e.target.checked })}
                  />
                  {s.compareStdout}
                </label>
                {/* Off, there is no expected output to write: the case checks
                    the exit code alone, so the field goes away with it. */}
                {testCase.compareStdout !== false ? (
                  <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                    <label className={label} htmlFor={`${ids}-expected-${i}`}>
                      {s.expected}
                    </label>
                    <input
                      id={`${ids}-expected-${i}`}
                      className={cx(inputSm, "w-full font-mono")}
                      aria-label={`${s.expected} ${i + 1}`}
                      disabled={disabled}
                      value={testCase.expected}
                      onChange={(e) => patchCase(i, { expected: e.target.value })}
                    />
                  </div>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <label className={label} htmlFor={`${ids}-exit-${i}`}>
                    {s.exitCode}
                  </label>
                  <input
                    id={`${ids}-exit-${i}`}
                    type="number"
                    min={0}
                    max={255}
                    placeholder={s.exitCodeAny}
                    className={cx(inputSm, "w-24 text-right tabular-nums")}
                    aria-label={`${s.exitCode} ${i + 1}`}
                    disabled={disabled}
                    value={testCase.expectedExitCode ?? ""}
                    onChange={(e) =>
                      patchCase(i, {
                        expectedExitCode:
                          e.target.value === "" ? null : Number(e.target.value) || 0,
                      })
                    }
                  />
                </div>
              </div>
            </li>
          ))}
        </ol>
        <p className={hint}>{s.timeMsHint}</p>
        <p className={hint}>{s.exitCodeHint}</p>
      </section>

      <details className={cx(card, "p-4")}>
        <summary className={cx(sectionTitle, "cursor-pointer")}>{s.advanced}</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-action`}>
              {s.action}
            </label>
            <select
              id={`${ids}-action`}
              disabled={disabled}
              value={config.action}
              onChange={(e) => patch({ action: e.target.value === "check" ? "check" : "run" })}
              className={cx(input, "h-8.5")}
            >
              <option value="run">{s.actionRun}</option>
              <option value="check">{s.actionCheck}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-args`}>
              {s.compileArgs}
            </label>
            <input
              id={`${ids}-args`}
              className={cx(input, "h-8.5 font-mono")}
              disabled={disabled}
              value={config.compileArgs}
              onChange={(e) => patch({ compileArgs: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-time`}>
              {s.timeLimit}
            </label>
            <input
              id={`${ids}-time`}
              type="number"
              min={100}
              step={100}
              className={cx(input, "h-8.5 tabular-nums")}
              disabled={disabled}
              value={config.limits.timeMs}
              onChange={(e) =>
                patch({
                  limits: {
                    ...config.limits,
                    timeMs: Number(e.target.value) || DEFAULT_LIMITS.timeMs,
                  },
                })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-memory`}>
              {s.memoryLimit}
            </label>
            <input
              id={`${ids}-memory`}
              type="number"
              min={16}
              step={16}
              className={cx(input, "h-8.5 tabular-nums")}
              disabled={disabled}
              value={config.limits.memoryMb}
              onChange={(e) =>
                patch({
                  limits: {
                    ...config.limits,
                    memoryMb: Number(e.target.value) || DEFAULT_LIMITS.memoryMb,
                  },
                })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-output`}>
              {s.outputLimit}
            </label>
            <input
              id={`${ids}-output`}
              type="number"
              min={1}
              step={1}
              className={cx(input, "h-8.5 tabular-nums")}
              disabled={disabled}
              value={config.limits.outputKb}
              onChange={(e) =>
                patch({
                  limits: {
                    ...config.limits,
                    outputKb: Number(e.target.value) || DEFAULT_LIMITS.outputKb,
                  },
                })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-rpm`}>
              {s.runsPerMinute}
            </label>
            <input
              id={`${ids}-rpm`}
              type="number"
              min={1}
              max={30}
              className={cx(input, "h-8.5 tabular-nums")}
              disabled={disabled}
              value={config.runsPerMinute}
              onChange={(e) => patch({ runsPerMinute: Number(e.target.value) || 1 })}
            />
          </div>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input
              type="checkbox"
              disabled={disabled}
              checked={config.allOrNothing}
              onChange={(e) => patch({ allOrNothing: e.target.checked })}
            />
            {s.allOrNothing}
          </label>
          <p className={cx(hint, "sm:col-span-2")}>{s.allOrNothingHint}</p>

          <h4 className={cx("text-[13px] font-medium text-fg", "sm:col-span-2")}>{s.compare}</h4>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input
              type="checkbox"
              disabled={disabled}
              checked={config.tests.compare.trimTrailing}
              onChange={(e) =>
                patchTests({
                  compare: { ...config.tests.compare, trimTrailing: e.target.checked },
                })
              }
            />
            {s.trimTrailing}
          </label>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input
              type="checkbox"
              disabled={disabled}
              checked={config.tests.compare.ignoreCase}
              onChange={(e) =>
                patchTests({ compare: { ...config.tests.compare, ignoreCase: e.target.checked } })
              }
            />
            {s.ignoreCase}
          </label>
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-numeric`}>
              {s.numeric}
            </label>
            <select
              id={`${ids}-numeric`}
              disabled={disabled}
              value={config.tests.compare.numeric === null ? "off" : config.tests.compare.numeric.mode}
              onChange={(e) =>
                patchTests({
                  compare: {
                    ...config.tests.compare,
                    numeric:
                      e.target.value === "off"
                        ? null
                        : {
                            epsilon: config.tests.compare.numeric?.epsilon ?? 1e-6,
                            mode: e.target.value === "rel" ? "rel" : "abs",
                          },
                  },
                })
              }
              className={cx(input, "h-8.5")}
            >
              <option value="off">{s.numericOff}</option>
              <option value="abs">{s.numericAbs}</option>
              <option value="rel">{s.numericRel}</option>
            </select>
          </div>
          {config.tests.compare.numeric === null ? null : (
            <div className="flex flex-col gap-1.5">
              <label className={label} htmlFor={`${ids}-epsilon`}>
                {s.epsilon}
              </label>
              <input
                id={`${ids}-epsilon`}
                type="number"
                min={0}
                step="any"
                className={cx(input, "h-8.5 tabular-nums")}
                disabled={disabled}
                value={config.tests.compare.numeric.epsilon}
                onChange={(e) =>
                  patchTests({
                    compare: {
                      ...config.tests.compare,
                      numeric: {
                        epsilon: Number(e.target.value) || 0,
                        mode: config.tests.compare.numeric?.mode ?? "abs",
                      },
                    },
                  })
                }
              />
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

export default CodeEditor;
