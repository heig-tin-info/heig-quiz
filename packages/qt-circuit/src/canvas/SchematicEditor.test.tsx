import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Schematic, type Palette, type Supplies } from "../schema.js";

import { SchematicEditor } from "./SchematicEditor.js";
import { FIT_VIEW, ORIENT_0 } from "./geometry.js";
import { withRoutes } from "./router.js";

/**
 * The editor maps a client point through the SVG's box. jsdom has no layout,
 * so the box is stubbed at exactly the fitted view: one canvas unit per pixel,
 * no letterbox, world = client − 12 on both axes.
 */
const WORLD_OFFSET = -FIT_VIEW.x;
const client = (x: number, y: number): { clientX: number; clientY: number } => ({
  clientX: x + WORLD_OFFSET,
  clientY: y + WORLD_OFFSET,
});

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: FIT_VIEW.w,
    bottom: FIT_VIEW.h,
    width: FIT_VIEW.w,
    height: FIT_VIEW.h,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

const PALETTE: Palette = { kinds: ["R", "C", "GND", "VCC", "VEE"], maxComponents: 3 };
const SUPPLIES: Supplies = { vcc: null, vee: null };

const EMPTY: Schematic = { components: [], wires: [] };

const ONE_R: Schematic = withRoutes({
  components: [{ id: "c1", kind: "R", x: 200, y: 160, m: ORIENT_0, name: "R1", value: "10k" }],
  wires: [],
});

/** A host that really owns the value, which is what the editor expects. */
function Harness({
  initial = EMPTY,
  palette = PALETTE,
  supplies = SUPPLIES,
  readOnly = false,
  onChange,
}: {
  initial?: Schematic;
  palette?: Palette;
  supplies?: Supplies;
  readOnly?: boolean;
  onChange?: (next: Schematic) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SchematicEditor
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      palette={palette}
      supplies={supplies}
      readOnly={readOnly}
    />
  );
}

const canvas = (): SVGSVGElement => screen.getByTestId("schematic-canvas") as unknown as SVGSVGElement;

/** Arms a palette tile the way a pointer does, and lets the press go. */
function armPalette(name: string): void {
  fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(document.body, { clientX: 0, clientY: 0 });
}

describe("the palette", () => {
  it("offers only the kinds the question allows", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Resistor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capacitor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ground" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inductor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ideal op-amp" })).not.toBeInTheDocument();
  });

  it("hides VCC and VEE until the question declares a supply", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Positive supply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Negative supply" })).not.toBeInTheDocument();
  });

  it("shows the supply whose rail exists, and only that one", () => {
    render(<Harness supplies={{ vcc: 12, vee: null }} />);
    expect(screen.getByRole("button", { name: "Positive supply" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Negative supply" })).not.toBeInTheDocument();
  });

  it("counts what is placed against what is allowed", () => {
    render(<Harness initial={ONE_R} />);
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("stops offering parts once the budget is spent, but never stops the terminals", () => {
    const full = withRoutes({
      components: [1, 2, 3].map((n) => ({
        id: `c${n}`,
        kind: "R" as const,
        x: 100 + n * 100,
        y: 160,
        m: ORIENT_0,
        name: `R${n}`,
        value: "10k",
      })),
      wires: [],
    });
    render(<Harness initial={full} />);
    expect(screen.getByRole("button", { name: "Resistor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ground" })).not.toBeDisabled();
    expect(screen.getByText("You may place 3 components.")).toBeInTheDocument();
  });
});

describe("placing", () => {
  it("arms a kind on click and places it where the canvas is clicked next", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    armPalette("Resistor");
    fireEvent.pointerDown(canvas(), { button: 0, ...client(300, 240) });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as Schematic;
    expect(() => Schematic.parse(next)).not.toThrow();
    expect(next.components).toHaveLength(1);
    expect(next.components[0]).toMatchObject({ id: "c1", kind: "R", x: 300, y: 240, name: "R1", value: "10k" });
  });

  it("keeps placing while the tool is armed, and numbers the names", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    armPalette("Resistor");
    fireEvent.pointerDown(canvas(), { button: 0, ...client(200, 160) });
    fireEvent.pointerDown(canvas(), { button: 0, ...client(200, 320) });
    const last = onChange.mock.calls.at(-1)?.[0] as Schematic;
    expect(last.components.map((c) => c.name)).toEqual(["R1", "R2"]);
  });

  it("clamps a component dropped outside the box back inside it", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    armPalette("Resistor");
    fireEvent.pointerDown(canvas(), { button: 0, ...client(-200, -200) });
    const next = onChange.mock.calls[0]?.[0] as Schematic;
    expect(() => Schematic.parse(next)).not.toThrow();
    expect(next.components[0]?.x).toBe(40);
    expect(next.components[0]?.y).toBe(20);
  });

  it("refuses to place beyond the budget", () => {
    const onChange = vi.fn();
    const full = withRoutes({
      components: [1, 2, 3].map((n) => ({
        id: `c${n}`,
        kind: "R" as const,
        x: 100 + n * 100,
        y: 160,
        m: ORIENT_0,
        name: `R${n}`,
        value: "10k",
      })),
      wires: [],
    });
    render(<Harness initial={full} onChange={onChange} />);
    /* The tile is disabled, and the canvas does not place behind its back. */
    fireEvent.pointerDown(canvas(), { button: 0, ...client(600, 400) });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("wiring", () => {
  it("routes from a pin to a port and stores the polyline", () => {
    const onChange = vi.fn();
    render(<Harness initial={ONE_R} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Wire" }));
    fireEvent.pointerDown(canvas(), { button: 0, ...client(160, 160) }); // R1 pin 1
    fireEvent.pointerDown(canvas(), { button: 0, ...client(0, 160) }); // port in+

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as Schematic;
    expect(() => Schematic.parse(next)).not.toThrow();
    const wire = next.wires[0]!;
    expect(wire.a).toEqual({ kind: "pin", c: "c1", p: 0 });
    expect(wire.b).toEqual({ kind: "port", port: "in+" });
    expect(wire.points[0]).toEqual([160, 160]);
    expect(wire.points.at(-1)).toEqual([0, 160]);
  });

  it("adds a waypoint on a click in open space", () => {
    const onChange = vi.fn();
    render(<Harness initial={ONE_R} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Wire" }));
    fireEvent.pointerDown(canvas(), { button: 0, ...client(160, 160) });
    fireEvent.pointerDown(canvas(), { button: 0, ...client(100, 400) });
    expect(onChange).not.toHaveBeenCalled(); // nothing committed yet
    fireEvent.pointerDown(canvas(), { button: 0, ...client(0, 320) }); // port in-
    const next = onChange.mock.calls[0]?.[0] as Schematic;
    expect(next.wires[0]?.via).toEqual([{ x: 100, y: 400 }]);
    expect(next.wires[0]?.points).toContainEqual([100, 400]);
  });

  it("gives up the wire being drawn on Escape", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial={ONE_R} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Wire" }));
    fireEvent.pointerDown(canvas(), { button: 0, ...client(160, 160) });
    fireEvent.keyDown(container.firstElementChild!, { key: "Escape" });
    fireEvent.pointerDown(canvas(), { button: 0, ...client(0, 160) });
    /* The Escape dropped the draft, so this click only STARTS a new wire. */
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("waypoints", () => {
  const WITH_VIA: Schematic = withRoutes({
    components: [{ id: "c1", kind: "R", x: 200, y: 160, m: ORIENT_0, name: "R1", value: "10k" }],
    wires: [
      {
        id: "w1",
        a: { kind: "pin", c: "c1", p: 0 },
        b: { kind: "port", port: "in+" },
        via: [{ x: 100, y: 400 }],
        points: [[160, 160], [100, 400], [0, 160]],
      },
    ],
  });

  it("drags a waypoint and re-routes the wire through it", () => {
    const onChange = vi.fn();
    render(<Harness initial={WITH_VIA} onChange={onChange} />);
    fireEvent.pointerDown(canvas(), { button: 0, ...client(100, 300) }); // select the wire
    fireEvent.pointerDown(canvas(), { button: 0, ...client(100, 400) }); // grab the handle
    fireEvent.pointerMove(canvas(), { ...client(180, 420) });
    fireEvent.pointerUp(canvas(), { button: 0, ...client(180, 420) });

    const next = onChange.mock.calls.at(-1)?.[0] as Schematic;
    expect(next.wires[0]?.via).toEqual([{ x: 180, y: 420 }]);
    expect(next.wires[0]?.points).toContainEqual([180, 420]);
    expect(() => Schematic.parse(next)).not.toThrow();
  });

  it("drops a waypoint on a second press", () => {
    const onChange = vi.fn();
    render(<Harness initial={WITH_VIA} onChange={onChange} />);
    fireEvent.pointerDown(canvas(), { button: 0, ...client(100, 300) });
    fireEvent.pointerDown(canvas(), { button: 0, ...client(100, 400) });
    fireEvent.pointerUp(canvas(), { button: 0, ...client(100, 400) });
    fireEvent.pointerDown(canvas(), { button: 0, ...client(100, 400) });

    const next = onChange.mock.calls.at(-1)?.[0] as Schematic;
    expect(next.wires[0]?.via).toEqual([]);
  });
});

describe("selecting and editing", () => {
  it("opens the inspector on the one selected component", () => {
    render(<Harness initial={ONE_R} />);
    fireEvent.pointerDown(canvas(), { button: 0, shiftKey: true, ...client(200, 160) });
    expect(screen.getByText("Resistor")).toBeInTheDocument();
    expect(screen.getByDisplayValue("R1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("10k")).toBeInTheDocument();
  });

  it("flags a value the library will not take", () => {
    const onChange = vi.fn();
    render(<Harness initial={ONE_R} onChange={onChange} />);
    fireEvent.pointerDown(canvas(), { button: 0, shiftKey: true, ...client(200, 160) });
    const field = screen.getByDisplayValue("10k");
    fireEvent.change(field, { target: { value: "twelve" } });
    expect(screen.getByText("Not a value (try 4.7k, 100n, 1M).")).toBeInTheDocument();
    /* The character is still committed: what a student typed is their answer. */
    const next = onChange.mock.calls.at(-1)?.[0] as Schematic;
    expect(next.components[0]?.value).toBe("twelve");
  });

  it("deletes the selection", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial={ONE_R} onChange={onChange} />);
    fireEvent.pointerDown(canvas(), { button: 0, shiftKey: true, ...client(200, 160) });
    fireEvent.keyDown(container.firstElementChild!, { key: "Delete" });
    const next = onChange.mock.calls.at(-1)?.[0] as Schematic;
    expect(next.components).toHaveLength(0);
  });

  it("rotates the selection and re-routes what hangs off it", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial={ONE_R} onChange={onChange} />);
    fireEvent.pointerDown(canvas(), { button: 0, shiftKey: true, ...client(200, 160) });
    fireEvent.keyDown(container.firstElementChild!, { key: "r" });
    const next = onChange.mock.calls.at(-1)?.[0] as Schematic;
    expect(next.components[0]?.m).toEqual([0, 1, -1, 0]);
    expect(() => Schematic.parse(next)).not.toThrow();
  });
});

describe("history", () => {
  it("undoes the last committed edit", () => {
    const { container } = render(<Harness />);
    armPalette("Resistor");
    fireEvent.pointerDown(canvas(), { button: 0, ...client(300, 240) });
    expect(container.querySelectorAll("[data-component]")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(container.querySelectorAll("[data-component]")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(container.querySelectorAll("[data-component]")).toHaveLength(1);
  });

  it("leaves Undo unavailable until something has happened", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it("answers Ctrl+Z, and only when it has the focus", () => {
    const { container } = render(<Harness />);
    armPalette("Resistor");
    fireEvent.pointerDown(canvas(), { button: 0, ...client(300, 240) });
    expect(container.querySelectorAll("[data-component]")).toHaveLength(1);

    /* Sent to the page it reaches nothing: the shortcuts are not global, so two
       editors on one screen — and the app's own keys — never fight over them. */
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(container.querySelectorAll("[data-component]")).toHaveLength(1);

    fireEvent.keyDown(container.firstElementChild!, { key: "z", ctrlKey: true });
    expect(container.querySelectorAll("[data-component]")).toHaveLength(0);
  });
});

describe("readOnly", () => {
  it("shows no palette and no transforms", () => {
    render(<Harness initial={ONE_R} readOnly />);
    expect(screen.queryByRole("button", { name: "Resistor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit to view" })).toBeInTheDocument();
  });

  it("selects but never edits", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial={ONE_R} readOnly onChange={onChange} />);
    fireEvent.pointerDown(canvas(), { button: 0, ...client(200, 160) });
    /* The inspector reads the component out; it offers no field. */
    expect(screen.getByText("Resistor")).toBeInTheDocument();
    expect(screen.getAllByText("R1").length).toBeGreaterThan(1);
    expect(screen.queryByDisplayValue("10k")).not.toBeInTheDocument();
    fireEvent.keyDown(container.firstElementChild!, { key: "Delete" });
    fireEvent.keyDown(container.firstElementChild!, { key: "r" });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("the view", () => {
  it("opens fitted to the whole box and comes back to it", () => {
    render(<Harness />);
    expect(canvas().getAttribute("viewBox")).toBe("-12 -12 824 504");
    fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
    expect(canvas().getAttribute("viewBox")).toBe("-12 -12 824 504");
    expect(screen.getByText("100 %")).toBeInTheDocument();
  });

  it("pans with the right button and does not open a context menu", () => {
    render(<Harness />);
    fireEvent.pointerDown(canvas(), { button: 2, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(canvas(), { clientX: 300, clientY: 300 });
    expect(canvas().getAttribute("viewBox")).toBe("88 -12 824 504");
    fireEvent.pointerUp(canvas(), { button: 2, clientX: 300, clientY: 300 });
  });
});

describe("the strings", () => {
  it("are the host's when the host gives them", () => {
    render(
      <SchematicEditor
        value={EMPTY}
        onChange={() => {}}
        palette={PALETTE}
        supplies={SUPPLIES}
        strings={{ toolWire: "Fil", components: "Composants" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Fil" })).toBeInTheDocument();
    expect(screen.getByText("Composants")).toBeInTheDocument();
  });
});
