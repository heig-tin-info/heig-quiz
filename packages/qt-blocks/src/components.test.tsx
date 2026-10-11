/**
 * The three surfaces and the grading column, on the text fallback (ADR-103
 * §12): jsdom has no SVG geometry for Blockly, so `blockly={false}` is what
 * every test here drives — the program shown as text, the simulation, the
 * tables and the editor's own controls are the same either way.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { testGradeContext } from "@quiz/core/testing";

import { BlocksEditor } from "./Editor.js";
import { blocksGrading } from "./grading.js";
import { BlocksPlayer } from "./Player.js";
import { BlocksReview } from "./Review.js";
import type { BlocksConfig, BlocksDetails } from "./schema.js";
import { blocksServer } from "./server.js";
import { SECRET_CONFIG } from "./testing.js";

const view = { seed: 0, itemId: "i", shuffle: false };
const student = blocksServer.toStudent(SECRET_CONFIG, view);
const REFERENCE = SECRET_CONFIG.referenceSolution!;

function detailsOf(program = REFERENCE): BlocksDetails {
  const result = blocksServer.grade(SECRET_CONFIG, { program }, testGradeContext(7));
  if (result instanceof Promise || result.kind !== "graded") throw new Error("expected a grade");
  return result.details;
}

describe("BlocksPlayer", () => {
  it("shows the starter as text, with the line that says why there are no blocks", () => {
    render(<BlocksPlayer student={student} answer={null} onChange={() => {}} readOnly={false} blockly={false} />);
    expect(screen.getByText("Bring the robot to the dock without hitting a rack.")).toBeVisible();
    expect(screen.getByLabelText("Program")).toHaveTextContent("repeat 7 times");
    expect(screen.getByText(/The block editor did not load/)).toBeVisible();
    expect(screen.getByText("Unchanged starter: not an answer yet. · 2 blocks")).toBeVisible();
  });

  it("tests the visible warehouses only, in the browser, and fills the table", async () => {
    render(<BlocksPlayer student={student} answer={{ program: REFERENCE }} onChange={() => {}} readOnly={false} blockly={false} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("Not run")).toHaveLength(2);
    // A program that is not the starter is an answer: no "unchanged" caption.
    expect(screen.getByText("4 blocks")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Test on every warehouse" }));
    expect(within(table).getAllByText("Dock reached")).toHaveLength(2);
    expect(within(table).getByText("7 moves")).toBeVisible();
    expect(screen.getByText("2 / 2 warehouses")).toBeVisible();
    // The hidden warehouses are a count and their points, never a row.
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("2 hidden warehouses, worth 5 points in total, are tested at grading only.")).toBeVisible();
  });

  it("makes the test button a secondary where the host has its own primary", () => {
    render(<BlocksPlayer student={student} answer={null} onChange={() => {}} readOnly={false} blockly={false} testsPrimary={false} />);
    expect(screen.getByRole("button", { name: "Test on every warehouse" }).className).not.toContain("bg-accent");
  });

  it("steps the robot through its run, spending the battery, and resets", async () => {
    render(<BlocksPlayer student={student} answer={{ program: REFERENCE }} onChange={() => {}} readOnly={false} blockly={false} />);
    const meter = screen.getByRole("meter", { name: "Battery" });
    expect(meter).toHaveAttribute("aria-valuenow", "40");
    await userEvent.click(screen.getByRole("button", { name: "Step" }));
    expect(meter).toHaveAttribute("aria-valuenow", "39");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(meter).toHaveAttribute("aria-valuenow", "40");
  });

  it("runs the selected warehouse to its end and says how it ended", () => {
    vi.useFakeTimers();
    try {
      render(<BlocksPlayer student={student} answer={{ program: REFERENCE }} onChange={() => {}} readOnly={false} blockly={false} />);
      fireEvent.click(screen.getByRole("button", { name: /Rack on the aisle/ }));
      expect(screen.getByText("Case 2 · Rack on the aisle")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Run here" }));
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByRole("status")).toHaveTextContent("Dock reached · 13 moves");
      expect(screen.getByRole("meter", { name: "Battery" })).toHaveAttribute("aria-valuenow", "27");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when every warehouse is hidden, and offers no test", () => {
    const hidden = blocksServer.toStudent({ ...SECRET_CONFIG, cases: SECRET_CONFIG.cases.map((c) => ({ ...c, visible: false })) }, view);
    render(<BlocksPlayer student={hidden} answer={null} onChange={() => {}} readOnly={false} blockly={false} />);
    expect(screen.getByText("Every warehouse is hidden: your program is tested at grading only.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Test on every warehouse" })).toBeNull();
  });

  it("takes the host's words", () => {
    render(
      <BlocksPlayer
        student={student}
        answer={null}
        onChange={() => {}}
        readOnly
        blockly={false}
        strings={{ testAll: "Tester sur tous les entrepôts" }}
        canvasStrings={{ repeat: "répéter {n} fois", workspace: "Programme" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Tester sur tous les entrepôts" })).toBeVisible();
    expect(screen.getByLabelText("Programme")).toHaveTextContent("répéter 7 fois");
  });
});

describe("BlocksEditor", () => {
  const draft = (patch: Partial<BlocksConfig> = {}): BlocksConfig => ({ ...SECRET_CONFIG, ...patch });

  it("offers the toolbox as checkboxes, kept in the kinds' order", async () => {
    const onChange = vi.fn();
    render(<BlocksEditor config={draft({ toolbox: ["turn", "forward"] })} onChange={onChange} blockly={false} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Repeat n times" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ toolbox: ["forward", "turn", "repeat"] }));
  });

  it("checks the reference on every warehouse, hidden ones included", async () => {
    const seven = [{ kind: "repeat", times: 7, body: [{ kind: "forward" }] }] as BlocksConfig["starter"];
    render(<BlocksEditor config={draft({ referenceSolution: seven })} onChange={() => {}} blockly={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Check the reference" }));
    expect(screen.getByText("The reference misses 3 warehouses.")).toBeVisible();
    expect(screen.getByText("Trapped corridor")).toBeVisible();
    expect(screen.getAllByText("Collision")).toHaveLength(3);
  });

  it("says the reference reaches every dock, and waits for one to exist", async () => {
    const { rerender } = render(<BlocksEditor config={draft()} onChange={() => {}} blockly={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Check the reference" }));
    expect(screen.getByText("The reference reaches the dock in every warehouse.")).toBeVisible();
    rerender(<BlocksEditor config={draft({ referenceSolution: null })} onChange={() => {}} blockly={false} />);
    expect(screen.getByRole("button", { name: "Check the reference" })).toBeDisabled();
    expect(screen.getByText("Assemble the reference first.")).toBeVisible();
  });

  it("edits a warehouse on its grid, and adds one", async () => {
    const onChange = vi.fn();
    render(<BlocksEditor config={draft()} onChange={onChange} blockly={false} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Column 1, row 1: floor" })[0]!);
    expect(onChange.mock.calls.at(-1)![0].cases[0].map[0]).toBe("#.#..#..");
    await userEvent.click(screen.getByRole("button", { name: "Add a warehouse" }));
    expect(onChange.mock.calls.at(-1)![0].cases).toHaveLength(5);
  });

  it("places an issue under the warehouse it names, and the scoring switch", async () => {
    const onChange = vi.fn();
    render(
      <BlocksEditor
        config={draft()}
        onChange={onChange}
        blockly={false}
        issues={[{ path: ["cases", 2], message: "The reference does not reach the dock here." }]}
      />,
    );
    expect(screen.getByText("The reference does not reach the dock here.")).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: "All or nothing" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ allOrNothing: true }));
  });
});

describe("BlocksReview", () => {
  const base = { student, points: 5, maxPoints: 7, audience: "student" as const, blockly: false };

  it("shows a student their program and the hidden warehouses by verdict only", () => {
    const details = blocksServer.studentDetails!(detailsOf(), { showKey: false, showHiddenCaseNames: false }) as BlocksDetails;
    render(<BlocksReview {...base} answer={{ program: REFERENCE }} solution={null} details={details} />);
    expect(screen.getByLabelText("Program")).toHaveTextContent("repeat until the dock");
    const table = screen.getByRole("table");
    expect(within(table).getByText("#3")).toBeVisible();
    expect(within(table).queryByText("Hidden north-east")).toBeNull();
    expect(screen.getByText("A hidden warehouse shows its verdict only.")).toBeVisible();
    expect(screen.getByRole("img", { name: /Plan of the warehouse Clear aisle/ })).toBeVisible();
    expect(screen.queryByText("Reference solution")).toBeNull();
  });

  it("shows the teacher the hidden maps and the reference, from the key", async () => {
    const solution = blocksServer.toSolution(SECRET_CONFIG, view);
    render(<BlocksReview {...base} audience="teacher" answer={{ program: REFERENCE }} solution={solution} details={detailsOf()} />);
    await userEvent.click(screen.getByRole("button", { name: /Trapped corridor/ }));
    expect(screen.getByRole("img", { name: /Plan of the warehouse Trapped corridor/ })).toBeVisible();
    expect(screen.getByLabelText("Reference solution")).toHaveTextContent("if free ahead");
  });

  it("says when there is no answer, and leaves the reference out when asked to", () => {
    const solution = blocksServer.toSolution(SECRET_CONFIG, view);
    render(<BlocksReview {...base} answer={null} solution={solution} details={null} sections={{ solution: false }} />);
    expect(screen.getByText("No answer")).toBeVisible();
    expect(screen.queryByText("Reference solution")).toBeNull();
    expect(within(screen.getByRole("table")).getAllByText("Not run")).toHaveLength(2);
  });
});

describe("the grading column", () => {
  const solution = blocksServer.toSolution(SECRET_CONFIG, view);
  const [column] = blocksGrading.columns(student, solution);

  it("shows the program as text after the docks it reached", () => {
    const seven = [{ kind: "repeat", times: 7, body: [{ kind: "forward" }] }] as BlocksConfig["starter"];
    render(<div>{column!.cell({ answer: { program: seven }, details: detailsOf(seven) })}</div>);
    expect(screen.getByText("1/4 docks")).toBeVisible();
    expect(screen.getByText(/repeat 7 times/)).toBeVisible();
  });

  it("holds the reference in the expected row, and sorts by the program", () => {
    render(<div>{column!.expected()}</div>);
    expect(screen.getByText(/repeat until the dock/)).toBeVisible();
    expect(column!.sortKey({ program: [{ kind: "forward" }] })).toBe("move forward");
    expect(column!.sortKey(null)).toBe("");
  });

  it("takes the host's words for the program too", () => {
    const [french] = blocksGrading.columns(student, solution, { forward: "avancer", workspace: "Programme" });
    expect(french!.label).toBe("Programme");
    render(<div>{french!.cell({ answer: { program: [{ kind: "forward" }] }, details: null })}</div>);
    expect(screen.getByText("avancer")).toBeVisible();
  });
});
