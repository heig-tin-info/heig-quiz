/**
 * The student's view of a `circuit` question (docs/spec/04 §4.11).
 *
 * The ONE thing this screen is for is the drawing: the canvas is the primary
 * surface, everything else is a line of support around it. "Simulate" is
 * SECONDARY on purpose — a student who never presses it can still answer, and
 * a student who presses it is only checking what they already drew.
 *
 * The strip under the canvas is the whole ergonomics of the type: a netlist
 * extracted at every keystroke says what is still floating, and the same
 * issues light the pins they name. Nothing there is a grade; the answer is
 * saved either way.
 *
 * "Simulate" is optional. With `RUNNER_MODE=stub` — the default until a
 * machine with Podman exists (decision D14) — `onSimulate` resolves with
 * `"unavailable"` and the panel says so in one calm line.
 */
import { useMemo, useState } from "react";

import { resolveStrings } from "@quiz/core/client";
import type { MarkdownRenderer, PlayerProps } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";

import { Plot, SchematicEditor, type CanvasStrings } from "./canvas/index.js";
import { parseSimulation, type SimulationResult } from "./grade.js";
import { formatValue, LIBRARY, PORT_IDS, type PortId } from "./library.js";
import { extractNets, type NetlistIssue } from "./netlist.js";
import type { CircuitAnswer, CircuitStudent, Load, Source, StudentStimulus } from "./schema.js";
import { PLAYER_STRINGS, type CircuitPlayerStrings } from "./strings.js";
import { badge, button, card, cx, hint, sectionTitle, strip } from "./styles.js";

/** What the host answers "Simulate" with; the two words are graceful paths. */
export type CircuitSimulateOutcome = RunnerOutcome | "unavailable" | "rate_limited";

interface CircuitPlayerProps extends PlayerProps<CircuitStudent, CircuitAnswer> {
  /**
   * Runs the VISIBLE stimuli and resolves with the runner's outcome, whose
   * cases are those stimuli in order. The host posts to
   * `POST /attempts/:id/simulate`, which assembles the netlist server-side
   * (invariant 14); nothing about the simulation is ever stored in the answer.
   */
  onSimulate?: ((answer: CircuitAnswer) => Promise<CircuitSimulateOutcome>) | undefined;
  strings?: Partial<CircuitPlayerStrings> | undefined;
  /** The canvas has a dictionary of its own; the host translates it too. */
  canvasStrings?: Partial<CanvasStrings> | undefined;
  /** The host's sanitised markdown view; plain text when absent. */
  renderMarkdown?: MarkdownRenderer | undefined;
}

type SimState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "unavailable" }
  | { status: "rate_limited" }
  | { status: "failed" }
  | { status: "done"; results: SimulationResult[] };

/** One netlist issue in the student's words. */
function sentence(issue: NetlistIssue, s: CircuitPlayerStrings): string {
  switch (issue.code) {
    case "floating_pin":
      return s.issueFloatingPin(issue.ref);
    case "unconnected_port":
      return s.issueUnconnectedPort(issue.ref);
    case "dangling_wire":
      return s.issueDanglingWire(issue.ref);
    case "no_ground":
      return s.issueNoGround;
    case "missing_value":
      return s.issueMissingValue(issue.ref);
    case "invalid_value":
      return s.issueInvalidValue(issue.ref);
    case "value_out_of_range":
      return s.issueValueOutOfRange(issue.ref);
    case "duplicate_name":
      return s.issueDuplicateName(issue.ref);
    case "too_many_components":
      return s.issueTooManyComponents;
    case "kind_not_allowed":
      return s.issueKindNotAllowed(issue.ref);
    default:
      return issue.ref;
  }
}

/** `Sine 1 V @ 1 kHz · load 10 kΩ · 5 ms`: what a stimulus is, in one line. */
function describeSource(source: Source, s: CircuitPlayerStrings): string {
  switch (source.kind) {
    case "dc":
      return s.srcDc(formatValue(source.volts));
    case "sine":
      return s.srcSine(formatValue(source.amplitude), `${formatValue(source.frequencyHz)}Hz`);
    case "pulse":
      return s.srcPulse(
        formatValue(source.low),
        formatValue(source.high),
        `${formatValue(source.frequencyHz)}Hz`,
      );
    case "step":
      return s.srcStep(formatValue(source.from), formatValue(source.to), formatValue(source.atMs));
  }
}

function describeLoad(load: Load, s: CircuitPlayerStrings): string {
  switch (load.kind) {
    case "open":
      return s.loadOpen;
    case "resistor":
      return s.loadResistor(formatValue(load.ohms));
    case "capacitor":
      return s.loadCapacitor(formatValue(load.farads));
  }
}

function describeStimulus(stimulus: StudentStimulus, s: CircuitPlayerStrings): string {
  return [
    describeSource(stimulus.source, s),
    describeLoad(stimulus.load, s),
    s.window(formatValue(stimulus.analysis.stopMs)),
  ].join(" · ");
}

export function CircuitPlayer({
  student,
  answer,
  onChange,
  readOnly,
  onSimulate,
  strings,
  canvasStrings,
  renderMarkdown,
}: CircuitPlayerProps) {
  const s = resolveStrings(PLAYER_STRINGS, strings);
  const [sim, setSim] = useState<SimState>({ status: "idle" });

  const schematic = useMemo(
    () => answer?.schematic ?? { components: [], wires: [] },
    [answer],
  );

  /*
   * The netlist is extracted at every keystroke, not on a button: the strip
   * it feeds is what tells a student that a pin is still in the air, and a
   * diagnostic that only appears when you ask for it is a diagnostic nobody
   * reads. It is the SAME extractor the grader runs (`netlist.ts`), so what
   * the strip says is what the grade will be based on.
   */
  const netlist = useMemo(
    () =>
      extractNets(schematic, {
        commonGround: student.commonGround,
        palette: student.palette,
        supplies: student.supplies,
      }),
    [schematic, student.commonGround, student.palette, student.supplies],
  );

  /*
   * An issue names a pin as `R1.2` — a designator and a PIN NAME, because
   * that is what a student reads on the symbol. The canvas wants the instance
   * and the pin INDEX, so the two are reconciled here, through the library
   * that owns the pin order.
   */
  const { highlightPins, highlightPorts } = useMemo(() => {
    const pins: { c: string; p: number }[] = [];
    const ports: PortId[] = [];
    for (const issue of netlist.issues) {
      if (issue.code === "unconnected_port") {
        if ((PORT_IDS as readonly string[]).includes(issue.ref)) ports.push(issue.ref as PortId);
        continue;
      }
      const dot = issue.ref.lastIndexOf(".");
      const name = dot === -1 ? issue.ref : issue.ref.slice(0, dot);
      const pinName = dot === -1 ? null : issue.ref.slice(dot + 1);
      const component = schematic.components.find((c) => c.name === name);
      if (component === undefined) continue;
      if (pinName === null) {
        pins.push({ c: component.id, p: 0 });
        continue;
      }
      const index = LIBRARY[component.kind].pins.findIndex((pin) => pin.name === pinName);
      if (index >= 0) pins.push({ c: component.id, p: index });
    }
    return { highlightPins: pins, highlightPorts: ports };
  }, [netlist.issues, schematic.components]);

  async function simulate() {
    if (onSimulate === undefined) return;
    setSim({ status: "running" });
    try {
      const outcome = await onSimulate({ schematic });
      if (outcome === "unavailable") {
        setSim({ status: "unavailable" });
        return;
      }
      if (outcome === "rate_limited") {
        setSim({ status: "rate_limited" });
        return;
      }
      setSim({ status: "done", results: parseSimulation(student, outcome) });
    } catch {
      setSim({ status: "failed" });
    }
  }

  const empty = schematic.components.length === 0 && schematic.wires.length === 0;
  const results = sim.status === "done" ? sim.results : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="whitespace-pre-wrap text-sm text-fg">
        {renderMarkdown ? renderMarkdown(student.prompt) : student.prompt}
      </div>

      <div className="flex flex-col gap-2">
        <SchematicEditor
          aria-label={s.schematic}
          value={schematic}
          onChange={(next) => onChange({ schematic: next })}
          palette={student.palette}
          supplies={student.supplies}
          readOnly={readOnly}
          highlightPins={highlightPins}
          highlightPorts={highlightPorts}
          {...(canvasStrings === undefined ? {} : { strings: canvasStrings })}
        />
        {/*
         * One line, never a panel: it sits UNDER the drawing and must not
         * compete with it. The count first, because it is the budget; then
         * what is still wrong, in the order the extractor found it.
         */}
        <div className={strip} role="status">
          <span className={badge(netlist.counted > student.palette.maxComponents ? "danger" : "neutral")}>
            {s.components(netlist.counted, student.palette.maxComponents)}
          </span>
          {/*
           * An untouched box is not a box full of mistakes: every port is
           * "unconnected" before the first wire, and a student who has drawn
           * nothing is told so by the canvas itself. The strip only speaks
           * once there is something to say about.
           */}
          {empty || netlist.issues.length === 0 ? (
            empty ? null : (
              <span className="text-success">{s.complete}</span>
            )
          ) : (
            netlist.issues.map((issue, i) => (
              <span key={`${issue.code}-${issue.ref}-${i}`} className="text-warning">
                {sentence(issue, s)}
              </span>
            ))
          )}
        </div>
      </div>

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center gap-3">
          <h3 className={sectionTitle}>{s.stimuli}</h3>
          {/*
           * Secondary, and to the right: the primary action of this screen is
           * the circuit above, and a filled button here would claim to be the
           * thing the student came for.
           */}
          {student.canSimulate && onSimulate !== undefined ? (
            <button
              type="button"
              className={button("secondary", "sm", "ml-auto")}
              disabled={readOnly || empty || sim.status === "running"}
              onClick={() => void simulate()}
            >
              {sim.status === "running" ? s.simulating : s.simulate}
            </button>
          ) : null}
        </div>

        {student.visibleStimuli.length === 0 ? (
          <p className={hint}>{s.noStimuli}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {student.visibleStimuli.map((stimulus, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                <span className="font-medium text-fg">{stimulus.name}</span>
                <span className="text-fg-muted">{describeStimulus(stimulus, s)}</span>
              </li>
            ))}
          </ul>
        )}

        {student.canSimulate && onSimulate !== undefined ? (
          <p className={hint}>{s.simulateHint}</p>
        ) : null}
        {empty && student.canSimulate && onSimulate !== undefined ? (
          <p className={hint}>{s.simulateNothing}</p>
        ) : null}

        {/* D14: a runner that is not there is a configuration, so it gets one
            calm line and never the red of a failure. */}
        {sim.status === "unavailable" ? (
          <p role="status" className="rounded-field bg-warning-soft px-3 py-2 text-[13px] text-warning">
            {s.simulateUnavailable}
          </p>
        ) : null}
        {sim.status === "rate_limited" ? (
          <p role="status" className="rounded-field bg-warning-soft px-3 py-2 text-[13px] text-warning">
            {s.simulateRateLimited}
          </p>
        ) : null}
        {sim.status === "failed" ? (
          <p role="status" className="rounded-field bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {s.simulateFailed}
          </p>
        ) : null}

        {results === null ? null : (
          // One plot is a wide plot: a waveform read in half a column is a
          // waveform nobody can read. Two or more share the row.
          <div className={cx("grid gap-3", results.length > 1 && "sm:grid-cols-2")}>
            {results.map((result, i) =>
              result.series === null ? (
                <p key={i} className={hint}>
                  {s.plot(result.name)} — {s.noSeries}
                </p>
              ) : (
                <Plot
                  key={i}
                  title={s.plot(result.name)}
                  series={result.series}
                  height={180}
                  {...(student.showExpected && result.expected !== null
                    ? { expected: result.expected }
                    : {})}
                  {...(canvasStrings === undefined ? {} : { strings: canvasStrings })}
                />
              ),
            )}
          </div>
        )}

        {student.hiddenCount > 0 ? (
          <p className={hint}>{s.hiddenStimuli(student.hiddenCount, student.hiddenPoints)}</p>
        ) : null}
      </section>
    </div>
  );
}

export default CircuitPlayer;
