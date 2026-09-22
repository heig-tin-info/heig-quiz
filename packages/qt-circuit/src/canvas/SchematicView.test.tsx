import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { COMPONENT_KINDS, PORT_IDS } from "../library.js";
import type { Schematic } from "../schema.js";

import { SchematicView } from "./SchematicView.js";
import { withRoutes } from "./router.js";
import { FIT_ASPECT, FIT_VIEW, ORIENT_0, ORIENT_90, viewBoxAttr } from "./geometry.js";

const demo: Schematic = withRoutes({
  components: [
    { id: "c1", kind: "R", x: 200, y: 160, m: ORIENT_0, name: "R1", value: "10k" },
    { id: "c2", kind: "C", x: 440, y: 260, m: ORIENT_90, name: "C1", value: "100n" },
    { id: "c3", kind: "GND", x: 440, y: 400, m: ORIENT_0, name: "GND", value: "" },
  ],
  wires: [
    { id: "w1", a: { kind: "port", port: "in+" }, b: { kind: "pin", c: "c1", p: 0 }, via: [], points: [[0, 0], [0, 0]] },
    { id: "w2", a: { kind: "pin", c: "c1", p: 1 }, b: { kind: "pin", c: "c2", p: 0 }, via: [], points: [[0, 0], [0, 0]] },
    { id: "w3", a: { kind: "pin", c: "c2", p: 1 }, b: { kind: "pin", c: "c3", p: 0 }, via: [], points: [[0, 0], [0, 0]] },
  ],
});

describe("SchematicView", () => {
  it("draws every component and every wire", () => {
    const { container } = render(<SchematicView schematic={demo} />);
    expect(container.querySelectorAll("[data-component]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-wire]")).toHaveLength(3);
  });

  it("draws the four ports with their labels", () => {
    const { container } = render(<SchematicView schematic={demo} />);
    expect(container.querySelectorAll("[data-port]")).toHaveLength(4);
    for (const port of PORT_IDS) expect(screen.getByText(port)).toBeInTheDocument();
  });

  it("writes the designator and the value beside a component", () => {
    render(<SchematicView schematic={demo} />);
    expect(screen.getByText("R1")).toBeInTheDocument();
    expect(screen.getByText("10k")).toBeInTheDocument();
    expect(screen.getByText("C1")).toBeInTheDocument();
  });

  it("fills its box through the view box, with one grid cell of margin", () => {
    const { container } = render(<SchematicView schematic={demo} height={180} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe(viewBoxAttr(FIT_VIEW));
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    /* The cap narrows the drawing instead of letterboxing it: the frame keeps
       filling the box on both axes, exactly as it does in the editor. */
    expect(svg?.style.maxHeight).toBe("180px");
    expect(svg?.style.maxWidth).toBe(`${Math.round(180 * FIT_ASPECT)}px`);
  });

  it("says so when there is nothing drawn", () => {
    render(<SchematicView schematic={{ components: [], wires: [] }} />);
    expect(screen.getByText("Nothing drawn yet.")).toBeInTheDocument();
  });

  it("takes the host's words", () => {
    render(
      <SchematicView
        schematic={{ components: [], wires: [] }}
        strings={{ emptySchematic: "Rien de dessiné." }}
      />,
    );
    expect(screen.getByText("Rien de dessiné.")).toBeInTheDocument();
  });

  it("renders every kind of the library without throwing", () => {
    const all: Schematic = withRoutes({
      components: COMPONENT_KINDS.map((kind, i) => ({
        id: `c${i + 1}`,
        kind,
        x: 60 + (i % 8) * 80,
        y: 100 + Math.floor(i / 8) * 160,
        m: ORIENT_0,
        name: `X${i + 1}`,
        value: "",
      })),
      wires: [],
    });
    const { container } = render(<SchematicView schematic={all} />);
    expect(container.querySelectorAll("[data-component]")).toHaveLength(COMPONENT_KINDS.length);
  });
});
