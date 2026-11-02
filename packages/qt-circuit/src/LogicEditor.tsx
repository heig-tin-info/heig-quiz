/**
 * The teacher's editor for a `logic` question (docs/spec/04 §4.18).
 *
 * The ONE thing it is for is the specification: the statement, the inputs,
 * the outputs and the key — each output's expression or a reference circuit
 * (combinational), or the test vectors (sequential), chosen by segmented
 * controls. The reference is drawn on the student's canvas, with the
 * student's palette and symbols, its terminals following the declared names
 * (`fitTerminals`); in sequential mode "Use as reference" writes the vectors'
 * outputs from it, which the teacher may then edit. The palette and the
 * symbols follow; the scoring has nothing to set, so its aside only says how
 * the points are counted.
 *
 * Every expression and the vectors are parsed at the keystroke by the
 * domain's parser, the one the config schema runs at publication, so the
 * line under the field says where it stops reading, and a readable
 * expression shows as the student's key will. The reference is checked the
 * same way: its terminals by the refine's `referencePortsProblem`, its rows by
 * publication's own `referenceUndefinedRow`.
 */
import { useId, useMemo, useState } from "react";

import { fmt, issuesAt, resolveStrings, rootIssues } from "@quiz/core/client";
import type { EditorProps } from "@quiz/core/client";
import { LOGIC_LIMITS, LogicError, truthRows, type VectorErrorCode } from "@quiz/domain/logic";
import {
  AsideSection,
  Button,
  cx,
  DeleteRowButton,
  EditorSection,
  ErrorText,
  ExpandableCanvas,
  hint,
  IssueList,
  label,
  markdown,
  NumberField,
  PromptSection,
  removeAt,
  sectionTitle,
  Segmented,
  textareaClass,
  TextInput,
} from "@quiz/ui";

import { logicLibrary, SchematicEditor, type CanvasStrings } from "./canvas/index.js";
import { GATE_FAMILIES, MEMORY_FAMILIES, offeredLogicKinds, type GateFamily } from "./logicLibrary.js";
import { fitTerminals, vectorsFromReference } from "./logicReference.js";
import {
  declaredOf,
  expressionError,
  expressionLatex,
  initialLogicAnswer,
  referencePortsProblem,
  referenceUndefinedRow,
  vectorsError,
  type LogicConfig,
  type LogicKeyFrom,
  type LogicMode,
  type LogicSchematic,
  type LogicSymbols,
} from "./logicSchema.js";
import { LOGIC_EDITOR_STRINGS, LOGIC_KIND_STRINGS, type LogicEditorStrings, type LogicKindStrings } from "./logicStrings.js";
import { chip } from "./styles.js";

export interface LogicEditorProps extends EditorProps<LogicConfig> {
  strings?: Partial<LogicEditorStrings> | undefined;
  /** The gates' names (`qt.logic.kind.*`), shared with the canvas. */
  kindLabels?: Partial<LogicKindStrings> | undefined;
  /** The reference canvas's dictionary, `circuit`'s words with the logic kinds. */
  canvasStrings?: Partial<CanvasStrings> | undefined;
}

/**
 * What the line under the reference says: its terminals, or the inputs
 * (`a = 0, b = 1`) of the first row on which it reads `X` or `Z`; nothing
 * while none is drawn (the saved draft's issue says it). Up to 1 024
 * simulations: the caller memoizes it on the circuit and the ports.
 */
function referenceProblem(c: Pick<LogicConfig, "inputs" | "outputs" | "reference">, s: LogicEditorStrings): string | null {
  if (c.reference === null) return null;
  if (referencePortsProblem(c) !== null) return s.referencePorts;
  const row = referenceUndefinedRow({ ...c, reference: c.reference });
  if (row === null) return null;
  const bits = truthRows(c.inputs)[row]!;
  return fmt(s.referenceUndefined, { row: c.inputs.map((name, j) => `${name} = ${bits[j]}`).join(", ") });
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
  return error === null ? null : vectorMessage(error, s);
}

/** A vector error in words, with its line. */
function vectorMessage(error: { code: VectorErrorCode; position: number | null }, s: LogicEditorStrings): string {
  const message: Record<VectorErrorCode, string> = {
    "logic.vector_empty": s.vectorEmpty,
    // The text as a whole (no line) is over its length; a line past the step cap is over the steps.
    "logic.vector_too_long": error.position === null ? s.vectorTooManyChars : s.vectorTooLong,
    "logic.vector_header": s.vectorHeader,
    "logic.vector_columns": s.vectorColumns,
    "logic.vector_value": s.vectorValue,
  };
  return fmt(message[error.code], { line: error.position ?? 1, rows: LOGIC_LIMITS.vectorRows, chars: LOGIC_LIMITS.vectorLength });
}

export function LogicEditor({
  config,
  onChange,
  disabled,
  issues = [],
  strings,
  kindLabels,
  canvasStrings,
  RichText,
  uploadAsset,
  renderMarkdown,
  aside,
  Expand,
  onCanvasShortcuts,
}: LogicEditorProps) {
  const s = resolveStrings(LOGIC_EDITOR_STRINGS, strings);
  const kinds = resolveStrings(LOGIC_KIND_STRINGS, kindLabels);
  const ids = useId();
  const patch = (next: Partial<LogicConfig>) => onChange({ ...config, ...next });
  /** New inputs or outputs, the reference's terminals following them. */
  const patchPorts = (next: Partial<Pick<LogicConfig, "inputs" | "outputs">>) =>
    patch({
      ...next,
      reference:
        config.reference === null ? null : fitTerminals(config.reference, declaredOf(config), declaredOf({ ...config, ...next })),
    });
  const sequential = config.mode === "sequential";
  const byReference = !sequential && config.keyFrom === "reference";
  const vectorsLine = sequential ? vectorsProblem(config, s) : null;
  // Up to 1 024 rows simulated: only when the circuit or the ports change, not at every keystroke.
  const { reference, inputs, outputs } = config;
  const referenceLine = useMemo(
    () => (byReference ? referenceProblem({ reference, inputs, outputs }, s) : null),
    // `s` is rebuilt every render; its words never change while the editor is open.
    [byReference, reference, inputs, outputs],
  );
  /** What "Use as reference" could not do, until the vectors change. */
  const [fillProblem, setFillProblem] = useState<string | null>(null);
  const toggleFamily = (family: GateFamily, on: boolean) =>
    patch({
      palette: {
        ...config.palette,
        kinds: GATE_FAMILIES.filter((f) => (f === family ? on : config.palette.kinds.includes(f))),
      },
    });

  function fillFromReference() {
    try {
      const filled = vectorsFromReference(config);
      if ("problem" in filled) {
        setFillProblem(filled.problem === "logic.reference_missing" ? s.referenceMissing : s.referencePorts);
        return;
      }
      setFillProblem(null);
      patch({ vectors: filled.vectors });
    } catch (error) {
      if (!(error instanceof LogicError)) throw error;
      setFillProblem(
        error.code === "logic.reference_undefined"
          ? fmt(s.referenceUndefinedStep, { line: error.position ?? 1 })
          : vectorMessage(error as LogicError & { code: VectorErrorCode }, s),
      );
    }
  }

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

      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
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
            onChange={(mode) => {
              // A first switch to vectors starts them with their header: every input, then every output.
              const { inputs, outputs } = declaredOf(config);
              patch({ mode, vectors: config.vectors || `${[...inputs, ...outputs].join(" ")}\n` });
            }}
          />
        </div>
        {sequential ? null : (
          <div className="flex flex-col items-start gap-2">
            <span className={label} id={`${ids}-key`}>
              {s.keyFrom}
            </span>
            <Segmented<LogicKeyFrom>
              name={`${ids}-key`}
              labelledBy={`${ids}-key`}
              value={config.keyFrom}
              disabled={disabled}
              options={[
                { value: "expressions", label: s.keyExpressions },
                { value: "reference", label: s.keyReference },
              ]}
              onChange={(keyFrom) => patch({ keyFrom })}
            />
          </div>
        )}
      </div>

      <EditorSection title={s.inputs} hint={s.inputsHint}>
        <ul className="flex flex-col gap-2">
          {config.inputs.map((name, i) => (
            <li key={i} className="flex items-center gap-2">
              <TextInput
                size="sm"
                className="w-24 font-mono"
                aria-label={fmt(s.input, { n: i + 1 })}
                value={name}
                spellCheck={false}
                autoComplete="off"
                disabled={disabled}
                onChange={(e) => patchPorts({ inputs: config.inputs.map((n, k) => (k === i ? e.target.value : n)) })}
              />
              <DeleteRowButton
                label={fmt(s.removeInput, { name: name || String(i + 1) })}
                disabled={disabled || config.inputs.length <= 1}
                onClick={() => patchPorts({ inputs: removeAt(config.inputs, i) })}
              />
            </li>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            disabled={disabled || config.inputs.length >= LOGIC_LIMITS.inputs}
            onClick={() => patchPorts({ inputs: [...config.inputs, freshName("abcdefghijklmnop", config)] })}
          >
            {s.addInput}
          </Button>
        </div>
        <IssueList issues={issuesAt(issues, "inputs")} />
      </EditorSection>

      <EditorSection title={s.outputs} hint={sequential || byReference ? s.inputsHint : s.outputsHint}>
        <ul className="flex flex-col gap-3">
          {config.outputs.map((output, i) => {
            const withExpression = !sequential && !byReference;
            const problem = withExpression ? expressionProblem(output.expression, config.inputs, s) : null;
            const latex = problem === null && withExpression ? expressionLatex(output.name, output.expression, config.inputs) : null;
            const outputsWith = (next: Partial<typeof output>) =>
              config.outputs.map((o, k) => (k === i ? { ...o, ...next } : o));
            return (
              <li key={i} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <TextInput
                    size="sm"
                    className="w-24 shrink-0 font-mono"
                    aria-label={fmt(s.outputName, { n: i + 1 })}
                    value={output.name}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={disabled}
                    onChange={(e) => patchPorts({ outputs: outputsWith({ name: e.target.value }) })}
                  />
                  {withExpression ? (
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
                        onChange={(e) => patch({ outputs: outputsWith({ expression: e.target.value }) })}
                      />
                    </>
                  ) : null}
                  <DeleteRowButton
                    label={fmt(s.removeOutput, { name: output.name || String(i + 1) })}
                    disabled={disabled || config.outputs.length <= 1}
                    onClick={() => patchPorts({ outputs: removeAt(config.outputs, i) })}
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
            onClick={() => patchPorts({ outputs: [...config.outputs, { name: freshName("yzstuvwxqr", config), expression: "" }] })}
          >
            {s.addOutput}
          </Button>
        </div>
        <IssueList issues={issuesAt(issues, "outputs").filter((x) => x.path.length === 1)} />
      </EditorSection>

      {sequential || byReference ? (
        <EditorSection>
          {/* Its own Expand button when the host lends a layer (`EditorProps.Expand`). */}
          <ExpandableCanvas
            Expand={Expand}
            title={s.reference}
            heading={<h3 className={sectionTitle}>{s.reference}</h3>}
            hint={<p className={hint}>{sequential ? s.referenceHintSequential : s.referenceHint}</p>}
            strings={s}
          >
            {(expanded) => (
              <SchematicEditor
                id={`${ids}-reference`}
                library={logicLibrary(config.symbols)}
                aria-label={s.reference}
                value={config.reference ?? initialLogicAnswer(declaredOf(config)).schematic}
                onChange={(reference: LogicSchematic) => patch({ reference })}
                palette={{
                  // A combinational reference holds no memory: each row starts from a fresh state.
                  kinds: offeredLogicKinds(
                    sequential ? config.palette.kinds : config.palette.kinds.filter((f) => !(MEMORY_FAMILIES as readonly string[]).includes(f)),
                  ),
                  maxComponents: LOGIC_LIMITS.gates,
                }}
                readOnly={disabled === true}
                {...(expanded ? { height: "fill" as const } : {})}
                {...(canvasStrings === undefined ? {} : { strings: canvasStrings })}
                onShortcuts={onCanvasShortcuts}
              />
            )}
          </ExpandableCanvas>
          {referenceLine === null ? <IssueList issues={issuesAt(issues, "reference")} /> : <ErrorText>{referenceLine}</ErrorText>}
        </EditorSection>
      ) : null}

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
            onChange={(e) => {
              setFillProblem(null);
              patch({ vectors: e.target.value });
            }}
          />
          {/* The live line says where; the saved draft's issue only when there is none (an empty field). */}
          {vectorsLine === null ? <IssueList issues={issuesAt(issues, "vectors")} /> : <ErrorText>{vectorsLine}</ErrorText>}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={disabled} onClick={fillFromReference}>
              {s.useReference}
            </Button>
            <p className={hint}>{s.useReferenceHint}</p>
          </div>
          {fillProblem === null ? null : <ErrorText>{fillProblem}</ErrorText>}
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
            max={LOGIC_LIMITS.gates}
            disabled={disabled}
            width="w-24"
            onChange={(maxGates) => patch({ palette: { ...config.palette, maxGates: maxGates || null } })}
            onClear={() => patch({ palette: { ...config.palette, maxGates: null } })}
          />
          <p className={`${hint} pb-1.5`}>{fmt(s.maxGatesHint, { max: LOGIC_LIMITS.gates })}</p>
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
