/**
 * The teacher's editor for a `logic` question (docs/spec/04 §4.18).
 *
 * The ONE thing it is for is the specification: the statement, the inputs,
 * the outputs and the key — each output's expression (combinational) or the
 * test vectors (sequential), chosen by a segmented control. The palette and
 * the symbols follow; the scoring has nothing to set, so its aside only says
 * how the points are counted.
 *
 * Every expression and the vectors are parsed at the keystroke by the
 * domain's parser, the one the config schema runs at publication, so the
 * line under the field says where it stops reading, and a readable
 * expression shows as the student's key will.
 */
import { useId } from "react";

import { fmt, issuesAt, resolveStrings, rootIssues } from "@quiz/core/client";
import type { EditorProps } from "@quiz/core/client";
import { LOGIC_LIMITS } from "@quiz/domain/logic";
import {
  AsideSection,
  Button,
  cx,
  EditorSection,
  ErrorText,
  hint,
  IssueList,
  label,
  markdown,
  NumberField,
  PromptSection,
  RemoveRowButton,
  removeAt,
  sectionTitle,
  Segmented,
  textareaClass,
  TextInput,
} from "@quiz/ui";

import { GATE_FAMILIES, LOGIC_GATES_MAX, type GateFamily } from "./logicLibrary.js";
import {
  declaredOf,
  expressionError,
  expressionLatex,
  vectorsError,
  type LogicConfig,
  type LogicMode,
  type LogicSymbols,
} from "./logicSchema.js";
import { LOGIC_EDITOR_STRINGS, LOGIC_KIND_STRINGS, type LogicEditorStrings, type LogicKindStrings } from "./logicStrings.js";
import { chip } from "./styles.js";

export interface LogicEditorProps extends EditorProps<LogicConfig> {
  strings?: Partial<LogicEditorStrings> | undefined;
  /** The gates' names (`qt.logic.kind.*`), shared with the canvas. */
  kindLabels?: Partial<LogicKindStrings> | undefined;
}

/** The first candidate no input nor output already uses. */
function freshName(candidates: string, config: LogicConfig): string {
  const taken = new Set([...config.inputs, ...config.outputs.map((o) => o.name)]);
  return [...candidates].find((c) => !taken.has(c)) ?? `n${taken.size + 1}`;
}

/** What the line under an expression says: where it stops reading, or nothing. */
function expressionProblem(source: string, inputs: readonly string[], s: LogicEditorStrings): string | null {
  if (source.trim() === "") return null;
  const error = expressionError(source, inputs);
  if (error === null) return null;
  if (error.position === null) return s.expressionUnreadable;
  const n = error.position + 1;
  return fmt(error.code === "logic.unknown_identifier" ? s.unknownIdentifier : s.expressionInvalid, { n });
}

/** What the line under the vectors says: what is wrong and on which line, or nothing. */
function vectorsProblem(config: LogicConfig, s: LogicEditorStrings): string | null {
  if (config.vectors.trim() === "") return null;
  const error = vectorsError(config.vectors, declaredOf(config));
  if (error === null) return null;
  const message: Record<string, string> = {
    "logic.vector_empty": s.vectorEmpty,
    "logic.vector_too_long": s.vectorTooLong,
    "logic.vector_header": s.vectorHeader,
    "logic.vector_columns": s.vectorColumns,
    "logic.vector_value": s.vectorValue,
  };
  return fmt(message[error.code] ?? s.vectorEmpty, { line: error.line ?? 1, rows: LOGIC_LIMITS.vectorRows });
}

export function LogicEditor({
  config,
  onChange,
  disabled,
  issues = [],
  strings,
  kindLabels,
  RichText,
  uploadAsset,
  renderMarkdown,
  aside,
}: LogicEditorProps) {
  const s = resolveStrings(LOGIC_EDITOR_STRINGS, strings);
  const kinds = resolveStrings(LOGIC_KIND_STRINGS, kindLabels);
  const ids = useId();
  const patch = (next: Partial<LogicConfig>) => onChange({ ...config, ...next });
  const sequential = config.mode === "sequential";
  const vectorsLine = sequential ? vectorsProblem(config, s) : null;
  const toggleFamily = (family: GateFamily, on: boolean) =>
    patch({
      palette: {
        ...config.palette,
        kinds: GATE_FAMILIES.filter((f) => (f === family ? on : config.palette.kinds.includes(f))),
      },
    });

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <PromptSection
        title={s.questionSection}
        id={`${ids}-prompt`}
        label={s.prompt}
        value={config.prompt}
        onChange={(prompt) => patch({ prompt })}
        disabled={disabled}
        RichText={RichText}
        uploadImage={uploadAsset}
        issues={issuesAt(issues, "prompt")}
      />

      <div className="flex flex-col items-start gap-2">
        <span className={label} id={`${ids}-mode`}>
          {s.mode}
        </span>
        <Segmented<LogicMode>
          name={`${ids}-mode`}
          labelledBy={`${ids}-mode`}
          value={config.mode}
          disabled={disabled}
          options={[
            { value: "combinational", label: s.modeCombinational },
            { value: "sequential", label: s.modeSequential },
          ]}
          onChange={(mode) =>
            // A first switch to vectors starts them with their header: every input, then every output.
            patch({ mode, vectors: config.vectors || `${[...config.inputs, ...config.outputs.map((o) => o.name)].join(" ")}\n` })
          }
        />
      </div>

      <EditorSection title={s.inputs} hint={s.inputsHint}>
        <ul className="flex flex-wrap items-center gap-2">
          {config.inputs.map((name, i) => (
            <li key={i} className="flex items-center gap-1">
              <TextInput
                size="sm"
                className="w-20 font-mono"
                aria-label={fmt(s.input, { n: i + 1 })}
                value={name}
                spellCheck={false}
                autoComplete="off"
                disabled={disabled}
                onChange={(e) => patch({ inputs: config.inputs.map((n, k) => (k === i ? e.target.value : n)) })}
              />
              <RemoveRowButton
                label={fmt(s.removeInput, { name })}
                disabled={disabled || config.inputs.length <= 1}
                onClick={() => patch({ inputs: removeAt(config.inputs, i) })}
              />
            </li>
          ))}
          <li>
            <Button
              size="sm"
              disabled={disabled || config.inputs.length >= LOGIC_LIMITS.inputs}
              onClick={() => patch({ inputs: [...config.inputs, freshName("abcdefghijklmnop", config)] })}
            >
              {s.addInput}
            </Button>
          </li>
        </ul>
        <IssueList issues={issuesAt(issues, "inputs")} />
      </EditorSection>

      <EditorSection title={s.outputs} hint={sequential ? s.inputsHint : s.outputsHint}>
        <ul className="flex flex-col gap-3">
          {config.outputs.map((output, i) => {
            const problem = sequential ? null : expressionProblem(output.expression, config.inputs, s);
            const latex = problem === null && !sequential ? expressionLatex(output.name, output.expression, config.inputs) : null;
            const setOutput = (next: Partial<typeof output>) =>
              patch({ outputs: config.outputs.map((o, k) => (k === i ? { ...o, ...next } : o)) });
            return (
              <li key={i} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <TextInput
                    size="sm"
                    className="w-20 shrink-0 font-mono"
                    aria-label={fmt(s.outputName, { n: i + 1 })}
                    value={output.name}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={disabled}
                    onChange={(e) => setOutput({ name: e.target.value })}
                  />
                  {sequential ? null : (
                    <>
                      <span aria-hidden className="font-mono text-fg-muted">
                        =
                      </span>
                      <TextInput
                        size="sm"
                        className="min-w-0 flex-1 font-mono"
                        aria-label={fmt(s.expression, { name: output.name })}
                        aria-invalid={problem !== null}
                        value={output.expression}
                        spellCheck={false}
                        autoComplete="off"
                        disabled={disabled}
                        onChange={(e) => setOutput({ expression: e.target.value })}
                      />
                    </>
                  )}
                  <RemoveRowButton
                    label={fmt(s.removeOutput, { name: output.name })}
                    disabled={disabled || config.outputs.length <= 1}
                    onClick={() => patch({ outputs: removeAt(config.outputs, i) })}
                  />
                </div>
                {problem !== null ? <ErrorText>{problem}</ErrorText> : null}
                {latex === null ? null : (
                  <div className="text-[13px] text-fg-muted">{markdown(renderMarkdown, `$${latex}$`)}</div>
                )}
                <IssueList issues={issuesAt(issues, "outputs", i)} />
              </li>
            );
          })}
        </ul>
        <div>
          <Button
            size="sm"
            disabled={disabled || config.outputs.length >= LOGIC_LIMITS.outputs}
            onClick={() => patch({ outputs: [...config.outputs, { name: freshName("yzstuvwxqr", config), expression: "" }] })}
          >
            {s.addOutput}
          </Button>
        </div>
        <IssueList issues={issuesAt(issues, "outputs").filter((x) => x.path.length === 1)} />
      </EditorSection>

      {sequential ? (
        <EditorSection title={s.vectors} hint={s.vectorsHint}>
          <textarea
            aria-label={s.vectors}
            rows={Math.min(16, Math.max(6, config.vectors.split("\n").length + 1))}
            className={cx(textareaClass, "w-full font-mono")}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={vectorsLine !== null}
            disabled={disabled}
            value={config.vectors}
            onChange={(e) => patch({ vectors: e.target.value })}
          />
          {/* The live line says where; the saved draft's issue only when there is none (an empty field). */}
          {vectorsLine === null ? <IssueList issues={issuesAt(issues, "vectors")} /> : <ErrorText>{vectorsLine}</ErrorText>}
        </EditorSection>
      ) : null}

      <EditorSection title={s.palette} hint={s.paletteHint}>
        <div className="flex flex-wrap items-center gap-2">
          {GATE_FAMILIES.map((family) => {
            const on = config.palette.kinds.includes(family);
            return (
              <label key={family} className={chip(on, disabled === true)}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={on}
                  disabled={disabled}
                  onChange={(e) => toggleFamily(family, e.target.checked)}
                />
                {kinds[family]}
              </label>
            );
          })}
        </div>
        {config.palette.kinds.length === 0 ? <ErrorText>{s.paletteEmpty}</ErrorText> : null}
        <IssueList issues={issuesAt(issues, "palette")} />
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            id={`${ids}-max`}
            label={s.maxGates}
            value={config.palette.maxGates}
            min={1}
            max={LOGIC_GATES_MAX}
            disabled={disabled}
            width="w-24"
            onChange={(maxGates) => patch({ palette: { ...config.palette, maxGates: maxGates || null } })}
            onClear={() => patch({ palette: { ...config.palette, maxGates: null } })}
          />
          <p className={`${hint} pb-1.5`}>{fmt(s.maxGatesHint, { max: LOGIC_GATES_MAX })}</p>
        </div>
        <div className="flex flex-col items-start gap-2">
          <span className={label} id={`${ids}-symbols`}>
            {s.symbols}
          </span>
          <Segmented<LogicSymbols>
            name={`${ids}-symbols`}
            labelledBy={`${ids}-symbols`}
            value={config.symbols}
            disabled={disabled}
            options={[
              { value: "iec", label: s.symbolsIec },
              { value: "ansi", label: s.symbolsAnsi },
            ]}
            onChange={(symbols) => patch({ symbols })}
          />
        </div>
      </EditorSection>

      <AsideSection aside={aside}>
        <h3 className={sectionTitle}>{s.scoring}</h3>
        <p className={hint}>{sequential ? s.scoringHintSequential : s.scoringHint}</p>
      </AsideSection>
    </div>
  );
}

export default LogicEditor;
