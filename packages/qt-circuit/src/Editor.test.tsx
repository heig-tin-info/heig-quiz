/**
 * Editor smoke tests.
 *
 * The canvas is replaced by a stub: `SchematicEditor` is a pointer surface
 * with its own suite, and under jsdom it would measure a zero-sized box and
 * tell us nothing about THIS component. What is tested here is the editor's
 * own job — the sections, the stimulus it appends, the fields each grading
 * mode owns, and where a validation issue lands.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CircuitEditor, type CircuitTryOutcome } from "./Editor.js";
import {
  emptyCircuitConfig,
  Stimulus,
  type CircuitConfig,
  type CircuitDetails,
  type SeriesSet,
  DEFAULT_BODE,
} from "./schema.js";

import { storedBeforeAc } from "./test/fixtures.js";

vi.mock("./canvas/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canvas/index.js")>();
  return {
    ...actual,
    SchematicEditor: ({ "aria-label": label }: { "aria-label"?: string }) => (
      <div data-testid="schematic-editor" aria-label={label} />
    ),
    Plot: ({ title }: { title?: string }) => <div data-testid="plot">{title}</div>,
  };
});

const series = (): SeriesSet => ({ t: [0, 1e-3], vin: [0, 1], vout: [0, 0.5], iout: [0, 0] });

function config(overrides: Partial<CircuitConfig> = {}): CircuitConfig {
  return { ...emptyCircuitConfig(), prompt: "Wire a low-pass filter.", ...overrides };
}

function setup(overrides: Partial<React.ComponentProps<typeof CircuitEditor>> = {}) {
  const onChange = vi.fn<(next: CircuitConfig) => void>();
  const value = overrides.config ?? config();
  render(
    <CircuitEditor
      config={value}
      onChange={onChange}
      uploadAsset={async () => "asset:none"}
      {...overrides}
    />,
  );
  return { config: value, onChange };
}

describe("CircuitEditor", () => {
  it("shows every section a question is authored in", () => {
    setup();
    for (const title of [
      "Question",
      "Palette",
      "Supplies",
      "Stimuli",
      "Reference circuit",
      "Grading",
      "Advanced options",
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Statement")).toHaveValue("Wire a low-pass filter.");
    expect(screen.getByLabelText("Reference circuit")).toBeInTheDocument();
  });

  it("offers the palette as chips, and toggling one patches only the palette", () => {
    const { config: value, onChange } = setup();
    const resistor = screen.getByLabelText("Resistor");
    expect(resistor).toBeChecked();
    fireEvent.click(resistor);
    const next = onChange.mock.calls[0]?.[0];
    expect(next?.palette.kinds).not.toContain("R");
    expect(next?.prompt).toBe(value.prompt);
  });

  it("appends a stimulus the schema accepts", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add a stimulus" }));
    const next = onChange.mock.calls[0]?.[0];
    expect(next?.stimuli).toHaveLength(1);
    expect(Stimulus.safeParse(next?.stimuli[0]).success).toBe(true);
  });

  it("shows a stimulus with its source, its load and its window", () => {
    setup({ config: config({ stimuli: [Stimulus.parse({ name: "1 kHz", source: { kind: "sine", amplitude: 1, frequencyHz: 1000 }, load: { kind: "open" } })] }) });
    expect(screen.getByLabelText("Name 1")).toHaveValue("1 kHz");
    expect(screen.getByLabelText("Sine")).toBeChecked();
    expect(screen.getByLabelText("Amplitude (V)")).toHaveValue(1);
    expect(screen.getByLabelText("Load")).toHaveValue("open");
    expect(screen.getByLabelText("Stop (ms)")).toHaveValue(5);
  });

  it("switches a stimulus to a Bode plot on a DC bias, and the schema accepts it", () => {
    const sine = Stimulus.parse({
      name: "1 kHz",
      source: { kind: "sine", amplitude: 1, frequencyHz: 1000 },
      load: { kind: "open" },
    });
    const { onChange } = setup({ config: config({ stimuli: [sine] }) });
    fireEvent.click(screen.getByLabelText("Bode plot"));
    const next = onChange.mock.calls[0]?.[0]?.stimuli[0];
    expect(next?.analysis.kind).toBe("ac");
    expect(next?.source).toEqual({ kind: "dc", volts: 0 });
    expect(Stimulus.safeParse(next).success).toBe(true);
  });

  it("shows an AC stimulus as a bias and a band, with the small-signal warning", () => {
    const ac = Stimulus.parse({
      name: "Bode",
      source: { kind: "dc", volts: 2.5 },
      load: { kind: "open" },
      analysis: { kind: "ac", fStartHz: 10, fStopHz: 1e5 },
    });
    setup({ config: config({ stimuli: [ac] }) });
    expect(screen.getByLabelText("Bias (V)")).toHaveValue(2.5);
    expect(screen.queryByLabelText("Sine")).not.toBeInTheDocument();
    expect(screen.getByLabelText("From (Hz)")).toHaveValue(10);
    expect(screen.getByLabelText("To (Hz)")).toHaveValue(1e5);
    expect(screen.getByLabelText("Points per decade")).toHaveValue(20);
    expect(screen.queryByLabelText("Stop (ms)")).not.toBeInTheDocument();
    expect(screen.getByText(/linearises the circuit around its DC bias/)).toBeInTheDocument();
  });

  it("gives the Bode envelope to a simulated question with an AC stimulus, and only then", () => {
    const ac = Stimulus.parse({
      name: "Bode",
      source: { kind: "dc", volts: 0 },
      load: { kind: "open" },
      analysis: { kind: "ac", fStartHz: 10, fStopHz: 1e5 },
    });
    const grading = { mode: "simulation" as const, tolerance: 0.05, bode: { ...DEFAULT_BODE }, rubric: "" };
    const { onChange } = setup({ config: config({ stimuli: [ac], grading }) });
    expect(screen.getByLabelText("Gain tolerance (dB)")).toHaveValue(1);
    expect(screen.getByLabelText("Floor (dB below the peak)")).toHaveValue(60);
    expect(screen.getByLabelText("Phase tolerance (°)")).toHaveValue(10);
    // Every stimulus is a sweep: the RMS tolerance has nothing to read.
    expect(screen.queryByLabelText("Tolerance")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Compare the phase"));
    expect(onChange.mock.calls[0]?.[0]?.grading.bode.phaseDeg).toBeNull();
  });

  it("opens a draft stored before the AC sweep, with no `kind` and no envelope", () => {
    const stored = storedBeforeAc();
    const { onChange } = setup({ config: stored });
    expect(screen.getAllByLabelText("Waveform")[0]).toBeChecked();
    expect(screen.getAllByLabelText("Stop (ms)")[0]).toHaveValue(5);
    fireEvent.click(screen.getAllByLabelText("Bode plot")[0] as HTMLElement);
    const next = onChange.mock.calls[0]?.[0];
    expect(next?.stimuli[0]?.analysis.kind).toBe("ac");
  });

  it("keeps the Bode envelope out of sight without an AC stimulus", () => {
    setup({ config: config({ grading: { mode: "simulation", tolerance: 0.05, bode: { ...DEFAULT_BODE }, rubric: "" } }) });
    expect(screen.queryByLabelText("Gain tolerance (dB)")).not.toBeInTheDocument();
  });

  it("gives the criteria to a hand-graded question, and no tolerance", () => {
    setup();
    expect(screen.getByLabelText("Criteria")).toBeInTheDocument();
    expect(screen.queryByLabelText("Tolerance")).not.toBeInTheDocument();
  });

  it("gives the tolerance to a simulated question, and no criteria", () => {
    setup({ config: config({ grading: { mode: "simulation", tolerance: 0.05, bode: { ...DEFAULT_BODE }, rubric: "" } }) });
    expect(screen.getByLabelText("Tolerance")).toBeInTheDocument();
    expect(screen.queryByLabelText("Criteria")).not.toBeInTheDocument();
  });

  it("switches the grading mode through the segmented control", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByLabelText("Simulation"));
    expect(onChange.mock.calls[0]?.[0].grading.mode).toBe("simulation");
  });

  it("places an issue beside the field it belongs to", () => {
    setup({ issues: [{ path: ["prompt"], message: "issue.circuit.prompt" }] });
    expect(screen.getByText("issue.circuit.prompt")).toBeInTheDocument();
  });

  it("refuses to simulate a reference that is not drawn yet", async () => {
    const onTry = vi.fn<(c: CircuitConfig) => Promise<CircuitTryOutcome>>();
    setup({ onTry });
    fireEvent.click(screen.getByRole("button", { name: "Simulate the reference" }));
    expect(await screen.findByText("Draw the reference circuit first.")).toBeInTheDocument();
    expect(onTry).not.toHaveBeenCalled();
  });

  it("says in one line that the runner is unavailable — D14, not an error", async () => {
    setup({
      config: config({
        reference: { components: [], wires: [] },
        stimuli: [Stimulus.parse({ name: "dc", source: { kind: "dc", volts: 1 }, load: { kind: "open" } })],
      }),
      onTry: async () => "unavailable" as const,
    });
    fireEvent.click(screen.getByRole("button", { name: "Simulate the reference" }));
    expect(
      await screen.findByText(
        "The runner is unavailable, so the reference cannot be simulated right now.",
      ),
    ).toBeInTheDocument();
  });

  it("blames the draft, not the wiring, when the stored draft does not validate", async () => {
    setup({
      config: config({
        reference: { components: [], wires: [] },
        stimuli: [Stimulus.parse({ name: "dc", source: { kind: "dc", volts: 1 }, load: { kind: "open" } })],
      }),
      onTry: async () => "invalid" as const,
    });
    fireEvent.click(screen.getByRole("button", { name: "Simulate the reference" }));
    expect(
      await screen.findByText("The question has errors, flagged on this page. Fix them, then simulate."),
    ).toBeInTheDocument();
  });

  it("plots one waveform per simulated stimulus", async () => {
    const details: CircuitDetails = {
      mode: "simulation",
      runner: "ok",
      netlist: { components: 2, nets: 3, issues: [] },
      stimuli: [
        { name: "low", visible: true, points: 1, ok: true, error: 0.01, series: series(), expected: null },
        { name: "high", visible: true, points: 1, ok: true, error: 0.02, series: series(), expected: null },
      ],
      earned: 2,
      total: 2,
    };
    setup({
      config: config({
        reference: { components: [], wires: [] },
        stimuli: [
          Stimulus.parse({ name: "low", source: { kind: "dc", volts: 1 }, load: { kind: "open" } }),
          Stimulus.parse({ name: "high", source: { kind: "dc", volts: 2 }, load: { kind: "open" } }),
        ],
      }),
      onTry: async () => ({ details }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Simulate the reference" }));
    expect(await screen.findByText("2 stimuli simulated.")).toBeInTheDocument();
    expect(screen.getAllByTestId("plot")).toHaveLength(2);
  });
});
