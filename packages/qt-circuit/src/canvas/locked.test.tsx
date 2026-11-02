/**
 * The canvas is parameterized by its library (ADR-123 §1). A tiny fake
 * library — no port, a box of its own, a LOCKED terminal and a plain part —
 * proves the two things `circuit` never exercises: an editor without fixed
 * ports, and a part that moves but is never deleted, renamed nor duplicated.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fitView, ORIENT_0, viewBoxAttr } from "./geometry.js";
import { withRoutes } from "./router.js";
import { SchematicEditor } from "./SchematicEditor.js";
import type { CanvasSchematic, PartSpec, SchematicLibrary } from "./schematicLibrary.js";
import { SchematicView } from "./SchematicView.js";
import { removable, removed } from "./useSelection.js";

const PARTS: Readonly<Record<string, PartSpec>> = {
  IN: {
    prefix: "IN",
    defaultValue: "",
    value: { kind: "none" },
    pins: [{ name: "y", x: 20, y: 0, d: 0 }],
    body: [-20, -10, 30, 20],
    label_at: [0, -14],
    terminal: true,
    locked: true,
  },
  NOT: {
    prefix: "U",
    defaultValue: "",
    value: { kind: "none" },
    pins: [
      { name: "a", x: -40, y: 0, d: 2 },
      { name: "y", x: 40, y: 0, d: 0 },
    ],
    body: [-20, -10, 40, 20],
    label_at: [0, -14],
    terminal: false,
  },
};

const part = (kind: string): PartSpec => {
  const spec = PARTS[kind];
  if (spec === undefined) throw new Error(kind);
  return spec;
};

const FAKE: SchematicLibrary = {
  box: { width: 400, height: 200 },
  ports: [],
  kinds: Object.keys(PARTS),
  part,
  symbol: () => ({ shapes: [{ paint: "stroke", d: "M-20 0H20" }], marks: [], viewBox: "-20 -20 40 40" }),
  formatValue: String,
  valueIssue: () => null,
};

const FIT = fitView(FAKE.box);
const client = (x: number, y: number): { clientX: number; clientY: number } => ({
  clientX: x - FIT.x,
  clientY: y - FIT.y,
});

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: FIT.w,
    bottom: FIT.h,
    width: FIT.w,
    height: FIT.h,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

const START: CanvasSchematic = withRoutes(
  {
    components: [
      { id: "c1", kind: "IN", x: 100, y: 100, m: ORIENT_0, name: "a", value: "" },
      { id: "c2", kind: "NOT", x: 240, y: 100, m: ORIENT_0, name: "U1", value: "" },
    ],
    wires: [{ id: "w1", a: { kind: "pin", c: "c1", p: 0 }, b: { kind: "pin", c: "c2", p: 0 }, via: [], points: [] }],
  },
  FAKE,
);

function Harness({ onChange }: { onChange: (next: CanvasSchematic) => void }) {
  const [value, setValue] = useState(START);
  return (
    <SchematicEditor
      library={FAKE}
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
      palette={{ kinds: ["NOT"], maxComponents: 4 }}
    />
  );
}

const canvas = (): Element => screen.getByTestId("schematic-canvas");
const ids = (s: CanvasSchematic): string[] => [...s.components.map((c) => c.id), ...s.wires.map((w) => w.id)];

describe("a library without ports", () => {
  it("routes inside its own box and draws no port", () => {
    expect(START.wires[0]?.points).toEqual([
      [120, 100],
      [200, 100],
    ]);
    const { container } = render(<SchematicView schematic={START} library={FAKE} />);
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe(viewBoxAttr(FIT));
    expect(container.querySelector("[data-port]")).toBeNull();
    expect(container.querySelectorAll("[data-component]")).toHaveLength(2);
  });
});

describe("a locked part", () => {
  it("survives a removal, and so do its wires unless they are selected", () => {
    expect(ids(removed(START, new Set(["c1", "c2", "w1"]), FAKE))).toEqual(["c1"]);
    expect(ids(removed(START, new Set(["c1"]), FAKE))).toEqual(ids(START));
    expect(removable(START, new Set(["c1"]), FAKE)).toBe(false);
    expect(removable(START, new Set(["c1", "w1"]), FAKE)).toBe(true);
  });

  it("is passed over by Delete and Duplicate", () => {
    const onChange = vi.fn<(next: CanvasSchematic) => void>();
    const { container } = render(<Harness onChange={onChange} />);
    const root = container.firstElementChild!;
    fireEvent.keyDown(root, { key: "a", ctrlKey: true });
    fireEvent.keyDown(root, { key: "d", ctrlKey: true });
    const copy = onChange.mock.lastCall![0];
    expect(copy.components.map((c) => [c.kind, c.name])).toEqual([
      ["IN", "a"],
      ["NOT", "U1"],
      ["NOT", "U2"],
    ]);
    fireEvent.keyDown(root, { key: "a", ctrlKey: true });
    fireEvent.keyDown(root, { key: "Delete" });
    expect(ids(onChange.mock.lastCall![0])).toEqual(["c1"]);
  });

  it("offers neither delete, duplicate nor a name field, alone", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness onChange={onChange} />);
    fireEvent.pointerDown(canvas(), { button: 0, shiftKey: true, ...client(100, 100) });
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeDisabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.keyDown(container.firstElementChild!, { key: "Delete" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still moves and turns", () => {
    const onChange = vi.fn<(next: CanvasSchematic) => void>();
    const { container } = render(<Harness onChange={onChange} />);
    fireEvent.pointerDown(canvas(), { button: 0, ...client(100, 100) });
    fireEvent.pointerMove(canvas(), client(100, 160));
    fireEvent.pointerUp(canvas(), client(100, 160));
    expect(onChange.mock.lastCall![0].components[0]).toMatchObject({ id: "c1", x: 100, y: 160 });
    fireEvent.keyDown(container.firstElementChild!, { key: "r" });
    expect(onChange.mock.lastCall![0].components[0]?.m).not.toEqual(ORIENT_0);
  });
});
