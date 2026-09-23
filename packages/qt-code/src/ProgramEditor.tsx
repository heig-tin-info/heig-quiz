/**
 * The PROGRAM half of a teacher's editor, shared by `code` and `codeimage`
 * (ADR-021): the statement with the language and the runtime, the starting
 * code with its locked regions, the reference solution with its "try" row,
 * and the program's own advanced settings (build, budgets, run rate).
 *
 * Each editor adds what judges the program — test cases for `code`, the
 * image and its target for `codeimage` — around these sections. They read
 * and patch the fields of `programFields` only.
 */
import type { ReactNode } from "react";

import { issuesAt, plural } from "@quiz/core/client";
import type { ConfigIssue, EditorProps } from "@quiz/core/client";

import { CodeArea } from "./MonacoHost.js";
import { splitForDisplay } from "./segments.js";
import {
  CODE_LANGUAGES,
  RUNNO_LANGUAGES,
  type CodeLanguage,
  type CodeLimits,
  type CodeRuntime,
  type ProgramConfig,
} from "./schema.js";
import type { CodeEditorStrings } from "./strings.js";
import {
  badge,
  cx,
  EditorSection,
  FieldCell,
  hint,
  input,
  IssueList,
  PromptSection,
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
  | "runtimeHint"
  | "template"
  | "templateHint"
  | "lockedRegions"
  | "lockedRegions.one"
  | "studentPreview"
  | "locked"
  | "editable"
  | "referenceSolution"
  | "referenceSolutionHint"
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

/** The statement, and under it the language and where the student's trial runs. */
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
        {/*
         * Only for a language the browser runner ships (ADR-015). For every
         * other one the question has no choice to offer, and a disabled
         * control that can never be enabled is worse than no control.
         */}
        {browserCapable(config.language) ? (
          <FieldCell label={s.runtime} htmlFor={`${ids}-runtime`}>
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
          </FieldCell>
        ) : null}
      </div>
      {browserCapable(config.language) ? <p className={hint}>{s.runtimeHint}</p> : null}
      <IssueList issues={[...issuesAt(issues, "language"), ...issuesAt(issues, "runtime")]} />
    </PromptSection>
  );
}

/** The starting code, and what of it the student will be able to edit. */
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
  const segments = splitForDisplay(config.template, config.language);
  const lockedCount = segments.filter((seg) => seg.kind === "locked").length;
  return (
    <EditorSection>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={sectionTitle}>{s.template}</h3>
        <span className={badge(lockedCount > 0 ? "accent" : "neutral")}>
          {plural(s, "lockedRegions", lockedCount)}
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
      <IssueList issues={issuesAt(issues, "template")} />
      <h4 className="text-[13px] font-medium text-fg-muted">{s.studentPreview}</h4>
      <ol className="flex flex-col gap-1">
        {segments.map((segment, i) => (
          <li key={i} className="flex items-baseline gap-2 text-[13px]" data-kind={segment.kind}>
            <span className={badge(segment.kind === "locked" ? "neutral" : "success")}>
              {segment.kind === "locked" ? s.locked : s.editable}
            </span>
            <span className="truncate font-mono text-fg-muted">
              {segment.display.split("\n")[0] || "—"}
            </span>
          </li>
        ))}
      </ol>
    </EditorSection>
  );
}

/**
 * The reference solution, and whatever checks it — the editor's own "try"
 * row, passed as children, so each type words its result its own way.
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
  return (
    <EditorSection title={s.referenceSolution} hint={s.referenceSolutionHint}>
      <CodeArea
        label={s.referenceSolution}
        language={config.language}
        value={config.referenceSolution}
        onChange={disabled ? undefined : (next) => patch({ referenceSolution: next })}
        minLines={6}
        monaco={monaco}
      />
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
 * The program's own advanced settings: the action (when the type offers a
 * choice), the compiler flags, the three budgets and the run rate.
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
  return (
    <>
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
