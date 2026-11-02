/**
 * The `logic` player: the declared terminals are on the canvas from the
 * start, and play mode lights the student's own outputs from the student's
 * own circuit, in the browser, never against an expected value (ADR-123 §7).
 * The editor is stubbed for the reason `Player.test.tsx` stubs it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LogicPlayer, playCircuit } from "./LogicPlayer.js";
import type { LogicAnswer, LogicComponent, LogicStudent } from "./logicSchema.js";
import { logicWire } from "./testing.js";

vi.mock("./canvas/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canvas/index.js")>();
  return {
    ...actual,
    SchematicEditor: ({ value }: { value: { components: { name: string }[] } }) => (
      <div data-testid="schematic-editor">{value.components.map((c) => c.name).join(",")}</div>
    ),
  };
});

const student: LogicStudent = {
  prompt: "Build an AND.",
  symbols: "ansi",
  inputs: ["a", "b"],
  outputs: ["y"],
  palette: { kinds: ["AND"], maxGates: 2 },
};

const part = (id: string, kind: LogicComponent["kind"], x: number, y: number, name: string): LogicComponent => ({
  id,
  kind,
  x,
  y,
  m: [1, 0, 0, 1],
  name,
  value: "",
});

function andAnswer(): LogicAnswer {
  const a = part("c1", "IN", 100, 100, "a");
  const b = part("c2", "IN", 100, 300, "b");
  const and = part("c3", "AND2", 300, 200, "U1");
  const y = part("c4", "OUT", 500, 200, "y");
  return {
    schematic: {
      components: [a, b, and, y],
      wires: [logicWire("w1", [a, 0], [and, 0]), logicWire("w2", [b, 0], [and, 1]), logicWire("w3", [and, 2], [y, 0])],
    },
  };
}

describe("LogicPlayer", () => {
  it("opens on the declared terminals when nothing is saved yet", () => {
    render(<LogicPlayer student={student} answer={null} onChange={() => {}} readOnly={false} />);
    expect(screen.getByTestId("schematic-editor").textContent).toBe("a,b,y");
  });

  it("plays the student's circuit: the inputs switch, the output follows", () => {
    render(<LogicPlayer student={student} answer={andAnswer()} onChange={() => {}} readOnly={false} />);
    fireEvent.click(screen.getByRole("radio", { name: "Play" }));
    expect(screen.queryByTestId("schematic-editor")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("y = 0");
    fireEvent.click(screen.getByRole("button", { name: "a = 0" }));
    fireEvent.click(screen.getByRole("button", { name: "b = 0" }));
    expect(screen.getByRole("button", { name: "a = 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("y = 1");
  });

  it("colours a wire by its level, and reads an undriven output as Z", () => {
    const answer = andAnswer();
    expect(playCircuit(answer.schematic, { a: 1, b: 1 })?.wireLevel("w3")).toBe(1);
    const open = { ...answer.schematic, wires: answer.schematic.wires.filter((w) => w.id !== "w3") };
    expect(playCircuit(open, { a: 1, b: 1 })?.outputs["y"]).toBe("Z");
  });
});
