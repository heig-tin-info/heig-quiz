/**
 * The teacher's editor for a `circuit` question (docs/spec/04 §4.11).
 *
 * The ONE thing this screen is for is authoring the question: the statement,
 * the palette the student will get, what excites the box and the teacher's
 * own circuit. "Simulate the reference" is a check, one tier below — it never
 * becomes the primary action, and it never blocks publication (decision D14:
 * a runner that is not there is a configuration, not an error).
 *
 * The order is the novice order of docs/spec/08: what the question SAYS, then
 * what the student MAY DO, then how it is TESTED, then the key, and only then
 * how it is marked. Everything a teacher touches once a term — the ground
 * convention, the simulation budget — folds into "Advanced options".
 */
import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { fmt, issuesAt, plural, resolveStrings, rootIssues } from "@quiz/core/client";
import type { ConfigIssue, EditorProps, MarkdownRenderer } from "@quiz/core/client";

import { Plot, SchematicEditor, type CanvasStrings } from "./canvas/index.js";
import { COMPONENT_KINDS, type ComponentKind } from "./library.js";
import {
  emptyStimulus,
  totalStimulusPoints,
  type CircuitConfig,
  type CircuitDetails,
  type GradingMode,
  type Load,
  type Schematic,
  type Source,
  type Stimulus,
} from "./schema.js";
import {
  EDITOR_STRINGS,
  KIND_LABELS,
  type CircuitEditorStrings,
  type KindLabels,
} from "./strings.js";
import {
  badge,
  button,
  card,
  cx,
  hint,
  input,
  inputSm,
  IssueList,
  label,
  PromptField,
  sectionTitle,
} from "@quiz/ui";

import { chip, segment, segmentTrack, selectSm } from "./styles.js";

/**
 * What the host answers "Simulate the reference" with.
 *
 * `POST /questions/:id/try` grades the reference AS AN ANSWER and returns
 * this type's own breakdown, so what comes back is the grading details and
 * not a raw runner outcome — the waveforms are already decimated and already
 * paired with their stimulus. `"unavailable"` is the graceful path.
 */
export type CircuitTryOutcome = { details: CircuitDetails } | "unavailable";

export interface CircuitEditorProps extends EditorProps<CircuitConfig> {
  /**
   * Simulates the teacher's own circuit under every stimulus. The host
   * decides how (it posts the reference as an answer); this component never
   * builds a request and never assembles a netlist — the server does, from
   * the stored config (invariant 14).
   */
  onTry?: ((config: CircuitConfig) => Promise<CircuitTryOutcome>) | undefined;
  /** Validation problems of the stored draft (decision D16), placed by field. */
  issues?: readonly ConfigIssue[] | undefined;
  strings?: Partial<CircuitEditorStrings> | undefined;
  /**
   * The component names, keyed by kind rather than by sentence: the same
   * twelve words label a palette chip here, a symbol on the canvas and a
   * diagnostic in the player, so they travel as one dictionary.
   */
  kindLabels?: Partial<KindLabels> | undefined;
  /** The canvas has a dictionary of its own; the host translates it too. */
  canvasStrings?: Partial<CanvasStrings> | undefined;
  /**
   * The host's sanitised markdown view. Absent, the statement falls back to a
   * plain textarea and nothing is previewed: the textarea already shows the
   * source, so there is nothing to fall back to.
   */
  renderMarkdown?: MarkdownRenderer | undefined;
}

type TryState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "unavailable" }
  | { status: "failed"; reason: "runner" | "reference" | "stimulus" }
  | { status: "done"; details: CircuitDetails };

/**
 * The palette, grouped the way a teacher thinks about it rather than in the
 * declaration order of the library: a row of sixteen chips is a wall, five
 * short rows are a menu.
 */
type GroupTitle =
  | "groupPassive"
  | "groupDiodes"
  | "groupTransistors"
  | "groupOpamp"
  | "groupTerminals";

const KIND_GROUPS: ReadonlyArray<{
  readonly title: GroupTitle;
  readonly kinds: readonly ComponentKind[];
}> = [
  { title: "groupPassive", kinds: ["R", "C", "L"] },
  { title: "groupDiodes", kinds: ["D", "DS", "DZ"] },
  { title: "groupTransistors", kinds: ["NPN", "PNP", "NMOS", "PMOS", "NMOSD", "PMOSD"] },
  { title: "groupOpamp", kinds: ["OPAMP"] },
  { title: "groupTerminals", kinds: ["GND", "VCC", "VEE"] },
];

/** A fresh source of each kind, so switching kinds never lands on an invalid one. */
function defaultSource(kind: Source["kind"]): Source {
  switch (kind) {
    case "dc":
      return { kind: "dc", volts: 5 };
    case "sine":
      return { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 };
    case "pulse":
      return { kind: "pulse", low: 0, high: 5, frequencyHz: 1000, dutyCycle: 0.5 };
    case "step":
      return { kind: "step", from: 0, to: 5, atMs: 1 };
  }
}

function defaultLoad(kind: Load["kind"]): Load {
  switch (kind) {
    case "open":
      return { kind: "open" };
    case "resistor":
      return { kind: "resistor", ohms: 10_000 };
    case "capacitor":
      return { kind: "capacitor", farads: 1e-7 };
  }
}

/** A segmented control: one `<label>` per value around an `sr-only` radio. */
function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
  labelledBy,
}: {
  name: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean | undefined;
  labelledBy?: string | undefined;
}): ReactNode {
  return (
    <div
      role="radiogroup"
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      className={segmentTrack}
    >
      {options.map((option) => (
        <label key={option.value} className={segment(value === option.value, disabled === true)}>
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/** A labelled number field, which this editor is mostly made of. */
function NumberField({
  id,
  text,
  value,
  onChange,
  disabled,
  min,
  max,
  step,
  placeholder,
  width = "w-28",
}: {
  id: string;
  text: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean | undefined;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | string | undefined;
  placeholder?: string | undefined;
  width?: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={label} htmlFor={id}>
        {text}
      </label>
      <input
        id={id}
        type="number"
        className={cx(inputSm, width, "text-right tabular-nums")}
        disabled={disabled}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        {...(step === undefined ? {} : { step })}
        {...(placeholder === undefined ? {} : { placeholder })}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      />
    </div>
  );
}

export function CircuitEditor({
  config,
  onChange,
  disabled,
  issues = [],
  onTry,
  strings,
  kindLabels,
  canvasStrings,
  RichText,
  renderHelp,
  uploadAsset,
  aside,
}: CircuitEditorProps) {
  const s = resolveStrings(EDITOR_STRINGS, strings);
  const kinds = resolveStrings(KIND_LABELS, kindLabels);
  const ids = useId();
  const [tryState, setTryState] = useState<TryState>({ status: "idle" });

  const patch = (next: Partial<CircuitConfig>) => onChange({ ...config, ...next });
  const patchStimulus = (index: number, next: Partial<Stimulus>) =>
    patch({ stimuli: config.stimuli.map((st, i) => (i === index ? { ...st, ...next } : st)) });

  const toggleKind = (kind: ComponentKind, on: boolean) => {
    const kinds = on
      ? COMPONENT_KINDS.filter((k) => k === kind || config.palette.kinds.includes(k))
      : config.palette.kinds.filter((k) => k !== kind);
    patch({ palette: { ...config.palette, kinds: [...kinds] } });
  };

  async function simulateReference() {
    if (onTry === undefined) return;
    /*
     * The two things that make a simulation impossible are read HERE, before
     * anything leaves: they are mistakes in the text on this screen, and a
     * teacher must read them as such rather than as a simulator failure.
     */
    if (config.reference === null) {
      setTryState({ status: "failed", reason: "reference" });
      return;
    }
    if (config.stimuli.length === 0) {
      setTryState({ status: "failed", reason: "stimulus" });
      return;
    }
    setTryState({ status: "running" });
    try {
      const outcome = await onTry(config);
      if (outcome === "unavailable") {
        setTryState({ status: "unavailable" });
        return;
      }
      setTryState(
        outcome.details.runner === "ok"
          ? { status: "done", details: outcome.details }
          : outcome.details.runner === "unavailable" || outcome.details.runner === "none"
            ? { status: "unavailable" }
            : { status: "failed", reason: "runner" },
      );
    } catch {
      setTryState({ status: "failed", reason: "runner" });
    }
  }

  const modeOptions: ReadonlyArray<{ value: GradingMode; label: string }> = [
    { value: "manual", label: s.modeManual },
    { value: "simulation", label: s.modeSimulation },
    { value: "llm", label: s.modeLlm },
  ];

  /**
   * How the question is marked — the one block the host may take away.
   *
   * It is dressed as a CARD, because that is where it lands: the right column
   * of the question editor, under "Properties" (`EditorProps.aside`). Without
   * an aside the very same node renders in the main column, one section among
   * the others.
   */
  const grading = (
    <section className={cx(aside ? cx(card, "p-4") : "", "flex flex-col gap-3")}>
      {/*
       * The "?" is a SIBLING of the heading, never inside it (DESIGN.md):
       * the three modes are the one choice on this screen a teacher cannot
       * guess from a label, and the long form belongs in the drawer.
       */}
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className={sectionTitle} id={`${ids}-grading`}>
          {s.grading}
        </h3>
        {renderHelp ? renderHelp("circuit-grading") : null}
      </div>
      <Segmented
        name={`${ids}-mode`}
        labelledBy={`${ids}-grading`}
        value={config.grading.mode}
        options={modeOptions}
        disabled={disabled}
        onChange={(mode) => patch({ grading: { ...config.grading, mode } })}
      />
      <p className={hint}>
        {config.grading.mode === "manual"
          ? s.modeManualHint
          : config.grading.mode === "simulation"
            ? s.modeSimulationHint
            : s.modeLlmHint}
      </p>
      <IssueList issues={issuesAt(issues, "grading")} />

      {/* The tolerance means nothing outside `simulation`, and the criteria
          mean nothing inside it: each field exists where it is read. */}
      {config.grading.mode === "simulation" ? (
        <>
          <NumberField
            id={`${ids}-tolerance`}
            text={s.tolerance}
            value={config.grading.tolerance}
            min={0.001}
            max={1}
            step={0.01}
            disabled={disabled}
            onChange={(tolerance) => patch({ grading: { ...config.grading, tolerance } })}
          />
          <p className={hint}>{s.toleranceHint}</p>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label className={label} htmlFor={`${ids}-rubric`}>
            {s.rubric}
          </label>
          <textarea
            id={`${ids}-rubric`}
            rows={4}
            className={cx(input, "w-full py-2 leading-relaxed")}
            disabled={disabled}
            value={config.grading.rubric}
            onChange={(e) => patch({ grading: { ...config.grading, rubric: e.target.value } })}
          />
          <p className={hint}>{s.rubricHint}</p>
        </div>
      )}

      <label className="flex items-center gap-2 text-[13px] text-fg">
        <input
          type="checkbox"
          disabled={disabled || config.reference === null}
          checked={config.showExpected}
          onChange={(e) => patch({ showExpected: e.target.checked })}
        />
        {s.showExpected}
      </label>
      <p className={hint}>{s.showExpectedHint}</p>
      <IssueList issues={issuesAt(issues, "showExpected")} />
    </section>
  );

  const main = (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <section className={cx(card, "flex flex-col gap-4 p-4")}>
        <h3 className={sectionTitle}>{s.questionSection}</h3>
        <div className="flex flex-col gap-1.5">
          <PromptField
            id={`${ids}-prompt`}
            label={s.prompt}
            value={config.prompt}
            onChange={(prompt) => patch({ prompt })}
            disabled={disabled}
            RichText={RichText}
            uploadImage={uploadAsset}
            labelClassName={label}
            textareaClassName={cx(input, "w-full py-2 leading-relaxed")}
          />
          <IssueList issues={issuesAt(issues, "prompt")} />
        </div>
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <h3 className={sectionTitle}>{s.palette}</h3>
        <p className={hint}>{s.paletteHint}</p>
        <div className="flex flex-col gap-2.5">
          {KIND_GROUPS.map((group) => (
            // The label is a COLUMN, not the first chip of the row: the six
            // transistors wrap onto a second line at 1440 px, and a label in
            // the flow would leave that line hanging under it.
            <div
              key={group.title}
              className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2"
            >
              {/* Beside the chips where there is room, above them on a phone:
                  a 96 px column out of 390 leaves the pills nothing. */}
              <span className="text-[13px] text-fg-muted sm:w-24 sm:shrink-0 sm:pt-1">
                {s[group.title]}
              </span>
              <div className="flex flex-wrap items-center gap-2">
              {group.kinds.map((kind) => {
                const on = config.palette.kinds.includes(kind);
                return (
                  <label key={kind} className={chip(on, disabled === true)}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      disabled={disabled}
                      onChange={(e) => toggleKind(kind, e.target.checked)}
                    />
                    {kinds[kind]}
                  </label>
                );
              })}
              </div>
            </div>
          ))}
        </div>
        {config.palette.kinds.length === 0 ? (
          <p className="text-[13px] text-danger">{s.paletteEmpty}</p>
        ) : null}
        <IssueList issues={issuesAt(issues, "palette")} />
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            id={`${ids}-max`}
            text={s.maxComponents}
            value={config.palette.maxComponents}
            min={1}
            max={30}
            disabled={disabled}
            width="w-24"
            onChange={(maxComponents) =>
              patch({ palette: { ...config.palette, maxComponents: maxComponents || 1 } })
            }
          />
          <p className={cx(hint, "pb-1.5")}>{s.maxComponentsHint}</p>
        </div>
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <h3 className={sectionTitle}>{s.supplies}</h3>
        <p className={hint}>{s.suppliesHint}</p>
        <div className="flex flex-wrap items-end gap-4">
          {/*
           * An empty field IS "no rail": a nullable number has no second
           * control to switch it off, and a checkbox beside every rail would
           * be two things for one fact.
           */}
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-vcc`}>
              {s.vcc}
            </label>
            <input
              id={`${ids}-vcc`}
              type="number"
              min={0}
              max={100}
              step="any"
              placeholder={s.supplyNone}
              className={cx(inputSm, "w-28 text-right tabular-nums")}
              disabled={disabled}
              value={config.supplies.vcc ?? ""}
              onChange={(e) =>
                patch({
                  supplies: {
                    ...config.supplies,
                    vcc: e.target.value === "" ? null : Number(e.target.value),
                  },
                })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor={`${ids}-vee`}>
              {s.vee}
            </label>
            <input
              id={`${ids}-vee`}
              type="number"
              min={-100}
              max={0}
              step="any"
              placeholder={s.supplyNone}
              className={cx(inputSm, "w-28 text-right tabular-nums")}
              disabled={disabled}
              value={config.supplies.vee ?? ""}
              onChange={(e) =>
                patch({
                  supplies: {
                    ...config.supplies,
                    vee: e.target.value === "" ? null : Number(e.target.value),
                  },
                })
              }
            />
          </div>
        </div>
        <IssueList issues={issuesAt(issues, "supplies")} />
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={sectionTitle}>{s.stimuli}</h3>
          <span className={badge()}>{plural(s, "totalPoints", totalStimulusPoints(config))}</span>
          <button
            type="button"
            className={button("secondary", "sm", "ml-auto")}
            disabled={disabled || config.stimuli.length >= 4}
            onClick={() =>
              patch({
                stimuli: [
                  ...config.stimuli,
                  emptyStimulus({ name: fmt(s.stimulus, { n: config.stimuli.length + 1 }) }),
                ],
              })
            }
          >
            {s.addStimulus}
          </button>
        </div>
        <p className={hint}>{s.stimuliHint}</p>
        {config.stimuli.length === 0 ? <p className={hint}>{s.noStimuli}</p> : null}

        <ol className="flex flex-col gap-3">
          {config.stimuli.map((stimulus, i) => (
            <li key={i} className="rounded-card border border-line bg-surface-2 p-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <label className={label} htmlFor={`${ids}-sname-${i}`}>
                    {fmt(s.stimulus, { n: i + 1 })}
                  </label>
                  <input
                    id={`${ids}-sname-${i}`}
                    className={cx(inputSm, "w-full font-medium")}
                    aria-label={`${s.stimulusName} ${i + 1}`}
                    disabled={disabled}
                    value={stimulus.name}
                    onChange={(e) => patchStimulus(i, { name: e.target.value })}
                  />
                </div>
                <NumberField
                  id={`${ids}-spoints-${i}`}
                  text={s.points}
                  value={stimulus.points}
                  min={0}
                  step={0.5}
                  width="w-20"
                  disabled={disabled}
                  onChange={(points) => patchStimulus(i, { points })}
                />
                <label className="flex h-7 items-center gap-2 text-[13px] text-fg-muted">
                  <input
                    type="checkbox"
                    aria-label={`${s.hidden} ${i + 1}`}
                    disabled={disabled}
                    checked={!stimulus.visible}
                    onChange={(e) => patchStimulus(i, { visible: !e.target.checked })}
                  />
                  {s.hidden}
                </label>
                <button
                  type="button"
                  className={button("ghost", "sm")}
                  aria-label={fmt(s.removeStimulus, { name: stimulus.name })}
                  disabled={disabled}
                  onClick={() => patch({ stimuli: config.stimuli.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <span className={label} id={`${ids}-src-${i}`}>
                  {s.source}
                </span>
                <Segmented
                  name={`${ids}-srck-${i}`}
                  labelledBy={`${ids}-src-${i}`}
                  value={stimulus.source.kind}
                  disabled={disabled}
                  options={[
                    { value: "dc", label: s.sourceDc },
                    { value: "sine", label: s.sourceSine },
                    { value: "pulse", label: s.sourcePulse },
                    { value: "step", label: s.sourceStep },
                  ]}
                  onChange={(kind) => patchStimulus(i, { source: defaultSource(kind) })}
                />
                <div className="flex flex-wrap items-end gap-3">
                  <SourceFields
                    idPrefix={`${ids}-s${i}`}
                    source={stimulus.source}
                    strings={s}
                    disabled={disabled}
                    onChange={(source) => patchStimulus(i, { source })}
                  />
                  <NumberField
                    id={`${ids}-sohms-${i}`}
                    text={s.sourceOhms}
                    value={stimulus.sourceOhms}
                    min={0}
                    step="any"
                    disabled={disabled}
                    onChange={(sourceOhms) => patchStimulus(i, { sourceOhms })}
                  />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className={label} htmlFor={`${ids}-load-${i}`}>
                    {s.load}
                  </label>
                  <select
                    id={`${ids}-load-${i}`}
                    className={cx(selectSm, "w-32")}
                    disabled={disabled}
                    value={stimulus.load.kind}
                    onChange={(e) =>
                      patchStimulus(i, { load: defaultLoad(e.target.value as Load["kind"]) })
                    }
                  >
                    <option value="open">{s.loadOpen}</option>
                    <option value="resistor">{s.loadResistor}</option>
                    <option value="capacitor">{s.loadCapacitor}</option>
                  </select>
                </div>
                {stimulus.load.kind === "resistor" ? (
                  <NumberField
                    id={`${ids}-lohms-${i}`}
                    text={s.loadOhms}
                    value={stimulus.load.ohms}
                    min={0.001}
                    step="any"
                    disabled={disabled}
                    onChange={(ohms) => patchStimulus(i, { load: { kind: "resistor", ohms } })}
                  />
                ) : null}
                {stimulus.load.kind === "capacitor" ? (
                  <NumberField
                    id={`${ids}-lfarads-${i}`}
                    text={s.loadFarads}
                    value={stimulus.load.farads}
                    min={1e-15}
                    step="any"
                    disabled={disabled}
                    onChange={(farads) => patchStimulus(i, { load: { kind: "capacitor", farads } })}
                  />
                ) : null}
              </div>

              {/* A heading over its three fields, like "Source" and "Load"
                  above: a group label parked on the baseline of the inputs
                  reads as a fourth field with no box. */}
              <div className="mt-3 flex flex-col gap-2">
                <span className={label}>{s.analysis}</span>
                <div className="flex flex-wrap items-end gap-3">
                <NumberField
                  id={`${ids}-stop-${i}`}
                  text={s.stopMs}
                  value={stimulus.analysis.stopMs}
                  min={0.001}
                  step="any"
                  width="w-24"
                  disabled={disabled}
                  onChange={(stopMs) =>
                    patchStimulus(i, { analysis: { ...stimulus.analysis, stopMs } })
                  }
                />
                <NumberField
                  id={`${ids}-skip-${i}`}
                  text={s.skipMs}
                  value={stimulus.analysis.skipMs}
                  min={0}
                  step="any"
                  width="w-24"
                  disabled={disabled}
                  onChange={(skipMs) =>
                    patchStimulus(i, { analysis: { ...stimulus.analysis, skipMs } })
                  }
                />
                <NumberField
                  id={`${ids}-pts-${i}`}
                  text={s.samples}
                  value={stimulus.analysis.points}
                  min={50}
                  max={2000}
                  step={50}
                  width="w-24"
                  disabled={disabled}
                  onChange={(points) =>
                    patchStimulus(i, { analysis: { ...stimulus.analysis, points } })
                  }
                />
                </div>
              </div>
              <IssueList issues={issuesAt(issues, "stimuli", i)} />
            </li>
          ))}
        </ol>
        <IssueList issues={issuesAt(issues, "stimuli").filter((x) => x.path.length === 1)} />
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <h3 className={sectionTitle}>{s.reference}</h3>
        <p className={hint}>{s.referenceHint}</p>
        <SchematicEditor
          id={`${ids}-reference`}
          aria-label={s.reference}
          value={config.reference ?? { components: [], wires: [] }}
          onChange={(reference: Schematic) => patch({ reference })}
          palette={{ kinds: config.palette.kinds, maxComponents: 40 }}
          supplies={config.supplies}
          readOnly={disabled === true}
          {...(canvasStrings === undefined ? {} : { strings: canvasStrings })}
        />
        <IssueList issues={issuesAt(issues, "reference")} />

        {onTry === undefined ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={button("secondary", "sm")}
              disabled={disabled || tryState.status === "running"}
              onClick={() => void simulateReference()}
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
                {tryState.reason === "reference"
                  ? s.tryNeedsReference
                  : tryState.reason === "stimulus"
                    ? s.tryNeedsStimulus
                    : s.tryFailed}
              </p>
            ) : null}
            {tryState.status === "done" ? (
              <p role="status" className={hint}>
                {/* The stimuli that produced a WAVEFORM, not the ones that
                    were sent: a count the plots below do not back up is a
                    count the teacher has to distrust. */}
                {plural(s, "tryDone", tryState.details.stimuli.filter((d) => d.series !== null).length)}
              </p>
            ) : null}
          </div>
        )}
        {tryState.status === "done" ? (
          <div
            className={cx(
              "grid gap-3",
              tryState.details.stimuli.filter((d) => d.series !== null).length > 1 &&
                "sm:grid-cols-2",
            )}
          >
            {tryState.details.stimuli.map((detail, i) =>
              detail.series === null ? null : (
                <Plot
                  key={i}
                  title={detail.name}
                  series={detail.series}
                  height={160}
                  {...(canvasStrings === undefined ? {} : { strings: canvasStrings })}
                />
              ),
            )}
          </div>
        ) : null}
      </section>

      <details className={cx(card, "p-4")}>
        <summary className={cx(sectionTitle, "cursor-pointer")}>{s.advanced}</summary>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input
              type="checkbox"
              disabled={disabled}
              checked={config.commonGround}
              onChange={(e) => patch({ commonGround: e.target.checked })}
            />
            {s.commonGround}
          </label>
          <p className={hint}>{s.commonGroundHint}</p>
          <NumberField
            id={`${ids}-spm`}
            text={s.simulationsPerMinute}
            value={config.simulationsPerMinute}
            min={1}
            max={30}
            width="w-24"
            disabled={disabled}
            onChange={(n) => patch({ simulationsPerMinute: n || 1 })}
          />
          <p className={hint}>{s.simulationsPerMinuteHint}</p>
        </div>
      </details>

      {aside ? null : grading}
    </div>
  );

  return aside ? (
    <>
      {main}
      {createPortal(grading, aside)}
    </>
  ) : (
    main
  );
}

/** The parameters of one source kind; the kind itself is the segmented control above. */
function SourceFields({
  idPrefix,
  source,
  strings: s,
  disabled,
  onChange,
}: {
  idPrefix: string;
  source: Source;
  strings: CircuitEditorStrings;
  disabled?: boolean | undefined;
  onChange: (source: Source) => void;
}): ReactNode {
  switch (source.kind) {
    case "dc":
      return (
        <NumberField
          id={`${idPrefix}-volts`}
          text={s.volts}
          value={source.volts}
          step="any"
          disabled={disabled}
          onChange={(volts) => onChange({ kind: "dc", volts })}
        />
      );
    case "sine":
      return (
        <>
          <NumberField
            id={`${idPrefix}-amp`}
            text={s.amplitude}
            value={source.amplitude}
            min={0}
            step="any"
            disabled={disabled}
            onChange={(amplitude) => onChange({ ...source, amplitude })}
          />
          <NumberField
            id={`${idPrefix}-freq`}
            text={s.frequency}
            value={source.frequencyHz}
            min={0.01}
            step="any"
            disabled={disabled}
            onChange={(frequencyHz) => onChange({ ...source, frequencyHz })}
          />
          <NumberField
            id={`${idPrefix}-offset`}
            text={s.offset}
            value={source.offset}
            step="any"
            disabled={disabled}
            onChange={(offset) => onChange({ ...source, offset })}
          />
        </>
      );
    case "pulse":
      return (
        <>
          <NumberField
            id={`${idPrefix}-low`}
            text={s.low}
            value={source.low}
            step="any"
            disabled={disabled}
            onChange={(low) => onChange({ ...source, low })}
          />
          <NumberField
            id={`${idPrefix}-high`}
            text={s.high}
            value={source.high}
            step="any"
            disabled={disabled}
            onChange={(high) => onChange({ ...source, high })}
          />
          <NumberField
            id={`${idPrefix}-pfreq`}
            text={s.frequency}
            value={source.frequencyHz}
            min={0.01}
            step="any"
            disabled={disabled}
            onChange={(frequencyHz) => onChange({ ...source, frequencyHz })}
          />
          <NumberField
            id={`${idPrefix}-duty`}
            text={s.dutyCycle}
            value={source.dutyCycle}
            min={0.01}
            max={0.99}
            step={0.05}
            disabled={disabled}
            onChange={(dutyCycle) => onChange({ ...source, dutyCycle })}
          />
        </>
      );
    case "step":
      return (
        <>
          <NumberField
            id={`${idPrefix}-from`}
            text={s.stepFrom}
            value={source.from}
            step="any"
            disabled={disabled}
            onChange={(from) => onChange({ ...source, from })}
          />
          <NumberField
            id={`${idPrefix}-to`}
            text={s.stepTo}
            value={source.to}
            step="any"
            disabled={disabled}
            onChange={(to) => onChange({ ...source, to })}
          />
          <NumberField
            id={`${idPrefix}-at`}
            text={s.stepAt}
            value={source.atMs}
            min={0}
            step="any"
            disabled={disabled}
            onChange={(atMs) => onChange({ ...source, atMs })}
          />
        </>
      );
  }
}

export default CircuitEditor;
