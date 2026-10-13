/**
 * The `circuit` answer key of the debrief (ADR-033, ADR-109): hidden, a
 * hatched block of the schematic's frame and nothing of the reference;
 * revealed, the reference schematic — and never the stimuli, the tolerance
 * nor the grading criteria, at either density.
 */
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { keyHostProps } from "@quiz/ui/testing";

import { FIT_ASPECT } from "./canvas/geometry.js";
import { circuitClient } from "./client.js";
import { CircuitKey } from "./Key.js";
import type { CircuitSolution } from "./schema.js";
import { circuitServer } from "./server.js";
import { circuitConfig, SECRET_HIDDEN_STIMULUS, SECRET_REFERENCE_NAME, SECRET_RUBRIC } from "./testing.js";

const view = { seed: 0, itemId: "i", shuffle: false };
const CONFIG = circuitConfig();
const STUDENT = circuitServer.toStudent(CONFIG, view);
const SOLUTION = circuitServer.toSolution(CONFIG, view) as CircuitSolution;

/** What only the reference holds: its parts' names and values. */
const REFERENCE_TEXT = [SECRET_REFERENCE_NAME, "123.4k", "Csecret", "100n"];

const draw = ({
  revealed = true,
  density = "wall" as "wall" | "page",
  solution = SOLUTION as CircuitSolution | null,
  stats = {},
} = {}) =>
  render(
    <CircuitKey
      {...keyHostProps(stats)}
      density={density}
      student={STUDENT}
      solution={solution}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
    />,
  );

const leaks = (html: string) => REFERENCE_TEXT.filter((secret) => html.includes(secret));

describe("CircuitKey", () => {
  it.each(["wall", "page"] as const)("keeps its frame hatched and empty while hidden (%s)", (density) => {
    const { container } = draw({ revealed: false, density });
    expect(screen.getByText("Reference circuit, hidden until the answers are revealed")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    const frame = container.querySelector("figure")!.children[1]!;
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.textContent).toBe("");
    expect(leaks(container.innerHTML)).toEqual([]);
  });

  it.each(["wall", "page"] as const)("draws the reference once revealed, at the height its frame gives (%s)", (density) => {
    const { container } = draw({ density });
    const schematic = screen.getByRole("img", { name: "Reference circuit" });
    expect(schematic).toHaveTextContent(SECRET_REFERENCE_NAME);
    expect(schematic.style.maxHeight).toBe("286px");
    expect(schematic.style.maxWidth).toBe(`${Math.round(286 * FIT_ASPECT)}px`);
    expect(screen.getByText("the prompt").compareDocumentPosition(schematic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The rest of the key is the grader's.
    expect(container.innerHTML).not.toContain(SECRET_RUBRIC);
    expect(container.innerHTML).not.toContain(SECRET_HIDDEN_STIMULUS);
  });

  it("draws the prompt alone for a circuit with no reference", () => {
    const { container } = draw({ solution: { reference: null } });
    expect(container.textContent).toBe("the prompt");
    draw({ solution: null, revealed: false });
    expect(screen.getAllByText("the prompt")).toHaveLength(2);
    expect(screen.queryByText(/hidden until/)).toBeNull();
  });

  it("lists answer groups only when there are some", () => {
    draw();
    expect(screen.queryByText("the rows")).toBeNull();
    draw({ stats: { distribution: [{ key: "a", label: "a", count: 1, correct: null, part: null }] } });
    expect(screen.getByText("the rows")).toBeVisible();
  });

  it("is the client's key, a chunk of its own", async () => {
    const Key = circuitClient.Key!;
    render(
      <Suspense fallback={<p>loading</p>}>
        <Key {...keyHostProps()} student={STUDENT} solution={SOLUTION} revealed />
      </Suspense>,
    );
    expect(await screen.findByRole("img", { name: "Reference circuit" })).toBeVisible();
  });

  it("takes the host's words, and the canvas's", () => {
    render(
      <CircuitKey
        {...keyHostProps()}
        student={STUDENT}
        solution={SOLUTION}
        revealed
        strings={{ reference: "Circuit de référence" }}
        canvasStrings={{ viewLabel: "Schéma" }}
      />,
    );
    expect(screen.getByRole("img", { name: "Circuit de référence" })).toBeVisible();
  });
});
