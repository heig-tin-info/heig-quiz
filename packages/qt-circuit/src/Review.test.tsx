/**
 * Review smoke tests.
 *
 * The one property worth a suite of its own is the AUDIENCE: the teacher's
 * reference and the names of the hidden stimuli are a key, and a student's
 * view of the same grading must not carry either (decision D15).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CircuitReview } from "./Review.js";
import type {
  CircuitDetails,
  CircuitSolution,
  CircuitStudent,
  Schematic,
  SeriesSet,
} from "./schema.js";

vi.mock("./canvas/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canvas/index.js")>();
  return {
    ...actual,
    SchematicView: ({ schematic }: { schematic: Schematic }) => (
      <div data-testid="schematic-view">{schematic.components.length}</div>
    ),
    Plot: ({ title }: { title?: string }) => <div data-testid="plot">{title}</div>,
  };
});

const series = (): SeriesSet => ({ t: [0, 1e-3], vin: [0, 1], vout: [0, 0.5], iout: [0, 0] });

const drawn: Schematic = {
  components: [{ id: "c1", kind: "R", x: 200, y: 200, m: [1, 0, 0, 1], name: "R1", value: "1.59k" }],
  wires: [],
};

const reference: Schematic = {
  components: [
    { id: "c1", kind: "R", x: 200, y: 200, m: [1, 0, 0, 1], name: "R1", value: "1.59k" },
    { id: "c2", kind: "C", x: 300, y: 200, m: [1, 0, 0, 1], name: "C1", value: "100n" },
  ],
  wires: [],
};

const student: CircuitStudent = {
  prompt: "Wire a low-pass filter.",
  palette: { kinds: ["R", "C", "GND"], maxComponents: 4 },
  supplies: { vcc: null, vee: null },
  commonGround: true,
  visibleStimuli: [],
  hiddenCount: 2,
  hiddenPoints: 2,
  canSimulate: false,
  showExpected: false,
  simulationsPerMinute: 10,
};

const solution: CircuitSolution = {
  reference,
  stimuli: [],
  grading: { mode: "simulation", tolerance: 0.05, rubric: "" },
};

const details: CircuitDetails = {
  mode: "simulation",
  runner: "ok",
  netlist: { components: 1, nets: 2, issues: ["floating_pin:R1.2"] },
  stimuli: [
    { name: "1 kHz", visible: true, points: 1, ok: true, error: 0.012, series: series(), expected: series() },
    { name: "the sneaky one", visible: false, points: 1, ok: false, error: 0.4, series: null, expected: null, reason: "spice_failed" },
  ],
  earned: 1,
  total: 2,
};

function setup(overrides: Partial<React.ComponentProps<typeof CircuitReview>> = {}) {
  render(
    <CircuitReview
      student={student}
      answer={{ schematic: drawn }}
      solution={solution}
      details={details}
      points={1}
      maxPoints={2}
      audience="teacher"
      {...overrides}
    />,
  );
}

describe("CircuitReview", () => {
  it("puts the reference beside the answer, for a teacher", () => {
    setup();
    const views = screen.getAllByTestId("schematic-view");
    expect(views).toHaveLength(2);
    expect(screen.getByText("Reference circuit")).toBeInTheDocument();
  });

  it("reads an ungraded answer as a dash, never as zero points", () => {
    setup({ points: null });
    expect(screen.getByText("— / 2 points")).toBeInTheDocument();
  });

  it("never shows the reference to a student", () => {
    setup({ audience: "student" });
    expect(screen.getAllByTestId("schematic-view")).toHaveLength(1);
    expect(screen.queryByText("Reference circuit")).not.toBeInTheDocument();
  });

  it("numbers a hidden stimulus for a student and names it for a teacher", () => {
    setup({ audience: "student" });
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.queryByText("the sneaky one")).not.toBeInTheDocument();
  });

  it("names a hidden stimulus for a teacher", () => {
    setup();
    expect(screen.getByText("the sneaky one")).toBeInTheDocument();
  });

  it("turns the stored diagnostics back into sentences", () => {
    setup();
    expect(screen.getByText("Components: 1 · Nets: 2")).toBeInTheDocument();
    expect(screen.getByText("R1.2 was not connected.")).toBeInTheDocument();
  });

  it("shows the score, the verdict, the error and the reason", () => {
    setup();
    expect(screen.getByText("1 / 2 points")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("1.2 %")).toBeInTheDocument();
    expect(screen.getByText("The simulator refused this circuit")).toBeInTheDocument();
  });

  it("plots the stimuli that produced a waveform, and only those", () => {
    setup();
    const plots = screen.getAllByTestId("plot");
    expect(plots).toHaveLength(1);
    expect(plots[0]).toHaveTextContent("1 kHz");
  });

  it("says in one line that the grade is the teacher's", () => {
    setup({
      details: { ...details, mode: "manual", runner: "none" },
    });
    expect(screen.getByText("This circuit is graded by the teacher.")).toBeInTheDocument();
  });

  it("says in one line that the simulator was unavailable", () => {
    setup({ details: { ...details, runner: "unavailable" } });
    expect(
      screen.getByText(
        "The simulator was unavailable; this answer is waiting for a manual grade.",
      ),
    ).toBeInTheDocument();
  });

  it("reads a grading-level marker without pretending it is a breakdown", () => {
    setup({ answer: null, details: null });
    expect(screen.getByText("Not answered.")).toBeInTheDocument();
    expect(screen.queryByTestId("schematic-view")).not.toBeInTheDocument();
  });
});
