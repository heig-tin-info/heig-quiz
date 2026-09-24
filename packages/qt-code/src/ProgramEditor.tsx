/**
 * The PROGRAM half of a teacher's editor, shared by `code` and `codeimage`
 * (ADR-021): the statement with the language, the starting code with its
 * locked regions, the reference solution with its "try" row, and the
 * program's own advanced settings (where the student's runs execute, their
 * cooldown, build, budgets, run rate).
 *
 * Each editor adds what judges the program — test cases for `code`, the
 * image and its target for `codeimage` — around these sections. They read
 * and patch the fields of `programFields` only.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { fmt, issuesAt, plural } from "@quiz/core/client";
import type { ConfigIssue, EditorProps } from "@quiz/core/client";

import { splitTemplate, templateMarkerIssues } from "@quiz/domain/lockedTemplate";

import { LockIcon } from "./LockIcon.js";
import { LockedEditor } from "./LockedEditor.js";
import { isLockedLineRange, lockedLineNumbers, lockLines, selectedLines, unlockLines } from "./lockEdit.js";
import { CodeArea, monacoAvailable, type CodeLineDecoration } from "./MonacoHost.js";
import {
  CODE_LANGUAGES,
  RUNNO_LANGUAGES,
  type CodeLanguage,
  type CodeCooldown,
  type CodeLimits,
  type CodeRuntime,
  type ProgramConfig,
} from "./schema.js";
import { joinReference, referenceEditorView } from "./reference.js";
import type { CodeEditorStrings } from "./strings.js";
import {
  badge,
  button,
  cx,
  EditorSection,
  FieldCell,
  hint,
  input,
  IssueList,
  label as labelToken,
  PromptSection,
  Segmented,
  sectionTitle,
} from "@quiz/ui";

/** The keys of the editor dictionary the program half reads. */
export type ProgramEditorStrings = Pick<
  CodeEditorStrings,
  | "questionSection"
  | "prompt"
  | "language"
  | "runtime"
  | "runtimeBackend"
  | "runtimeBrowser"
  | "runtimeBackendHint"
  | "runtimeBrowserHint"
  | "cooldown"
  | "cooldownFixed"
  | "cooldownProgressive"
  | "cooldownFixedHint"
  | "cooldownProgressiveHint"
  | "template"
  | "templateHint"
  | "lockedRegions"
  | "lockedRegions.one"
  | "lock"
  | "unlock"
  | "lockLines"
  | "unlockLines"
  | "markerUnknown"
  | "markerUnopened"
  | "markerNested"
  | "referenceSolution"
  | "referenceSolutionHint"
  | "referenceRegion"
  | "referenceLocked"
  | "referenceExtraPieces"
  | "action"
  | "actionCheck"
  | "actionRun"
  | "compileArgs"
  | "timeLimit"
  | "memoryLimit"
  | "outputLimit"
  | "runsPerMinute"
>;

/** A patch of the program fields; both editors' own `patch` satisfies it. */
export type ProgramPatch = (next: Partial<ProgramConfig>) => void;

/** The top-level program settings "Advanced options" holds, as zod paths. */
export const PROGRAM_ADVANCED_PATHS = [
  "runtime",
  "cooldown",
  "action",
  "compileArgs",
  "limits",
  "runsPerMinute",
  "files",
  "configVersion",
] as const;

/** The languages the browser runner can run; anything else is the server's. */
export const browserCapable = (language: CodeLanguage): boolean =>
  (RUNNO_LANGUAGES as readonly string[]).includes(language);

/** The statement, and under it the language. */
export function ProgramPromptSection({
  ids,
  config,
  patch,
  s,
  disabled,
  issues,
  RichText,
  uploadAsset,
}: {
  ids: string;
  config: ProgramConfig;
  patch: ProgramPatch;
  s: ProgramEditorStrings;
  disabled: boolean | undefined;
  issues: readonly ConfigIssue[];
  RichText: EditorProps<unknown>["RichText"];
  uploadAsset: EditorProps<unknown>["uploadAsset"];
}): ReactNode {
  return (
    <PromptSection
      title={s.questionSection}
      id={`${ids}-prompt`}
      label={s.prompt}
      value={config.prompt}
      onChange={(prompt) => patch({ prompt })}
      disabled={disabled}
      RichText={RichText}
      uploadImage={uploadAsset}
      rows={5}
      issues={issuesAt(issues, "prompt")}
    >
      <div className="flex flex-wrap items-end gap-4">
        <FieldCell label={s.language} htmlFor={`${ids}-language`}>
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
        </FieldCell>
      </div>
      <IssueList issues={issuesAt(issues, "language")} />
    </PromptSection>
  );
}

/** Which sentence reports each kind of marker issue. */
const MARKER_ISSUE = {
  unknown: "markerUnknown",
  unopened: "markerUnopened",
  nested: "markerNested",
} as const;

/** The locked lines as runs, for the editor's whole-line grey. */
function lockedRuns(template: string, language: CodeLanguage): CodeLineDecoration[] {
  const runs: CodeLineDecoration[] = [];
  for (const line of lockedLineNumbers(template, language)) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.toLine === line - 1) last.toLine = line;
    else runs.push({ fromLine: line, toLine: line, className: "bg-surface-2", inlineClassName: "opacity-60" });
  }
  return runs;
}

/**
 * The starting code, and the button that locks part of it.
 *
 * The author never types a marker: they select lines, and a lock button
 * wraps them in `@@lock` / `@@endlock` comment lines (`./lockEdit.ts`), or
 * unlocks them when they are all locked already. The markers stay visible in
 * this editor — that is how an author learns the syntax, and what they will
 * find in an export — while the locked lines are greyed out. A marker the
 * split does not read as its author meant (`@@unlok`, a close with nothing
 * open) is reported under the editor with its line.
 *
 * On Monaco the button floats at the top right of the editor while there is
 * a selection; on the textarea fallback it sits in the section header,
 * enabled by a selection, so the same action is there without Monaco.
 */
export function TemplateSection({
  config,
  patch,
  s,
  disabled,
  issues,
  monaco,
}: {
  config: ProgramConfig;
  patch: ProgramPatch;
  s: ProgramEditorStrings;
  disabled: boolean | undefined;
  issues: readonly ConfigIssue[];
  monaco: boolean | undefined;
}): ReactNode {
  const { template, language } = config;
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
  const withMonaco = monaco ?? monacoAvailable();

  const lockedCount = splitTemplate(template, language).filter((seg) => seg.kind === "locked").length;
  const decorations = useMemo(() => lockedRuns(template, language), [template, language]);
  const markerIssues: ConfigIssue[] = templateMarkerIssues(template, language).map((issue) => ({
    path: ["template"],
    message: fmt(s[MARKER_ISSUE[issue.kind]], { line: issue.line, marker: issue.marker }),
  }));

  const unlocking =
    selection !== null && isLockedLineRange(template, language, selection.from, selection.to);
  const toggle = () => {
    if (selection === null) return;
    const edit = unlocking ? unlockLines : lockLines;
    patch({ template: edit(template, language, selection.from, selection.to) });
    setSelection(null);
  };
  const lockButton = (floating: boolean) => (
    <button
      type="button"
      className={button("secondary", "sm", floating ? "absolute top-2 right-4 z-10" : "ml-auto")}
      title={unlocking ? s.unlockLines : s.lockLines}
      aria-label={unlocking ? s.unlockLines : s.lockLines}
      disabled={disabled || selection === null}
      // Keep the editor's focus, and so its selection, while clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
    >
      <LockIcon open={unlocking} />
      {unlocking ? s.unlock : s.lock}
    </button>
  );

  return (
    <EditorSection>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={sectionTitle}>{s.template}</h3>
        <span className={badge(lockedCount > 0 ? "accent" : "neutral")}>
          {plural(s, "lockedRegions", lockedCount)}
        </span>
        {withMonaco || disabled ? null : lockButton(false)}
      </div>
      {disabled ? null : <p className={hint}>{s.templateHint}</p>}
      <div className="relative">
        <CodeArea
          label={s.template}
          language={language}
          value={template}
          onChange={disabled ? undefined : (next) => patch({ template: next })}
          minLines={10}
          monaco={withMonaco}
          decorations={decorations}
          onTextareaSelect={(start, end) => setSelection(selectedLines(template, start, end))}
          onMount={(editor) => {
            editor.onDidChangeCursorSelection(({ selection: range }) => {
              if (range.isEmpty()) return setSelection(null);
              // A drag over whole lines ends at column 1 of the next one.
              const to =
                range.endColumn === 1 && range.endLineNumber > range.startLineNumber
                  ? range.endLineNumber - 1
                  : range.endLineNumber;
              setSelection({ from: range.startLineNumber, to });
            });
          }}
        />
        {withMonaco && !disabled && selection !== null ? lockButton(true) : null}
      </div>
      <IssueList issues={[...issuesAt(issues, "template"), ...markerIssues]} />
    </EditorSection>
  );
}

/**
 * The reference solution, and whatever checks it — the editor's own "try"
 * row, passed as children, so each type words its result its own way.
 *
 * The teacher writes it in the student's own editor, over the template's
 * locked lines: one editable region per template region, a fresh one showing
 * the template's own text. It is stored as before — the regions joined by
 * `@@next` lines (`./reference.ts`) — but the teacher never types a marker.
 */
export function ReferenceSection({
  config,
  patch,
  s,
  disabled,
  issues,
  monaco,
  children,
}: {
  config: ProgramConfig;
  patch: ProgramPatch;
  s: ProgramEditorStrings;
  disabled: boolean | undefined;
  issues: readonly ConfigIssue[];
  monaco: boolean | undefined;
  children?: ReactNode;
}): ReactNode {
  // Until the teacher types here, an EMPTY piece shows the template's text;
  // afterwards a region they cleared stays clear instead of refilling.
  const [typed, setTyped] = useState(false);
  const segments = useMemo(
    () => splitTemplate(config.template, config.language),
    [config.template, config.language],
  );
  const view = useMemo(
    () => referenceEditorView(config, { prefillEmpty: !typed }),
    [config, typed],
  );
  return (
    <EditorSection title={s.referenceSolution} hint={s.referenceSolutionHint}>
      <LockedEditor
        segments={segments}
        regions={view.regions}
        onChange={
          disabled
            ? undefined
            : (regions) => {
                setTyped(true);
                patch({ referenceSolution: joinReference(config, regions) });
              }
        }
        language={config.language}
        label={s.referenceSolution}
        regionLabel={s.referenceRegion}
        lockedLabel={s.referenceLocked}
        monaco={monaco}
      />
      {view.extra > 0 ? (
        <p role="status" className="rounded-field bg-warning-soft px-3 py-2 text-[13px] text-warning">
          {s.referenceExtraPieces}
        </p>
      ) : null}
      <IssueList issues={issuesAt(issues, "referenceSolution")} />
      {children}
    </EditorSection>
  );
}

/**
 * A number of the advanced settings: a full-height field, and a value that
 * falls back to `fallback` when it is cleared or is not a number.
 */
export function SettingNumber({
  id,
  label,
  min,
  step,
  max,
  value,
  fallback,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  step?: number | undefined;
  max?: number | undefined;
  value: number;
  fallback: number;
  disabled: boolean | undefined;
  onChange: (value: number) => void;
}): ReactNode {
  return (
    <FieldCell label={label} htmlFor={id}>
      <input
        id={id}
        type="number"
        min={min}
        {...(step === undefined ? {} : { step })}
        {...(max === undefined ? {} : { max })}
        className={cx(input, "h-8.5 tabular-nums")}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || fallback)}
      />
    </FieldCell>
  );
}

/**
 * The program's own advanced settings: where the student's runs execute
 * (browser-capable languages only), how the run buttons cool down, the action
 * (when the type offers a choice), the compiler flags, the three budgets and
 * the run rate.
 */
export function ProgramAdvancedFields({
  ids,
  config,
  s,
  disabled,
  patch,
  defaultLimits,
  showAction = true,
}: {
  ids: string;
  config: ProgramConfig;
  s: ProgramEditorStrings;
  disabled: boolean | undefined;
  patch: ProgramPatch;
  /** The type's own budgets, what a cleared field falls back to. */
  defaultLimits: CodeLimits;
  /** `codeimage` always runs: a picture that is only compiled draws nothing. */
  showAction?: boolean | undefined;
}): ReactNode {
  const patchLimits = (next: Partial<ProgramConfig["limits"]>) =>
    patch({ limits: { ...config.limits, ...next } });
  const runtime: CodeRuntime = config.runtime ?? "backend";
  const cooldown: CodeCooldown = config.cooldown ?? "fixed";
  return (
    <>
      {/*
       * Where the student's runs execute, named by what the student gets
       * rather than by where it happens (ADR-015): "Instant" is the browser,
       * "Same as grading" the server that grades. Only for a language the
       * browser runner ships; for every other one there is no choice to
       * offer, and a control that can never change is worse than none.
       */}
      {browserCapable(config.language) ? (
        <div className="flex flex-col gap-1.5">
          <span id={`${ids}-runtime`} className={labelToken}>
            {s.runtime}
          </span>
          <Segmented<CodeRuntime>
            name={`${ids}-runtime`}
            labelledBy={`${ids}-runtime`}
            value={runtime}
            disabled={disabled}
            options={[
              { value: "runno", label: s.runtimeBrowser },
              { value: "backend", label: s.runtimeBackend },
            ]}
            onChange={(next) => patch({ runtime: next })}
          />
          <p className={hint}>{runtime === "runno" ? s.runtimeBrowserHint : s.runtimeBackendHint}</p>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span id={`${ids}-cooldown`} className={labelToken}>
          {s.cooldown}
        </span>
        <Segmented<CodeCooldown>
          name={`${ids}-cooldown`}
          labelledBy={`${ids}-cooldown`}
          value={cooldown}
          disabled={disabled}
          options={[
            { value: "fixed", label: s.cooldownFixed },
            { value: "progressive", label: s.cooldownProgressive },
          ]}
          onChange={(next) => patch({ cooldown: next })}
        />
        <p className={hint}>
          {cooldown === "progressive" ? s.cooldownProgressiveHint : s.cooldownFixedHint}
        </p>
      </div>
      {showAction ? (
        <FieldCell label={s.action} htmlFor={`${ids}-action`}>
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
        </FieldCell>
      ) : null}
      <FieldCell label={s.compileArgs} htmlFor={`${ids}-args`}>
        <input
          id={`${ids}-args`}
          className={cx(input, "h-8.5 font-mono")}
          disabled={disabled}
          value={config.compileArgs}
          onChange={(e) => patch({ compileArgs: e.target.value })}
        />
      </FieldCell>
      <SettingNumber
        id={`${ids}-time`}
        label={s.timeLimit}
        min={100}
        step={100}
        value={config.limits.timeMs}
        fallback={defaultLimits.timeMs}
        disabled={disabled}
        onChange={(timeMs) => patchLimits({ timeMs })}
      />
      <SettingNumber
        id={`${ids}-memory`}
        label={s.memoryLimit}
        min={16}
        step={16}
        value={config.limits.memoryMb}
        fallback={defaultLimits.memoryMb}
        disabled={disabled}
        onChange={(memoryMb) => patchLimits({ memoryMb })}
      />
      <SettingNumber
        id={`${ids}-output`}
        label={s.outputLimit}
        min={1}
        step={1}
        value={config.limits.outputKb}
        fallback={defaultLimits.outputKb}
        disabled={disabled}
        onChange={(outputKb) => patchLimits({ outputKb })}
      />
      <SettingNumber
        id={`${ids}-rpm`}
        label={s.runsPerMinute}
        min={1}
        max={30}
        value={config.runsPerMinute}
        fallback={1}
        disabled={disabled}
        onChange={(runsPerMinute) => patch({ runsPerMinute })}
      />
    </>
  );
}
