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
import { compareOutput } from "@quiz/domain";

import { CodeArea } from "./MonacoHost.js";
import { splitForDisplay } from "./segments.js";
import {
  CODE_LANGUAGES,
  DEFAULT_LIMITS,
  totalCasePoints,
  type CodeCase,
  type CodeConfig,
  type CodeLanguage,
} from "./schema.js";
import { EDITOR_STRINGS, withStrings, type CodeEditorStrings } from "./strings.js";
import { badge, button, card, cx, hint, input, inputSm, label, sectionTitle, table } from "./styles.js";

export interface CodeEditorProps extends EditorProps<CodeConfig> {
  /**
   * Runs the reference solution against every case. The host posts to
   * `POST /questions/:id/try`; the request is assembled server-side, so this
   * component never builds one. `"unavailable"` means the runner is off
   * (`RUNNER_MODE=stub`), which is the default and not an error.
   */
  onTry?: ((config: CodeConfig) => Promise<RunnerOutcome | "unavailable">) | undefined;
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

type TryState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "unavailable" }
  | { status: "failed" }
  | { status: "done"; passed: number; total: number };

const NEW_CASE: CodeCase = {
  name: "",
  stdin: "",
  expected: "",
  visible: false,
  points: 1,
  timeMs: null,
};

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

  const patch = (next: Partial<CodeConfig>) => onChange({ ...config, ...next });
  const patchTests = (next: Partial<CodeConfig["tests"]>) =>
    patch({ tests: { ...config.tests, ...next } });
  const patchCase = (index: number, next: Partial<CodeCase>) =>
    patchTests({
      cases: config.tests.cases.map((c, i) => (i === index ? { ...c, ...next } : c)),
    });

  const segments = splitForDisplay(config.template, config.language);
  const lockedCount = segments.filter((seg) => seg.kind === "locked").length;

  async function runReference() {
    if (onTry === undefined) return;
    setTryState({ status: "running" });
    try {
      const outcome = await onTry(config);
      if (outcome === "unavailable") {
        setTryState({ status: "unavailable" });
        return;
      }
      if (!outcome.compile.ok) {
        setTryState({ status: "failed" });
        return;
      }
      const passed = config.tests.cases.reduce((count, testCase, i) => {
        const run = outcome.cases[i];
        const ok =
          run !== undefined &&
          run.exitCode === 0 &&
          !run.timedOut &&
          !run.oom &&
          compareOutput(testCase.expected, run.stdout, config.tests.compare);
        return ok ? count + 1 : count;
      }, 0);
      setTryState({ status: "done", passed, total: config.tests.cases.length });
    } catch {
      setTryState({ status: "failed" });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className={cx(card, "flex flex-col gap-4 p-4")}>
        <h3 className={sectionTitle}>{s.questionSection}</h3>
        <div className="flex flex-col gap-1.5">
          <label className={label} htmlFor={`${ids}-prompt`}>
            {s.prompt}
          </label>
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
          <p className={hint}>{s.promptHint}</p>
        </div>
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
                {s.tryCompileFailed}
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

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={sectionTitle}>
            {s.cases}
          </h3>
          <span className={badge()}>{s.totalPoints(totalCasePoints(config))}</span>
          <button
            type="button"
            className={button("secondary", "sm", "ml-auto")}
            disabled={disabled}
            onClick={() => patchTests({ cases: [...config.tests.cases, { ...NEW_CASE }] })}
          >
            {s.addCase}
          </button>
        </div>
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
                  {s.hidden}
                </th>
                <th scope="col" className={cx(table.th, "text-right")}>
                  {s.points}
                </th>
                <th scope="col" className={cx(table.th, "text-right")}>
                  {s.timeMs}
                </th>
                <th scope="col" className={table.th} />
              </tr>
            </thead>
            <tbody>
              {config.tests.cases.map((testCase, i) => (
                <tr key={i} className={table.row}>
                  <td className={table.td}>
                    <input
                      className={cx(inputSm, "w-36 font-medium")}
                      aria-label={`${s.caseName} ${i + 1}`}
                      disabled={disabled}
                      value={testCase.name}
                      onChange={(e) => patchCase(i, { name: e.target.value })}
                    />
                  </td>
                  <td className={table.td}>
                    <input
                      className={cx(inputSm, "w-40 font-mono")}
                      aria-label={`${s.stdin} ${i + 1}`}
                      disabled={disabled}
                      value={testCase.stdin}
                      onChange={(e) => patchCase(i, { stdin: e.target.value })}
                    />
                  </td>
                  <td className={table.td}>
                    <input
                      className={cx(inputSm, "w-40 font-mono")}
                      aria-label={`${s.expected} ${i + 1}`}
                      disabled={disabled}
                      value={testCase.expected}
                      onChange={(e) => patchCase(i, { expected: e.target.value })}
                    />
                  </td>
                  <td className={table.td}>
                    <label className="inline-flex items-center gap-2 text-[13px] text-fg-muted">
                      <input
                        type="checkbox"
                        aria-label={`${s.hidden} ${i + 1}`}
                        disabled={disabled}
                        checked={!testCase.visible}
                        onChange={(e) => patchCase(i, { visible: !e.target.checked })}
                      />
                      {s.hidden}
                    </label>
                  </td>
                  <td className={cx(table.td, "text-right")}>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      className={cx(inputSm, "w-20 text-right tabular-nums")}
                      aria-label={`${s.points} ${i + 1}`}
                      disabled={disabled}
                      value={testCase.points}
                      onChange={(e) => patchCase(i, { points: Number(e.target.value) || 0 })}
                    />
                  </td>
                  <td className={cx(table.td, "text-right")}>
                    <input
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
                  </td>
                  <td className={cx(table.td, "text-right")}>
                    <button
                      type="button"
                      className={button("ghost", "sm")}
                      aria-label={s.removeCase(testCase.name)}
                      disabled={disabled || config.tests.cases.length <= 1}
                      onClick={() =>
                        patchTests({ cases: config.tests.cases.filter((_, j) => j !== i) })
                      }
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={hint}>{s.timeMsHint}</p>
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
