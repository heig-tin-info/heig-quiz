/**
 * The teacher's editor for a `code` question (mockup `02-editeur-code.html`).
 *
 * One primary path — statement, starting code, cases — with everything a
 * teacher rarely touches folded into "Advanced options". The reference
 * solution sits next to the cases because it exists to check them: pressing
 * "Try" runs it and says how many pass. It is never part of what a student
 * receives (`toStudent` drops it).
 *
 * The blocks it shares with the circuit editor — the statement card, the
 * first line of a row panel, the fold — are `@quiz/ui`'s (audit P-15); what
 * is written here is what only a code question has.
 */
import { useId, useState, type ReactNode } from "react";

import { fmt, issuesAt, plural, resolveStrings, rootIssues } from "@quiz/core/client";
import type { ConfigIssue, EditorProps, MarkdownRenderer } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";

import {
  PROGRAM_ADVANCED_PATHS,
  ProgramAdvancedFields,
  ProgramPromptSection,
  ReferenceSection,
  TemplateSection,
} from "./ProgramEditor.js";
import { referenceRegions } from "./reference.js";
import { DEFAULT_LIMITS, totalCasePoints, type CodeCase, type CodeConfig } from "./schema.js";
import { EDITOR_STRINGS, type CodeEditorStrings } from "./strings.js";
import { caseVerdict } from "./verdict.js";
import {
  AdvancedDisclosure,
  CheckboxField,
  cx,
  EditorSection,
  FieldCell,
  hint,
  input,
  inputSm,
  IssueList,
  NumberField,
  patchAt,
  removeAt,
  RowHead,
  RowList,
  RowListHeader,
  setting,
  TryPanel,
  type TryStatus,
} from "@quiz/ui";

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
  /** Validation problems of the stored draft (decision D16), placed by field. */
  issues?: readonly ConfigIssue[] | undefined;
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

/** The top-level settings "Advanced options" holds, as zod paths. */
const ADVANCED_PATHS = [...PROGRAM_ADVANCED_PATHS, "allOrNothing"] as const;

/** What the try panel says after a run, in one line; nothing before the first. */
function tryStatusOf(tryState: TryState, s: CodeEditorStrings): TryStatus | null {
  switch (tryState.status) {
    case "unavailable":
      return { tone: "hint", text: s.tryUnavailable };
    case "failed":
      return {
        tone: "danger",
        text: tryState.reason === "regions" ? s.tryRegionsMismatch : s.tryCompileFailed,
      };
    case "done":
      return {
        tone: "hint",
        text: fmt(s.tryResult, { passed: tryState.passed, total: tryState.total }),
      };
    default:
      return null;
  }
}

/** What one reference run came back with, as the try state it leaves the panel in. */
async function tryReference(
  config: CodeConfig,
  onTry: (config: CodeConfig) => Promise<CodeTryOutcome>,
): Promise<TryState> {
  const outcome = await onTry(config);
  if (outcome === "unavailable") return { status: "unavailable" };
  if ("graded" in outcome) {
    // The server judged the cases: its verdict is the answer, and
    // re-deciding it here from an output we do not have would be a guess.
    const { compileOk, passed, total } = outcome.graded;
    return compileOk ? { status: "done", passed, total } : { status: "failed", reason: "compile" };
  }
  if (!outcome.compile.ok) return { status: "failed", reason: "compile" };
  // The grade's own rule (audit R-06). No per-case budget: this raw path
  // is the browser runner, whose timing is not evidence (ADR-015) — only
  // its own `timedOut` counts, as before.
  const passed = config.tests.cases.reduce(
    (count, testCase, i) =>
      caseVerdict(testCase, outcome.cases[i], config.tests.compare).ok ? count + 1 : count,
    0,
  );
  return { status: "done", passed, total: config.tests.cases.length };
}

export function CodeEditor({
  config,
  onChange,
  disabled,
  issues = [],
  onTry,
  strings,
  RichText,
  uploadAsset,
  monaco,
}: CodeEditorProps) {
  const s = resolveStrings(EDITOR_STRINGS, strings);
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
    patchTests({ cases: patchAt(config.tests.cases, index, next) });
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

  /*
   * The settings folded into "Advanced options" report ABOVE the fold: an
   * issue inside a closed <details> is an issue nobody reads.
   */
  const advancedIssues = ADVANCED_PATHS.flatMap((key) => issuesAt(issues, key));
  const caseIssues = issuesAt(issues, "tests").filter(
    (issue) => !(issue.path[1] === "cases" && typeof issue.path[2] === "number"),
  );

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
      setTryState(await tryReference(config, onTry));
    } catch {
      setTryState({ status: "failed", reason: "compile" });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <ProgramPromptSection
        ids={ids}
        config={config}
        patch={patch}
        s={s}
        disabled={disabled}
        issues={issues}
        RichText={RichText}
        uploadAsset={uploadAsset}
      />

      <TemplateSection
        config={config}
        patch={patch}
        s={s}
        disabled={disabled}
        issues={issues}
        monaco={monaco}
      />

      <ReferenceSection
        config={config}
        patch={patch}
        s={s}
        disabled={disabled}
        issues={issues}
        monaco={monaco}
      >
        {onTry === undefined ? null : (
          <TryPanel
            label={s.tryReference}
            runningLabel={s.trying}
            running={tryState.status === "running"}
            disabled={disabled}
            onTry={() => void runReference()}
            status={tryStatusOf(tryState, s)}
          />
        )}
      </ReferenceSection>

      {/*
       * One PANEL per case (`RowList`): a case carries ten fields — a name, a
       * command line, an input, an expected output and the two checks that
       * decide whether it passed, plus its points, its budget and its
       * visibility — and ten columns is not a table.
       */}
      <EditorSection>
        <RowListHeader
          title={s.cases}
          count={plural(s, "totalPoints", totalCasePoints(config))}
          addLabel={s.addCase}
          addDisabled={disabled}
          onAdd={() => setCases([...config.tests.cases, { ...NEW_CASE }])}
        />

        <RowList items={config.tests.cases}>
          {(testCase, i) => (
            <CaseFields
              ids={ids}
              index={i}
              testCase={testCase}
              s={s}
              disabled={disabled}
              defaultTimeMs={config.limits.timeMs}
              argsText={argsDraft[i] ?? (testCase.args ?? []).join("\n")}
              onArgs={(text) => writeArgs(i, text)}
              patch={(next) => patchCase(i, next)}
              removeDisabled={disabled || config.tests.cases.length <= 1}
              onRemove={() => setCases(removeAt(config.tests.cases, i))}
              issues={issuesAt(issues, "tests", "cases", i)}
            />
          )}
        </RowList>
        <IssueList issues={caseIssues} />
        <p className={hint}>{s.timeMsHint}</p>
        <p className={hint}>{s.exitCodeHint}</p>
      </EditorSection>

      <IssueList issues={advancedIssues} />
      <AdvancedDisclosure summary={s.advanced} className="grid gap-4 sm:grid-cols-2">
        <AdvancedFields ids={ids} config={config} s={s} disabled={disabled} patch={patch} patchTests={patchTests} />
      </AdvancedDisclosure>
    </div>
  );
}

type Patch = (next: Partial<CodeConfig>) => void;

/** One case's panel: its head line, its command line and input, and its two checks. */
function CaseFields({
  ids,
  index: i,
  testCase,
  s,
  disabled,
  defaultTimeMs,
  argsText,
  onArgs,
  patch,
  removeDisabled,
  onRemove,
  issues,
}: {
  ids: string;
  index: number;
  testCase: CodeCase;
  s: CodeEditorStrings;
  disabled: boolean | undefined;
  /** The question's time limit, the placeholder of an empty per-case budget. */
  defaultTimeMs: number;
  argsText: string;
  onArgs: (text: string) => void;
  patch: (next: Partial<CodeCase>) => void;
  removeDisabled: boolean | undefined;
  onRemove: () => void;
  issues: readonly ConfigIssue[];
}): ReactNode {
  const compareStdout = testCase.compareStdout !== false;
  return (
    <>
      <RowHead
        disabled={disabled}
        nameId={`${ids}-name-${i}`}
        nameLabel={fmt(s.case, { n: i + 1 })}
        nameAriaLabel={`${s.caseName} ${i + 1}`}
        name={testCase.name}
        onNameChange={(name) => patch({ name })}
        pointsId={`${ids}-points-${i}`}
        pointsLabel={s.points}
        pointsAriaLabel={`${s.points} ${i + 1}`}
        points={testCase.points}
        onPointsChange={(points) => patch({ points: points || 0 })}
        hiddenLabel={s.hidden}
        hiddenAriaLabel={`${s.hidden} ${i + 1}`}
        visible={testCase.visible}
        onVisibleChange={(visible) => patch({ visible })}
        removeLabel={fmt(s.removeCase, { name: testCase.name })}
        removeDisabled={removeDisabled}
        onRemove={onRemove}
      >
        <NumberField
          id={`${ids}-time-${i}`}
          label={s.timeMs}
          aria-label={`${s.timeMs} ${i + 1}`}
          value={testCase.timeMs}
          min={100}
          step={100}
          placeholder={String(defaultTimeMs)}
          width="w-24"
          disabled={disabled}
          onChange={(timeMs) => patch({ timeMs })}
          onClear={() => patch({ timeMs: null })}
        />
      </RowHead>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <FieldCell label={s.args} htmlFor={`${ids}-args-${i}`}>
          <textarea
            id={`${ids}-args-${i}`}
            rows={2}
            className={cx(input, "w-full py-1.5 font-mono")}
            aria-label={`${s.args} ${i + 1}`}
            disabled={disabled}
            value={argsText}
            onChange={(e) => onArgs(e.target.value)}
          />
          <p className={hint}>{s.argsHint}</p>
        </FieldCell>
        <FieldCell label={s.stdin} htmlFor={`${ids}-stdin-${i}`}>
          <textarea
            id={`${ids}-stdin-${i}`}
            rows={2}
            className={cx(input, "w-full py-1.5 font-mono")}
            aria-label={`${s.stdin} ${i + 1}`}
            disabled={disabled}
            value={testCase.stdin}
            onChange={(e) => patch({ stdin: e.target.value })}
          />
        </FieldCell>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <CheckboxField
          className="flex h-8.5 items-center gap-2 text-[13px] text-fg"
          label={s.compareStdout}
          aria-label={`${s.compareStdout} ${i + 1}`}
          checked={compareStdout}
          disabled={disabled}
          onChange={(next) => patch({ compareStdout: next })}
        />
        {/* Off, there is no expected output to write: the case checks
            the exit code alone, so the field goes away with it. */}
        {compareStdout ? (
          <FieldCell
            label={s.expected}
            htmlFor={`${ids}-expected-${i}`}
            className="min-w-48 flex-1"
          >
            <input
              id={`${ids}-expected-${i}`}
              className={cx(inputSm, "w-full font-mono")}
              aria-label={`${s.expected} ${i + 1}`}
              disabled={disabled}
              value={testCase.expected}
              onChange={(e) => patch({ expected: e.target.value })}
            />
          </FieldCell>
        ) : null}
        <NumberField
          id={`${ids}-exit-${i}`}
          label={s.exitCode}
          aria-label={`${s.exitCode} ${i + 1}`}
          value={testCase.expectedExitCode}
          min={0}
          max={255}
          placeholder={s.exitCodeAny}
          width="w-24"
          disabled={disabled}
          onChange={(code) => patch({ expectedExitCode: code || 0 })}
          onClear={() => patch({ expectedExitCode: null })}
        />
      </div>
      <IssueList issues={issues} />
    </>
  );
}

/** What "Advanced options" holds: the action, the build, the budgets, the comparison. */
function AdvancedFields({
  ids,
  config,
  s,
  disabled,
  patch,
  patchTests,
}: {
  ids: string;
  config: CodeConfig;
  s: CodeEditorStrings;
  disabled: boolean | undefined;
  patch: Patch;
  patchTests: (next: Partial<CodeConfig["tests"]>) => void;
}): ReactNode {
  const compare = config.tests.compare;
  const patchCompare = (next: Partial<CodeConfig["tests"]["compare"]>) =>
    patchTests({ compare: { ...compare, ...next } });
  return (
    <>
      <ProgramAdvancedFields
        ids={ids}
        config={config}
        s={s}
        disabled={disabled}
        patch={patch}
        defaultLimits={DEFAULT_LIMITS}
      />
      <CheckboxField
        className={setting}
        label={s.allOrNothing}
        checked={config.allOrNothing}
        disabled={disabled}
        onChange={(allOrNothing) => patch({ allOrNothing })}
      />
      <p className={cx(hint, "sm:col-span-2")}>{s.allOrNothingHint}</p>

      <h4 className={cx("text-[13px] font-medium text-fg", "sm:col-span-2")}>{s.compare}</h4>
      <CheckboxField
        className={setting}
        label={s.trimTrailing}
        checked={compare.trimTrailing}
        disabled={disabled}
        onChange={(trimTrailing) => patchCompare({ trimTrailing })}
      />
      <CheckboxField
        className={setting}
        label={s.ignoreCase}
        checked={compare.ignoreCase}
        disabled={disabled}
        onChange={(ignoreCase) => patchCompare({ ignoreCase })}
      />
      <FieldCell label={s.numeric} htmlFor={`${ids}-numeric`}>
        <select
          id={`${ids}-numeric`}
          disabled={disabled}
          value={compare.numeric === null ? "off" : compare.numeric.mode}
          onChange={(e) =>
            patchCompare({
              numeric:
                e.target.value === "off"
                  ? null
                  : {
                      epsilon: compare.numeric?.epsilon ?? 1e-6,
                      mode: e.target.value === "rel" ? "rel" : "abs",
                    },
            })
          }
          className={cx(input, "h-8.5")}
        >
          <option value="off">{s.numericOff}</option>
          <option value="abs">{s.numericAbs}</option>
          <option value="rel">{s.numericRel}</option>
        </select>
      </FieldCell>
      {compare.numeric === null ? null : (
        <FieldCell label={s.epsilon} htmlFor={`${ids}-epsilon`}>
          <input
            id={`${ids}-epsilon`}
            type="number"
            min={0}
            step="any"
            className={cx(input, "h-8.5 tabular-nums")}
            disabled={disabled}
            value={compare.numeric.epsilon}
            onChange={(e) =>
              patchCompare({
                numeric: {
                  epsilon: Number(e.target.value) || 0,
                  mode: compare.numeric?.mode ?? "abs",
                },
              })
            }
          />
        </FieldCell>
      )}
    </>
  );
}

export default CodeEditor;
