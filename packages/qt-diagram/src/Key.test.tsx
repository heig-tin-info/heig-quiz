/**
 * The `diagram` answer key of the debrief (ADR-033, ADR-109): hidden, the
 * starter or a hatched block and nothing of the reference; revealed, the
 * reference — and never the grading criteria nor the text forms, at either
 * density.
 */
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { keyHostProps } from "@quiz/ui/testing";

import { diagramClient } from "./client.js";
import { DiagramKey } from "./Key.js";
import type { DiagramSolution, DiagramStudent } from "./schema.js";
import { diagramServer } from "./server.js";
import { SECRET_CONFIG } from "./testing.js";

const view = { seed: 0, itemId: "i", shuffle: false };
const STUDENT = diagramServer.toStudent(SECRET_CONFIG, view);
const SOLUTION = diagramServer.toSolution(SECRET_CONFIG, view);

/** What only the reference holds, its ids aside: the names and members a class could read. */
const REFERENCE_TEXT = ["SecretFigureRef", "SecretCircleRef", "secretOrigin", "secretArea", "secretRadius", "secretLinkName"];

const draw = ({
  revealed = true,
  density = "wall" as "wall" | "page",
  student = STUDENT as DiagramStudent,
  solution = SOLUTION as DiagramSolution | null,
  stats = {},
} = {}) =>
  render(
    <DiagramKey
      {...keyHostProps(stats)}
      density={density}
      student={student}
      solution={solution}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
    />,
  );

const leaks = (html: string) => REFERENCE_TEXT.filter((secret) => html.includes(secret));

describe("DiagramKey", () => {
  it.each(["wall", "page"] as const)("shows the starter while hidden, named as such, nothing of the reference (%s)", (density) => {
    const { container } = draw({ revealed: false, density });
    expect(screen.getByText("Starting diagram")).toBeVisible();
    expect(screen.getByRole("img", { name: "Starting diagram" })).toHaveTextContent("Shape");
    expect(leaks(container.innerHTML)).toEqual([]);
    // Nor its counts, which the review prints beside it.
    expect(container.textContent).not.toMatch(/element|link/);
  });

  it("keeps the frame hatched and empty when there is no starter", () => {
    const { container } = draw({ revealed: false, student: { ...STUDENT, starter: undefined } as DiagramStudent });
    expect(screen.getByText("Reference diagram, hidden until the answers are revealed")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    const frame = container.querySelector("figure")!.children[1]!;
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.textContent).toBe("");
    expect(leaks(container.innerHTML)).toEqual([]);
  });

  it.each(["wall", "page"] as const)("draws the reference once revealed, in the same frame (%s)", (density) => {
    const { container } = draw({ density });
    const diagram = screen.getByRole("img", { name: "Reference diagram" });
    expect(diagram).toHaveTextContent("SecretFigureRef");
    // At the height the frame gives it.
    expect(diagram.getAttribute("style")).toContain("max-height: 286px");
    expect(diagram.parentElement!.parentElement!.className).toContain(density === "wall" ? "h-[clamp(" : "h-80");
    expect(screen.getByText("the prompt").compareDocumentPosition(diagram) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Never the criteria, nor the text forms of the review (ADR-046 §4).
    expect(container.innerHTML).not.toContain("RUBRIC-SECRET");
    expect(screen.queryByText("Text form")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("draws the prompt alone without a key", () => {
    const { container } = draw({ solution: null });
    expect(container.textContent).toBe("the prompt");
  });

  it("lists answer groups only when there are some", () => {
    draw();
    expect(screen.queryByText("the rows")).toBeNull();
    draw({ stats: { distribution: [{ key: "a", label: "a", count: 1, correct: null, part: null }] } });
    expect(screen.getByText("the rows")).toBeVisible();
  });

  it("is the client's key, a chunk of its own", async () => {
    const Key = diagramClient.Key!;
    render(
      <Suspense fallback={<p>loading</p>}>
        <Key {...keyHostProps()} student={STUDENT} solution={SOLUTION} revealed />
      </Suspense>,
    );
    expect(await screen.findByRole("img", { name: "Reference diagram" })).toBeVisible();
  });

  it("takes the host's words, and the canvas's", () => {
    render(
      <DiagramKey
        {...keyHostProps()}
        student={STUDENT}
        solution={SOLUTION}
        revealed
        strings={{ reference: "Diagramme de référence" }}
        canvasStrings={{ empty: "Vide" }}
      />,
    );
    expect(screen.getByRole("img", { name: "Diagramme de référence" })).toBeVisible();
  });
});
