/**
 * The `logic` editor: the inputs one per line, each with its own named bin;
 * the expected answer from the expressions or from the reference circuit;
 * in sequential mode "Use as reference" writes the vectors' outputs. The
 * canvas is stubbed for the reason `Player.test.tsx` stubs it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LogicEditor } from "./LogicEditor.js";
import type { LogicConfig } from "./logicSchema.js";
import { halfAdderSchematic, logicPart, logicReferenceConfig, logicSequentialConfig, logicWire } from "./testing.js";

vi.mock("./canvas/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canvas/index.js")>();
  return {
    ...actual,
    SchematicEditor: ({ value }: { value: { components: { name: string }[] } }) => (
      <div data-testid="schematic-editor">{value.components.map((c) => c.name).join(",")}</div>
    ),
  };
});

function edit(config: LogicConfig) {
  const onChange = vi.fn<(next: LogicConfig) => void>();
  render(<LogicEditor config={config} onChange={onChange} />);
  return onChange;
}

describe("LogicEditor", () => {
  it("lists the inputs one per line, each removed by its own named button, the reference following", () => {
    const onChange = edit(logicReferenceConfig());
    const list = screen.getByRole("textbox", { name: "Input 1" }).closest("ul")!;
    expect(list.querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove b" }));
    const next = onChange.mock.calls[0]![0];
    expect(next.inputs).toEqual(["a"]);
    expect(next.reference?.components.map((c) => c.name)).not.toContain("b");
  });

  it("hides the expressions and shows the reference canvas when the reference is the expected answer", () => {
    edit(logicReferenceConfig());
    expect(screen.queryByRole("textbox", { name: "Expression of c" })).toBeNull();
    expect(screen.getByTestId("schematic-editor").textContent).toBe("a,b,Uref41,Uref42,c,s");
  });

  it("says on which row a reference reads X", () => {
    const open = halfAdderSchematic();
    open.wires = open.wires.filter((w) => w.id !== "w3");
    edit({ ...logicReferenceConfig(), reference: open });
    expect(screen.getByText("The reference reads X or Z for a = 1, b = 0.")).toBeTruthy();
  });

  it("fills the vectors' outputs from the reference on Use as reference", () => {
    const clk = logicPart("c1", "IN", 100, 300, "clk");
    const d = logicPart("c2", "IN", 100, 100, "d");
    const ff = logicPart("c3", "DFF", 300, 200, "U1");
    const q = logicPart("c4", "OUT", 500, 180, "q");
    const reference = {
      components: [clk, d, ff, q],
      wires: [logicWire("w1", [d, 0], [ff, 0]), logicWire("w2", [clk, 0], [ff, 1]), logicWire("w3", [ff, 2], [q, 0])],
    };
    const onChange = edit({ ...logicSequentialConfig({ reference }), vectors: "clk d\nC 1\nC 0" });
    fireEvent.click(screen.getByRole("button", { name: "Use as reference" }));
    expect(onChange.mock.calls[0]![0].vectors).toBe("clk d q\nC   1 1\nC   0 0");
  });
});
