/**
 * The `blocks` answer key of the debrief (ADR-033, ADR-109, spec 4.17):
 * hidden, the starter beside the host's bars and the visible warehouses;
 * revealed, the reference in their place — as text on the wall, as the
 * read-only workspace on the page — and never a hidden warehouse.
 */
import { render, screen, within } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { keyHostProps } from "@quiz/ui/testing";

import { blocksClient } from "./client.js";
import { BlocksKey } from "./Key.js";
import { pseudoCode } from "./pseudo.js";
import type { BlocksSolution, BlocksStudent } from "./schema.js";
import { blocksServer } from "./server.js";
import { blocksCanvasStrings } from "./strings.js";
import { SECRET_CONFIG } from "./testing.js";

const view = { seed: 0, itemId: "i", shuffle: false };
const STUDENT = blocksServer.toStudent(SECRET_CONFIG, view);
const SOLUTION = blocksServer.toSolution(SECRET_CONFIG, view) as BlocksSolution;
const REFERENCE = pseudoCode(SECRET_CONFIG.referenceSolution!, blocksCanvasStrings);
const STARTER = pseudoCode(SECRET_CONFIG.starter, blocksCanvasStrings);

/** What only the reference and the hidden warehouses hold. */
const SECRETS = ["repeat until the dock", "if free ahead", "Hidden north-east", "Trapped corridor"];

const draw = ({
  revealed = true,
  density = "wall" as "wall" | "page",
  student = STUDENT as BlocksStudent,
  solution = SOLUTION as BlocksSolution | null,
  cases = <ul aria-label="the cases" /> as ReactNode,
  stats = {},
} = {}) =>
  render(
    <BlocksKey
      {...keyHostProps(stats)}
      density={density}
      student={student}
      solution={solution}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
      cases={cases}
    />,
  );

const leaks = (html: string) => SECRETS.filter((secret) => html.includes(secret));

describe("BlocksKey", () => {
  it("shows the starter on the wall while hidden, named as such, nothing of the reference", () => {
    const { container } = draw({ revealed: false });
    const program = screen.getByRole("region", { name: "Starting program" });
    expect(program.textContent).toBe(STARTER);
    expect(program.parentElement!.className).toContain("bg-surface-2");
    expect(leaks(container.innerHTML)).toEqual([]);
  });

  it("keeps its frame hatched and empty when there is no starter", () => {
    const { container } = draw({ revealed: false, student: { ...STUDENT, starter: [] } });
    expect(screen.getByText("Reference solution, hidden until the answers are revealed")).toBeVisible();
    expect(screen.queryByRole("region")).toBeNull();
    const frame = container.querySelector("figure")!.children[1]!;
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.textContent).toBe("");
    expect(leaks(container.innerHTML)).toEqual([]);
  });

  it("puts the reference in its place on the wall once revealed, as text filling the frame", () => {
    draw();
    const program = screen.getByRole("region", { name: "Reference solution" });
    expect(program.textContent).toBe(REFERENCE);
    expect(program.className).toContain("h-full");
    expect(program.parentElement!.className).toContain("h-[clamp(");
    // Never a workspace on the wall: it would take the stepper's keys.
    expect(screen.queryByTestId("blockly-host")).toBeNull();
  });

  it("draws the reference as the read-only workspace on the page", () => {
    draw({ density: "page" });
    // jsdom has no Blockly: the workspace's own fallback, the program as text.
    expect(screen.getByLabelText("Reference solution")).toHaveTextContent("repeat until the dock");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it.each([true, false])("draws the visible warehouses beside the cases, never a hidden one (revealed: %s)", (revealed) => {
    const { container } = draw({ revealed });
    const cases = screen.getByRole("list", { name: "the cases" });
    const maps = screen.getByRole("list", { name: "Warehouses" });
    expect(cases.parentElement).toBe(maps.parentElement);
    expect(within(maps).getAllByRole("img").map((img) => img.getAttribute("aria-label"))).toEqual([
      "Plan of the warehouse Clear aisle",
      "Plan of the warehouse Rack on the aisle",
    ]);
    expect(container.innerHTML).not.toContain("Hidden north-east");
    expect(container.innerHTML).not.toContain("Trapped corridor");
  });

  it("sets the program and the cases in the program's two columns, the rows under them", () => {
    draw({ stats: { distribution: [{ key: "a", label: "a", count: 1, correct: null, part: null }] } });
    const program = screen.getByRole("region", { name: "Reference solution" });
    const cases = screen.getByRole("list", { name: "the cases" });
    expect(program.closest("figure")!.parentElement).toBe(cases.parentElement!.parentElement);
    const rows = screen.getByText("the rows");
    expect(cases.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws the cases alone without a reference, and nothing but the prompt with neither", () => {
    draw({ solution: { referenceSolution: null, cases: [] } });
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("list", { name: "the cases" })).toBeInTheDocument();

    const { container } = draw({ solution: null, cases: null, student: { ...STUDENT, visibleCases: [] } });
    expect(container.textContent).toBe("the prompt");
  });

  it("is the client's key, a chunk of its own", async () => {
    const Key = blocksClient.Key!;
    render(
      <Suspense fallback={<p>loading</p>}>
        <Key {...keyHostProps()} density="wall" student={STUDENT} solution={SOLUTION} revealed />
      </Suspense>,
    );
    expect(await screen.findByRole("region", { name: "Reference solution" })).toBeVisible();
  });

  it("takes the host's words, and the canvas's", () => {
    render(
      <BlocksKey
        {...keyHostProps()}
        density="wall"
        student={STUDENT}
        solution={SOLUTION}
        revealed
        strings={{ reference: "Solution de référence" }}
        canvasStrings={{ forward: "avancer", cases: "Entrepôts" }}
      />,
    );
    expect(screen.getByRole("region", { name: "Solution de référence" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Entrepôts" })).toBeVisible();
  });
});
