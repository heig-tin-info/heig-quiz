import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { EXAMPLES } from "../examples.js";
import type { DiagramKind } from "../kinds.js";
import { emptyScene, type Scene } from "../scene.js";
import { DiagramEditor } from "./DiagramEditor.js";
import { DiagramView } from "./DiagramView.js";

/** A host that owns the scene, as the question type will. */
function Host({ kind, initial, onChange, withText = false }: { kind: DiagramKind; initial: Scene; onChange?: (s: Scene) => void; withText?: boolean }) {
  const [scene, setScene] = useState(initial);
  return (
    <DiagramEditor
      kind={kind}
      value={scene}
      height={400}
      withText={withText}
      onChange={(next) => {
        setScene(next);
        onChange?.(next);
      }}
    />
  );
}

const canvas = (): SVGSVGElement => screen.getAllByRole("img")[0] as unknown as SVGSVGElement;
const click = (x: number, y: number): void => {
  fireEvent.pointerDown(canvas(), { button: 0, clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(canvas(), { button: 0, clientX: x, clientY: y, pointerId: 1 });
};

describe("DiagramEditor", () => {
  it("offers the kind's tools by accessible name only", () => {
    render(<Host kind="state" initial={emptyScene()} />);
    for (const name of ["Select", "Initial state", "State", "Final state", "Transition", "Undo", "Redo", "Duplicate", "Delete"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Class" })).toBeNull();
  });

  it("places an element with a tool, then undoes it", () => {
    const onChange = vi.fn();
    render(<Host kind="class" initial={emptyScene()} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    click(200, 150);
    const placed = onChange.mock.lastCall?.[0] as Scene;
    expect(placed.nodes).toHaveLength(1);
    expect(placed.nodes[0]).toMatchObject({ t: "class", name: "Class1", body: ["---"] });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((onChange.mock.lastCall?.[0] as Scene).nodes).toHaveLength(0);
  });

  it("edits a selected element's name in the inspector, and deletes it from the keyboard", () => {
    const onChange = vi.fn();
    const initial: Scene = { nodes: [{ id: "aaaa", t: "vertex", x: 0, y: 0, name: "A" }], links: [] };
    render(<Host kind="graph" initial={initial} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("group", { name: "Diagram" }), { key: "a", ctrlKey: true });
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Start" } });
    expect((onChange.mock.lastCall?.[0] as Scene).nodes[0]?.name).toBe("Start");
    fireEvent.keyDown(screen.getByRole("group", { name: "Diagram" }), { key: "Delete" });
    expect((onChange.mock.lastCall?.[0] as Scene).nodes).toHaveLength(0);
  });

  it("applies a text that reads, names the line of one that does not", () => {
    const onChange = vi.fn();
    render(<Host kind="graph" initial={EXAMPLES.graph} onChange={onChange} withText />);
    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    const text = screen.getByRole("textbox", { name: "Text" });
    fireEvent.focus(text);
    fireEvent.change(text, { target: { value: "graph {\n  A -- B\n  ???\n}" } });
    expect(screen.getByRole("status")).toHaveTextContent("Line 3: cannot read “???”");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(text, { target: { value: "graph {\n  A -- B\n  B -- G\n}" } });
    const next = onChange.mock.lastCall?.[0] as Scene;
    expect(next.nodes.map((n) => n.name)).toEqual(["A", "B", "G"]);
    expect(next.nodes[0]?.id).toBe(EXAMPLES.graph.nodes[0]?.id);
  });

  it("read only: no toolbar, no inspector", () => {
    render(<DiagramEditor kind="class" value={EXAMPLES.class} onChange={() => undefined} readOnly height={300} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("DiagramView", () => {
  it("draws every element's name and every label", () => {
    const { container } = render(<DiagramView kind="er" value={EXAMPLES.er} />);
    const text = container.textContent ?? "";
    for (const w of ["Client", "Commande", "LigneCommande", "Produit", "passe", "contient"]) expect(text).toContain(w);
  });

  it("says when the diagram is empty", () => {
    render(<DiagramView kind="flow" value={emptyScene()} />);
    expect(screen.getByText("Empty diagram")).toBeInTheDocument();
  });
});
