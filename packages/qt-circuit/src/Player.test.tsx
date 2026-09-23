/**
 * Player smoke tests.
 *
 * Two properties matter here and are checked directly: "Simulate" exists
 * only when the question HAS something to simulate and the host can serve it,
 * and it degrades to one readable line when the runner is unavailable — which
 * is the DEFAULT configuration of the platform (decision D14), not an edge
 * case. The canvas is stubbed for the reason `Editor.test.tsx` stubs it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CircuitPlayer, type CircuitSimulateOutcome } from "./Player.js";
import type { CircuitAnswer, CircuitStudent, Schematic } from "./schema.js";

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

/** One ngspice table, in the shape `parseSimulation` reads. */
const TABLE = [
  " time            v(in)           v(out)          i(Vmeas)       ",
  " 0.00000000e+00  0.00000000e+00  0.00000000e+00  0.00000000e+00 ",
  " 1.00000000e-05  6.27763719e-02  2.10456606e-03  2.10456606e-09 ",
  " 2.00000000e-05  1.25280781e-01  7.88837779e-03  7.88837779e-09 ",
].join("\n");

const runCase = (stdout: string) => ({
  exitCode: 0,
  stdout,
  stderr: "",
  ms: 12,
  timedOut: false,
  oom: false,
  truncated: false,
});

const outcome = (n: number): CircuitSimulateOutcome => ({
  compile: { ok: true, stdout: "", stderr: "", ms: 0 },
  cases: Array.from({ length: n }, () => runCase(TABLE)),
});

function student(overrides: Partial<CircuitStudent> = {}): CircuitStudent {
  return {
    prompt: "Wire a low-pass filter.",
    palette: { kinds: ["R", "C", "GND"], maxComponents: 4 },
    supplies: { vcc: null, vee: null },
    commonGround: true,
    visibleStimuli: [
      {
        name: "1 kHz",
        source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
        sourceOhms: 0,
        load: { kind: "resistor", ohms: 10_000 },
        analysis: { stopMs: 5, skipMs: 0, points: 500 },
        points: 1,
      },
    ],
    hiddenCount: 2,
    hiddenPoints: 3,
    canSimulate: true,
    showExpected: false,
    simulationsPerMinute: 10,
    ...overrides,
  };
}

const drawn: Schematic = {
  components: [{ id: "c1", kind: "R", x: 200, y: 200, m: [1, 0, 0, 1], name: "R1", value: "1.59k" }],
  wires: [],
};

function setup(overrides: Partial<React.ComponentProps<typeof CircuitPlayer>> = {}) {
  const onChange = vi.fn<(next: CircuitAnswer) => void>();
  render(
    <CircuitPlayer
      student={student()}
      answer={{ schematic: drawn }}
      onChange={onChange}
      readOnly={false}
      {...overrides}
    />,
  );
  return { onChange };
}

describe("CircuitPlayer", () => {
  it("shows the prompt, the canvas and the stimulus in one line", () => {
    setup();
    expect(screen.getByText("Wire a low-pass filter.")).toBeInTheDocument();
    expect(screen.getByLabelText("Your circuit")).toBeInTheDocument();
    expect(screen.getByText("1 kHz")).toBeInTheDocument();
    expect(screen.getByText("Sine 1 V @ 1kHz · load 10kΩ · 5 ms")).toBeInTheDocument();
  });

  it("counts the components and names what is still floating", () => {
    setup();
    expect(screen.getByText("1 / 4 components")).toBeInTheDocument();
    // A lone resistor has both of its pins in the air, and the strip says so
    // rather than waiting for a button to be pressed.
    expect(screen.getByText("R1.1 is not connected.")).toBeInTheDocument();
    expect(screen.getByText("R1.2 is not connected.")).toBeInTheDocument();
  });

  it("says how many hidden stimuli there are and what they are worth", () => {
    setup();
    expect(screen.getByText("2 hidden stimuli, worth 3 point(s) in total.")).toBeInTheDocument();
  });

  it("honours `disabled` exactly as `readOnly`, like every other player", () => {
    setup({ disabled: true, onSimulate: async () => outcome(1) });
    // The canvas is stubbed here; the button is what a locked answer shows.
    expect(screen.getByRole("button", { name: "Simulate" })).toBeDisabled();
  });

  it("offers Simulate only when the host can serve it", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Simulate" })).not.toBeInTheDocument();
  });

  it("offers Simulate only when the question has a visible stimulus", () => {
    setup({
      student: student({ visibleStimuli: [], canSimulate: false }),
      onSimulate: async () => outcome(0),
    });
    expect(screen.queryByRole("button", { name: "Simulate" })).not.toBeInTheDocument();
    expect(screen.getByText("Your teacher did not publish any stimulus.")).toBeInTheDocument();
  });

  it("degrades to one calm line when the runner is unavailable (D14)", async () => {
    setup({ onSimulate: async () => "unavailable" as const });
    fireEvent.click(screen.getByRole("button", { name: "Simulate" }));
    expect(
      await screen.findByText(
        "Simulation is unavailable right now. Your circuit is saved and will still be graded.",
      ),
    ).toBeInTheDocument();
  });

  it("says so when the budget is spent, and never in red", async () => {
    setup({ onSimulate: async () => "rate_limited" as const });
    fireEvent.click(screen.getByRole("button", { name: "Simulate" }));
    expect(
      await screen.findByText("Too many simulations in a row. Wait a moment and try again."),
    ).toBeInTheDocument();
  });

  it("plots one waveform per visible stimulus once a run is done", async () => {
    setup({
      student: student({
        visibleStimuli: [
          {
            name: "1 kHz",
            source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
            sourceOhms: 0,
            load: { kind: "open" },
            analysis: { stopMs: 5, skipMs: 0, points: 500 },
            points: 1,
          },
          {
            name: "10 kHz",
            source: { kind: "sine", amplitude: 1, frequencyHz: 10_000, offset: 0 },
            sourceOhms: 0,
            load: { kind: "open" },
            analysis: { stopMs: 5, skipMs: 0, points: 500 },
            points: 1,
          },
        ],
      }),
      onSimulate: async () => outcome(2),
    });
    fireEvent.click(screen.getByRole("button", { name: "Simulate" }));
    const plots = await screen.findAllByTestId("plot");
    expect(plots).toHaveLength(2);
    expect(plots[0]).toHaveTextContent("Output — 1 kHz");
  });

  it("sends the schematic and nothing about the simulation back as the answer", () => {
    const { onChange } = setup();
    // The canvas is stubbed here, so the contract is asserted on the type:
    // the answer this player ever builds holds `schematic` and nothing else.
    expect(onChange).not.toHaveBeenCalled();
    expect(Object.keys({ schematic: drawn } satisfies CircuitAnswer)).toEqual(["schematic"]);
  });
});
