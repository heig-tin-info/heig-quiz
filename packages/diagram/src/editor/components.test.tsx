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

  it("consumes Escape only when it cancelled something, so a host layer may close on it", () => {
    render(<Host kind="class" initial={emptyScene()} />);
    const group = screen.getByRole("group", { name: "Diagram" });
    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    // A tool in hand: Escape drops it, and the key is consumed.
    expect(fireEvent.keyDown(group, { key: "Escape" })).toBe(false);
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true");
    // Nothing left to cancel: the key goes on to whoever holds the editor.
    expect(fireEvent.keyDown(group, { key: "Escape" })).toBe(true);
  });

  it("consumes Escape in an inspector field and in the text pane: a host layer stays open", () => {
    const initial: Scene = { nodes: [{ id: "aaaa", t: "vertex", x: 0, y: 0, name: "A" }], links: [] };
    render(<Host kind="graph" initial={initial} withText />);
    fireEvent.keyDown(screen.getByRole("group", { name: "Diagram" }), { key: "a", ctrlKey: true });
    expect(fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" })).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    expect(fireEvent.keyDown(screen.getByRole("textbox", { name: "Text" }), { key: "Escape" })).toBe(false);
  });

  it("applies a text that reads, names the line of one that does not", () => {
    const onChange = vi.fn();
    render(<Host kind="graph" initial={EXAMPLES.graph} onChange={onChange} withText />);
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
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

  it("links two elements by a drag from the border of one to the other", () => {
    const onChange = vi.fn();
    const initial: Scene = {
      nodes: [
        { id: "aaaa", t: "vertex", x: 0, y: 0, name: "A" },
        { id: "bbbb", t: "vertex", x: 200, y: 0, name: "B" },
      ],
      links: [],
    };
    /* jsdom lays nothing out: give the canvas a box to be inside of, without a width, so the
       first view stays (40, 40) at 100 % instead of being fitted */
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 2000, bottom: 2000, width: 0, height: 0, toJSON: () => ({}) });
    render(<Host kind="graph" initial={initial} onChange={onChange} />);
    const at = (x: number, y: number) => ({ button: 0, clientX: x + 40, clientY: y + 40, pointerId: 1 });
    fireEvent.pointerDown(canvas(), at(39, 20));
    fireEvent.pointerMove(canvas(), at(120, 20));
    fireEvent.pointerMove(canvas(), at(220, 20));
    fireEvent.pointerUp(canvas(), at(220, 20));
    const linked = onChange.mock.lastCall?.[0] as Scene;
    expect(linked.links).toEqual([expect.objectContaining({ type: "edge", a: "aaaa", b: "bbbb" })]);
  });

  it("refuses an edit past a limit, rather than hand the host an answer it would refuse", () => {
    const onChange = vi.fn();
    const full: Scene = { nodes: Array.from({ length: 80 }, (_, i) => ({ id: `v${String(i).padStart(3, "0")}`, t: "vertex" as const, x: (i % 10) * 60, y: Math.floor(i / 10) * 60 })), links: [] };
    render(<Host kind="graph" initial={full} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Vertex" }));
    click(900, 900);
    expect(onChange).not.toHaveBeenCalled();
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
