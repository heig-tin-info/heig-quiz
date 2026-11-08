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
import type { ConfigIssue, EditorProps } from "@quiz/core/client";

import { CIRCUIT_LIBRARY, Plot, SchematicEditor, type CanvasStrings } from "./canvas/index.js";
import { COMPONENT_KINDS, offeredKinds, type ComponentKind } from "./library.js";
import {
  DEFAULT_BODE,
  emptyStimulus,
  totalStimulusPoints,
  type BodeTolerance,
  type CircuitConfig,
  type CircuitDetails,
  type GradingMode,
  type Schematic,
  type Stimulus,
  type Supplies,
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
  NumberField,
  patchAt,
  PromptSection,
  removeAt,
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

import { BodeFields } from "./editor/BodeFields.js";
import { NumberFields, type NumberFieldSpec } from "./editor/NumberFields.js";
import { StimulusFields } from "./editor/StimulusFields.js";
import { chip } from "./styles.js";

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
  strings?: Partial<CircuitEditorStrings> | undefined;
  /**
   * The component names, keyed by kind rather than by sentence: the same
   * twelve words label a palette chip here, a symbol on the canvas and a
   * diagnostic in the player, so they travel as one dictionary.
   */
  kindLabels?: Partial<KindLabels> | undefined;
  /** The canvas has a dictionary of its own; the host translates it too. */
  canvasStrings?: Partial<CanvasStrings> | undefined;
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

const SUPPLIES: readonly NumberFieldSpec<Supplies>[] = [
  { key: "vcc", id: "vcc", label: "vcc", min: 0, max: 100, step: "any", nullable: true },
  { key: "vee", id: "vee", label: "vee", min: -100, max: 0, step: "any", nullable: true },
];

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
  onCanvasShortcuts,
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
          <NumberFields
            fields={SUPPLIES}
            idPrefix={ids}
            value={config.supplies}
            s={s}
            disabled={disabled}
            onChange={(supplies) => patch({ supplies })}
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
              library={CIRCUIT_LIBRARY}
              aria-label={s.reference}
              value={config.reference ?? { components: [], wires: [] }}
              onChange={(reference: Schematic) => patch({ reference })}
              palette={{ kinds: offeredKinds(config.palette, config.supplies), maxComponents: 40 }}
              readOnly={disabled === true}
              {...(expanded ? { height: "fill" as const } : {})}
              {...canvasProps(canvasStrings)}
              onShortcuts={onCanvasShortcuts}
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


export default CircuitEditor;
