/**
 * The `logic` review and debrief key: a reference-keyed question shows its
 * reference circuit read-only where the expressions would be, and only
 * where the key may be shown (ADR-123, amendment of 2026-11-02).
 */
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { LogicKey } from "./LogicKey.js";
import { LogicReview } from "./LogicReview.js";
import type { LogicSolution, LogicStudent } from "./logicSchema.js";
import { halfAdderSchematic } from "./testing.js";

vi.mock("./canvas/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canvas/index.js")>();
  return {
    ...actual,
    SchematicView: ({ schematic }: { schematic: { components: { name: string }[] } }) => (
      <div data-testid="schematic-view">{schematic.components.map((c) => c.name).join(",")}</div>
    ),
  };
});

const student: LogicStudent = {
  prompt: "Build a half adder.",
  symbols: "iec",
  inputs: ["a", "b"],
  outputs: ["c", "s"],
  palette: { kinds: ["AND", "XOR"], maxGates: 4 },
};
const solution: LogicSolution = { outputs: [], reference: halfAdderSchematic(["Uref41", "Uref42"]) };

describe("the reference circuit as the key", () => {
  it("is drawn in the review under a shown key, and absent without one", () => {
    const props = { student, answer: null, details: null, points: null, maxPoints: 1 } as unknown as ComponentProps<typeof LogicReview>;
    const { unmount } = render(<LogicReview {...props} audience="student" solution={solution} />);
    expect(screen.getByText("Reference circuit")).toBeTruthy();
    expect(screen.getByTestId("schematic-view").textContent).toContain("Uref41");
    unmount();
    render(<LogicReview {...props} audience="student" solution={null} />);
    expect(screen.queryByText("Reference circuit")).toBeNull();
  });

  it("is drawn in the debrief key once revealed, hatched before", () => {
    const props = { student, solution, density: "page", stats: { distribution: [] }, prompt: null, rows: null, renderBlock: () => null } as unknown as ComponentProps<typeof LogicKey>;
    const { unmount } = render(<LogicKey {...props} revealed />);
    expect(screen.getByTestId("schematic-view").textContent).toContain("Uref42");
    unmount();
    render(<LogicKey {...props} revealed={false} />);
    expect(screen.queryByTestId("schematic-view")).toBeNull();
  });
});
