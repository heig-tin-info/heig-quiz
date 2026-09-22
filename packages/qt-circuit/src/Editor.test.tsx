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
} from "./schema.js";

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

  it("gives the criteria to a hand-graded question, and no tolerance", () => {
    setup();
    expect(screen.getByLabelText("Criteria")).toBeInTheDocument();
    expect(screen.queryByLabelText("Tolerance")).not.toBeInTheDocument();
  });

  it("gives the tolerance to a simulated question, and no criteria", () => {
    setup({ config: config({ grading: { mode: "simulation", tolerance: 0.05, rubric: "" } }) });
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
