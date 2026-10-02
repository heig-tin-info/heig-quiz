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
import { useId, type ReactNode } from "react";

import { fmt, issuesAt, plural, resolveStrings, rootIssues } from "@quiz/core/client";
import type { ConfigIssue, EditorProps, MarkdownRenderer } from "@quiz/core/client";

import { Plot, SchematicEditor, type CanvasStrings } from "./canvas/index.js";
import { COMPONENT_KINDS, type ComponentKind } from "./library.js";
import {
  DEFAULT_AC_ANALYSIS,
  DEFAULT_ANALYSIS,
  DEFAULT_BODE,
  MAX_ANALYSIS_POINTS,
  biasOf,
  emptyStimulus,
  totalStimulusPoints,
  type Analysis,
  type BodeTolerance,
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
  AdvancedDisclosure,
  AsideSection,
  CheckboxField,
  cx,
  EditorSection,
  ErrorText,
  ExpandableCanvas,
  FieldCell,
  hint,
  IssueList,
  label,
  NumberField,
  patchAt,
  PromptSection,
  removeAt,
  RowHead,
  RowList,
  RowListHeader,
  sectionTitle,
  Segmented,
  setting,
  textareaClass,
  TryPanel,
  tryStatusOf,
  type TryState as UiTryState,
  useReferenceTry,
} from "@quiz/ui";

import { chip, selectSm } from "./styles.js";

/**
 * What the host answers "Simulate the reference" with.
 *
 * `POST /questions/:id/try` grades the reference AS AN ANSWER and returns
 * this type's own breakdown, so what comes back is the grading details and
 * not a raw runner outcome — the waveforms are already decimated and already
 * paired with their stimulus. `"unavailable"` is the graceful path;
 * `"invalid"` says the STORED draft does not validate, which the issues on
 * this page already name.
 */
export type CircuitTryOutcome = { details: CircuitDetails } | "unavailable" | "invalid";

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

type TryDone = { details: CircuitDetails };
type TryReason = "runner" | "reference" | "stimulus" | "draft";
type TryState = UiTryState<TryDone, TryReason>;

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

/** What one simulation of the reference came back with, as a try state. */
async function simulate(
  config: CircuitConfig,
  onTry: (config: CircuitConfig) => Promise<CircuitTryOutcome>,
): Promise<TryState> {
  const outcome = await onTry(config);
  if (outcome === "unavailable") return { status: "unavailable" };
  if (outcome === "invalid") return { status: "failed", reason: "draft" };
  return outcome.details.runner === "ok"
    ? { status: "done", details: outcome.details }
    : outcome.details.runner === "unavailable" || outcome.details.runner === "none"
      ? { status: "unavailable" }
      : { status: "failed", reason: "runner" };
}

/** The canvas dictionary as an optional prop: absent, the canvas keeps its own. */
const canvasProps = (canvasStrings: Partial<CanvasStrings> | undefined) =>
  canvasStrings === undefined ? {} : { strings: canvasStrings };

type Patch = (next: Partial<CircuitConfig>) => void;

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
  Expand,
}: CircuitEditorProps) {
  const s = resolveStrings(EDITOR_STRINGS, strings);
  const kinds = resolveStrings(KIND_LABELS, kindLabels);
  const ids = useId();
  const { state: tryState, run: runTry } = useReferenceTry<TryDone, TryReason>("runner");

  const patch: Patch = (next) => onChange({ ...config, ...next });
  const patchStimulus = (index: number, next: Partial<Stimulus>) =>
    patch({ stimuli: patchAt(config.stimuli, index, next) });

  const toggleKind = (kind: ComponentKind, on: boolean) => {
    const kinds = on
      ? COMPONENT_KINDS.filter((k) => k === kind || config.palette.kinds.includes(k))
      : config.palette.kinds.filter((k) => k !== kind);
    patch({ palette: { ...config.palette, kinds: [...kinds] } });
  };

  function simulateReference() {
    if (onTry === undefined) return;
    /*
     * The two things that make a simulation impossible are read HERE, before
     * anything leaves: they are mistakes in the text on this screen, and a
     * teacher must read them as such rather than as a simulator failure.
     */
    const blocked =
      config.reference === null ? "reference" : config.stimuli.length === 0 ? "stimulus" : null;
    void runTry(blocked, () => simulate(config, onTry));
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

      <EditorSection title={s.palette} hint={s.paletteHint}>
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
          <ErrorText>{s.paletteEmpty}</ErrorText>
        ) : null}
        <IssueList issues={issuesAt(issues, "palette")} />
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            id={`${ids}-max`}
            label={s.maxComponents}
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
      </EditorSection>

      <EditorSection title={s.supplies} hint={s.suppliesHint}>
        <div className="flex flex-wrap items-end gap-4">
          {/*
           * An empty field IS "no rail": a nullable number has no second
           * control to switch it off, and a checkbox beside every rail would
           * be two things for one fact.
           */}
          <NumberField
            id={`${ids}-vcc`}
            label={s.vcc}
            value={config.supplies.vcc}
            min={0}
            max={100}
            step="any"
            placeholder={s.supplyNone}
            disabled={disabled}
            onChange={(vcc) => patch({ supplies: { ...config.supplies, vcc } })}
            onClear={() => patch({ supplies: { ...config.supplies, vcc: null } })}
          />
          <NumberField
            id={`${ids}-vee`}
            label={s.vee}
            value={config.supplies.vee}
            min={-100}
            max={0}
            step="any"
            placeholder={s.supplyNone}
            disabled={disabled}
            onChange={(vee) => patch({ supplies: { ...config.supplies, vee } })}
            onClear={() => patch({ supplies: { ...config.supplies, vee: null } })}
          />
        </div>
        <IssueList issues={issuesAt(issues, "supplies")} />
      </EditorSection>

      <EditorSection>
        <RowListHeader
          title={s.stimuli}
          count={plural(s, "totalPoints", totalStimulusPoints(config))}
          addLabel={s.addStimulus}
          addDisabled={disabled || config.stimuli.length >= 4}
          onAdd={() =>
            patch({
              stimuli: [
                ...config.stimuli,
                emptyStimulus({ name: fmt(s.stimulus, { n: config.stimuli.length + 1 }) }),
              ],
            })
          }
        />
        <p className={hint}>{s.stimuliHint}</p>
        {config.stimuli.length === 0 ? <p className={hint}>{s.noStimuli}</p> : null}

        <RowList items={config.stimuli}>
          {(stimulus, i) => (
            <StimulusFields
              ids={ids}
              index={i}
              stimulus={stimulus}
              s={s}
              disabled={disabled}
              patch={(next) => patchStimulus(i, next)}
              onRemove={() => patch({ stimuli: removeAt(config.stimuli, i) })}
              issues={issuesAt(issues, "stimuli", i)}
            />
          )}
        </RowList>
        <IssueList issues={issuesAt(issues, "stimuli").filter((x) => x.path.length === 1)} />
      </EditorSection>

      <EditorSection>
        {/* Its own Expand button when the host lends a layer (`EditorProps.Expand`). */}
        <ExpandableCanvas
          Expand={Expand}
          title={s.reference}
          heading={<h3 className={sectionTitle}>{s.reference}</h3>}
          hint={<p className={hint}>{s.referenceHint}</p>}
          strings={s}
        >
          {(expanded) => (
            <SchematicEditor
              id={`${ids}-reference`}
              aria-label={s.reference}
              value={config.reference ?? { components: [], wires: [] }}
              onChange={(reference: Schematic) => patch({ reference })}
              palette={{ kinds: config.palette.kinds, maxComponents: 40 }}
              supplies={config.supplies}
              readOnly={disabled === true}
              {...(expanded ? { height: "fill" as const } : {})}
              {...canvasProps(canvasStrings)}
            />
          )}
        </ExpandableCanvas>
        <IssueList issues={issuesAt(issues, "reference")} />

        {onTry === undefined ? null : (
          <TryPanel
            label={s.tryReference}
            runningLabel={s.trying}
            running={tryState.status === "running"}
            disabled={disabled}
            onTry={simulateReference}
            status={tryStatusOf(tryState, {
              unavailable: s.tryUnavailable,
              failed: (reason) =>
                reason === "reference"
                  ? s.tryNeedsReference
                  : reason === "stimulus"
                    ? s.tryNeedsStimulus
                    : reason === "draft"
                      ? s.tryInvalidDraft
                      : s.tryFailed,
              // The stimuli that produced a WAVEFORM, not the ones that were
              // sent: a count the plots below do not back up is a count the
              // teacher has to distrust.
              done: ({ details }) =>
                plural(s, "tryDone", details.stimuli.filter((d) => d.series !== null).length),
            })}
          />
        )}
        {tryState.status === "done" ? (
          <TryPlots details={tryState.details} canvasStrings={canvasStrings} />
        ) : null}
      </EditorSection>

      <AdvancedDisclosure summary={s.advanced} className="flex flex-col gap-3">
        <CheckboxField
          className={setting}
          label={s.commonGround}
          checked={config.commonGround}
          disabled={disabled}
          onChange={(commonGround) => patch({ commonGround })}
        />
        <p className={hint}>{s.commonGroundHint}</p>
        <NumberField
          id={`${ids}-spm`}
          label={s.simulationsPerMinute}
          value={config.simulationsPerMinute}
          min={1}
          max={30}
          width="w-24"
          disabled={disabled}
          onChange={(n) => patch({ simulationsPerMinute: n || 1 })}
        />
        <p className={hint}>{s.simulationsPerMinuteHint}</p>
      </AdvancedDisclosure>

      <GradingSection
        ids={ids}
        config={config}
        s={s}
        disabled={disabled}
        patch={patch}
        issues={issues}
        renderHelp={renderHelp}
        aside={aside}
      />
    </div>
  );
}

/** One stimulus's panel: its head line, its source, its load and its analysis window. */
function StimulusFields({
  ids,
  index: i,
  stimulus,
  s,
  disabled,
  patch,
  onRemove,
  issues,
}: {
  ids: string;
  index: number;
  stimulus: Stimulus;
  s: CircuitEditorStrings;
  disabled: boolean | undefined;
  patch: (next: Partial<Stimulus>) => void;
  onRemove: () => void;
  issues: readonly ConfigIssue[];
}): ReactNode {
  const { analysis, source } = stimulus;
  /*
   * Switching to AC keeps a DC source (its volts become the bias) and turns
   * anything else into a 0 V bias: a sine or a pulse has no operating point,
   * and a stimulus the schema refuses is not a state to switch into.
   */
  const switchAnalysis = (kind: Analysis["kind"]) =>
    kind === "ac"
      ? patch({
          analysis: { ...DEFAULT_AC_ANALYSIS },
          source: source.kind === "dc" ? source : { kind: "dc", volts: 0 },
        })
      : patch({ analysis: { ...DEFAULT_ANALYSIS } });
  return (
    <>
      <RowHead
        disabled={disabled}
        nameId={`${ids}-sname-${i}`}
        nameLabel={fmt(s.stimulus, { n: i + 1 })}
        nameAriaLabel={`${s.stimulusName} ${i + 1}`}
        name={stimulus.name}
        onNameChange={(name) => patch({ name })}
        pointsId={`${ids}-spoints-${i}`}
        pointsLabel={s.points}
        points={stimulus.points}
        onPointsChange={(points) => patch({ points })}
        hiddenLabel={s.hidden}
        hiddenAriaLabel={`${s.hidden} ${i + 1}`}
        visible={stimulus.visible}
        onVisibleChange={(visible) => patch({ visible })}
        removeLabel={fmt(s.removeStimulus, { name: stimulus.name })}
        removeDisabled={disabled}
        onRemove={onRemove}
      />

      {/* First, because it decides what the source below may be. */}
      <div className="mt-3 flex flex-col gap-2">
        <span className={label} id={`${ids}-ank-${i}`}>
          {s.analysisKind}
        </span>
        <Segmented
          name={`${ids}-ank-${i}`}
          labelledBy={`${ids}-ank-${i}`}
          value={analysis.kind === "ac" ? "ac" : "tran"}
          disabled={disabled}
          options={[
            { value: "tran", label: s.analysisTran },
            { value: "ac", label: s.analysisAc },
          ]}
          onChange={switchAnalysis}
        />
        {analysis.kind === "ac" ? <p className={hint}>{s.acHint}</p> : null}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <span className={label} id={`${ids}-src-${i}`}>
          {s.source}
        </span>
        {/* Under AC the source is its bias alone: one field, no kind to pick. */}
        {analysis.kind === "ac" ? null : (
          <Segmented
            name={`${ids}-srck-${i}`}
            labelledBy={`${ids}-src-${i}`}
            value={source.kind}
            disabled={disabled}
            options={[
              { value: "dc", label: s.sourceDc },
              { value: "sine", label: s.sourceSine },
              { value: "pulse", label: s.sourcePulse },
              { value: "step", label: s.sourceStep },
            ]}
            onChange={(kind) => patch({ source: defaultSource(kind) })}
          />
        )}
        <div className="flex flex-wrap items-end gap-3">
          {analysis.kind === "ac" ? (
            <NumberField
              id={`${ids}-bias-${i}`}
              label={s.bias}
              value={biasOf(source)}
              step="any"
              disabled={disabled}
              onChange={(volts) => patch({ source: { kind: "dc", volts } })}
            />
          ) : (
            <SourceFields
              idPrefix={`${ids}-s${i}`}
              source={source}
              strings={s}
              disabled={disabled}
              onChange={(next) => patch({ source: next })}
            />
          )}
          <NumberField
            id={`${ids}-sohms-${i}`}
            label={s.sourceOhms}
            value={stimulus.sourceOhms}
            min={0}
            step="any"
            disabled={disabled}
            onChange={(sourceOhms) => patch({ sourceOhms })}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <FieldCell label={s.load} htmlFor={`${ids}-load-${i}`}>
          <select
            id={`${ids}-load-${i}`}
            className={cx(selectSm, "w-32")}
            disabled={disabled}
            value={stimulus.load.kind}
            onChange={(e) => patch({ load: defaultLoad(e.target.value as Load["kind"]) })}
          >
            <option value="open">{s.loadOpen}</option>
            <option value="resistor">{s.loadResistor}</option>
            <option value="capacitor">{s.loadCapacitor}</option>
          </select>
        </FieldCell>
        {stimulus.load.kind === "resistor" ? (
          <NumberField
            id={`${ids}-lohms-${i}`}
            label={s.loadOhms}
            value={stimulus.load.ohms}
            min={0.001}
            step="any"
            disabled={disabled}
            onChange={(ohms) => patch({ load: { kind: "resistor", ohms } })}
          />
        ) : null}
        {stimulus.load.kind === "capacitor" ? (
          <NumberField
            id={`${ids}-lfarads-${i}`}
            label={s.loadFarads}
            value={stimulus.load.farads}
            min={1e-15}
            step="any"
            disabled={disabled}
            onChange={(farads) => patch({ load: { kind: "capacitor", farads } })}
          />
        ) : null}
      </div>

      {/* A heading over its three fields, like "Source" and "Load"
          above: a group label parked on the baseline of the inputs
          reads as a fourth field with no box. */}
      <div className="mt-3 flex flex-col gap-2">
        <span className={label}>{analysis.kind === "ac" ? s.sweep : s.analysis}</span>
        <div className="flex flex-wrap items-end gap-3">
          <AnalysisFields
            idPrefix={`${ids}-a${i}`}
            analysis={analysis}
            s={s}
            disabled={disabled}
            onChange={(next) => patch({ analysis: next })}
          />
        </div>
      </div>
      <IssueList issues={issues} />
    </>
  );
}

/** The window of a transient, or the band of an AC sweep. */
function AnalysisFields({
  idPrefix,
  analysis,
  s,
  disabled,
  onChange,
}: {
  idPrefix: string;
  analysis: Analysis;
  s: CircuitEditorStrings;
  disabled: boolean | undefined;
  onChange: (analysis: Analysis) => void;
}): ReactNode {
  if (analysis.kind === "ac") {
    return (
      <>
        <NumberField
          id={`${idPrefix}-fstart`}
          label={s.fStartHz}
          value={analysis.fStartHz}
          min={0.01}
          step="any"
          width="w-28"
          disabled={disabled}
          onChange={(fStartHz) => onChange({ ...analysis, fStartHz })}
        />
        <NumberField
          id={`${idPrefix}-fstop`}
          label={s.fStopHz}
          value={analysis.fStopHz}
          max={1e9}
          step="any"
          width="w-28"
          disabled={disabled}
          onChange={(fStopHz) => onChange({ ...analysis, fStopHz })}
        />
        <NumberField
          id={`${idPrefix}-ppd`}
          label={s.pointsPerDecade}
          value={analysis.pointsPerDecade}
          min={5}
          max={200}
          step={5}
          width="w-24"
          disabled={disabled}
          onChange={(pointsPerDecade) => onChange({ ...analysis, pointsPerDecade })}
        />
      </>
    );
  }
  return (
    <>
      <NumberField
        id={`${idPrefix}-stop`}
        label={s.stopMs}
        value={analysis.stopMs}
        min={0.001}
        step="any"
        width="w-24"
        disabled={disabled}
        onChange={(stopMs) => onChange({ ...analysis, stopMs })}
      />
      <NumberField
        id={`${idPrefix}-skip`}
        label={s.skipMs}
        value={analysis.skipMs}
        min={0}
        step="any"
        width="w-24"
        disabled={disabled}
        onChange={(skipMs) => onChange({ ...analysis, skipMs })}
      />
      <NumberField
        id={`${idPrefix}-pts`}
        label={s.samples}
        value={analysis.points}
        min={50}
        max={MAX_ANALYSIS_POINTS}
        step={50}
        width="w-24"
        disabled={disabled}
        onChange={(points) => onChange({ ...analysis, points })}
      />
    </>
  );
}

/** One plot per stimulus that produced a waveform, two abreast when there are several. */
function TryPlots({
  details,
  canvasStrings,
}: {
  details: CircuitDetails;
  canvasStrings: Partial<CanvasStrings> | undefined;
}): ReactNode {
  return (
    <div
      className={cx(
        "grid gap-3",
        details.stimuli.filter((d) => d.series !== null).length > 1 && "sm:grid-cols-2",
      )}
    >
      {details.stimuli.map((detail, i) =>
        detail.series === null ? null : (
          <Plot
            key={i}
            title={detail.name}
            series={detail.series}
            height={160}
            {...canvasProps(canvasStrings)}
          />
        ),
      )}
    </div>
  );
}

/**
 * How the question is marked — the one block the host may take away.
 *
 * It is dressed as a CARD, because that is where it lands: the right column
 * of the question editor, under "Properties" (`EditorProps.aside`). Without
 * an aside the very same node renders in the main column, one section among
 * the others.
 */
function GradingSection({
  ids,
  config,
  s,
  disabled,
  patch,
  issues,
  renderHelp,
  aside,
}: {
  ids: string;
  config: CircuitConfig;
  s: CircuitEditorStrings;
  disabled: boolean | undefined;
  patch: Patch;
  issues: readonly ConfigIssue[];
  renderHelp: CircuitEditorProps["renderHelp"];
  aside: CircuitEditorProps["aside"];
}): ReactNode {
  const modeOptions: ReadonlyArray<{ value: GradingMode; label: string }> = [
    { value: "manual", label: s.modeManual },
    { value: "simulation", label: s.modeSimulation },
  ];
  const modeHint = { manual: s.modeManualHint, simulation: s.modeSimulationHint };
  // `llm` is closed (ADR-063): a draft that still holds it reads, and is
  // graded, as `manual`; publication refuses it until the teacher picks.
  const mode = config.grading.mode === "llm" ? "manual" : config.grading.mode;
  // Every read parses the config; only an invalid draft reaches this screen as
  // stored, and one saved before the AC sweep has no `bode` yet.
  const hasAc = config.stimuli.some((st) => st.analysis.kind === "ac");
  const hasTran = config.stimuli.some((st) => st.analysis.kind === "tran");
  const bode = config.grading.bode ?? DEFAULT_BODE;
  const patchBode = (next: Partial<BodeTolerance>) =>
    patch({ grading: { ...config.grading, bode: { ...bode, ...next } } });
  return (
    <AsideSection aside={aside}>
      {/*
       * The "?" is a SIBLING of the heading, never inside it (DESIGN.md):
       * the grading modes are the one choice on this screen a teacher cannot
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
        value={mode}
        options={modeOptions}
        disabled={disabled}
        onChange={(mode) => patch({ grading: { ...config.grading, mode } })}
      />
      <p className={hint}>{modeHint[mode]}</p>
      <IssueList issues={issuesAt(issues, "grading")} />

      {/* The tolerance means nothing outside `simulation`, and the criteria
          mean nothing inside it: each field exists where it is read. */}
      {config.grading.mode === "simulation" ? (
        <>
          {/* Each rule where a stimulus reads it: the RMS tolerance for a
              transient, the envelope for a sweep. With no stimulus yet the
              tolerance stays, as it always did. */}
          {hasTran || !hasAc ? (
            <>
              <NumberField
                id={`${ids}-tolerance`}
                label={s.tolerance}
                value={config.grading.tolerance}
                min={0.001}
                max={1}
                step={0.01}
                disabled={disabled}
                onChange={(tolerance) => patch({ grading: { ...config.grading, tolerance } })}
              />
              <p className={hint}>{s.toleranceHint}</p>
            </>
          ) : null}
          {hasAc ? (
            <BodeFields ids={ids} bode={bode} s={s} disabled={disabled} onChange={patchBode} />
          ) : null}
        </>
      ) : (
        <FieldCell label={s.rubric} htmlFor={`${ids}-rubric`}>
          <textarea
            id={`${ids}-rubric`}
            rows={4}
            className={cx(textareaClass, "w-full")}
            disabled={disabled}
            value={config.grading.rubric}
            onChange={(e) => patch({ grading: { ...config.grading, rubric: e.target.value } })}
          />
          <p className={hint}>{s.rubricHint}</p>
        </FieldCell>
      )}

      <CheckboxField
        className={setting}
        label={s.showExpected}
        checked={config.showExpected}
        disabled={disabled || config.reference === null}
        onChange={(showExpected) => patch({ showExpected })}
      />
      <p className={hint}>{s.showExpectedHint}</p>
      <IssueList issues={issuesAt(issues, "showExpected")} />
    </AsideSection>
  );
}

/**
 * The envelope an AC stimulus is graded by. The phase has a checkbox of its
 * own rather than an empty field meaning "off": switching a comparison off is
 * a decision, and it should read as one.
 */
function BodeFields({
  ids,
  bode,
  s,
  disabled,
  onChange,
}: {
  ids: string;
  bode: BodeTolerance;
  s: CircuitEditorStrings;
  disabled: boolean | undefined;
  onChange: (next: Partial<BodeTolerance>) => void;
}): ReactNode {
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <NumberField
          id={`${ids}-magdb`}
          label={s.bodeMagDb}
          value={bode.magDb}
          min={0.01}
          max={40}
          step={0.5}
          width="w-24"
          disabled={disabled}
          onChange={(magDb) => onChange({ magDb })}
        />
        <NumberField
          id={`${ids}-floordb`}
          label={s.bodeFloorDb}
          value={bode.floorDb}
          min={1}
          max={200}
          step={10}
          width="w-24"
          disabled={disabled}
          onChange={(floorDb) => onChange({ floorDb })}
        />
      </div>
      <CheckboxField
        className={setting}
        label={s.bodePhase}
        checked={bode.phaseDeg !== null}
        disabled={disabled}
        onChange={(on) => onChange({ phaseDeg: on ? DEFAULT_BODE.phaseDeg : null })}
      />
      {bode.phaseDeg === null ? null : (
        <NumberField
          id={`${ids}-phasedeg`}
          label={s.bodePhaseDeg}
          value={bode.phaseDeg}
          min={0.1}
          max={180}
          step={1}
          width="w-24"
          disabled={disabled}
          onChange={(phaseDeg) => onChange({ phaseDeg })}
        />
      )}
      <p className={hint}>{s.bodeHint}</p>
    </>
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
          label={s.volts}
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
            label={s.amplitude}
            value={source.amplitude}
            min={0}
            step="any"
            disabled={disabled}
            onChange={(amplitude) => onChange({ ...source, amplitude })}
          />
          <NumberField
            id={`${idPrefix}-freq`}
            label={s.frequency}
            value={source.frequencyHz}
            min={0.01}
            step="any"
            disabled={disabled}
            onChange={(frequencyHz) => onChange({ ...source, frequencyHz })}
          />
          <NumberField
            id={`${idPrefix}-offset`}
            label={s.offset}
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
            label={s.low}
            value={source.low}
            step="any"
            disabled={disabled}
            onChange={(low) => onChange({ ...source, low })}
          />
          <NumberField
            id={`${idPrefix}-high`}
            label={s.high}
            value={source.high}
            step="any"
            disabled={disabled}
            onChange={(high) => onChange({ ...source, high })}
          />
          <NumberField
            id={`${idPrefix}-pfreq`}
            label={s.frequency}
            value={source.frequencyHz}
            min={0.01}
            step="any"
            disabled={disabled}
            onChange={(frequencyHz) => onChange({ ...source, frequencyHz })}
          />
          <NumberField
            id={`${idPrefix}-duty`}
            label={s.dutyCycle}
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
            label={s.stepFrom}
            value={source.from}
            step="any"
            disabled={disabled}
            onChange={(from) => onChange({ ...source, from })}
          />
          <NumberField
            id={`${idPrefix}-to`}
            label={s.stepTo}
            value={source.to}
            step="any"
            disabled={disabled}
            onChange={(to) => onChange({ ...source, to })}
          />
          <NumberField
            id={`${idPrefix}-at`}
            label={s.stepAt}
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
