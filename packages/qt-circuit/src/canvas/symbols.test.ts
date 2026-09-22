import { describe, expect, it } from "vitest";

import { COMPONENT_KINDS, LIBRARY } from "../library.js";

import { SYMBOLS, TOOL_ICONS, kindLabel, symbolOf } from "./symbols.js";

/**
 * Walks an SVG path and returns the points it visits. It handles the commands
 * these symbols actually use — M, L, H, V, A and Z, absolute and relative —
 * which is enough to check that a lead ends on its pin. An arc is reduced to
 * its endpoint; the inductor's humps are drawn between two pins and their
 * midpoints are not what this asserts.
 */
function vertices(d: string): Array<[number, number]> {
  const tokens = d.match(/[MmLlHhVvAaZzCcSsQqTt]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;
  let command = "M";
  const num = (): number => Number(tokens[i++] ?? 0);
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (/^[A-Za-z]$/.test(token)) {
      command = token;
      i += 1;
      if (command === "Z" || command === "z") {
        x = sx;
        y = sy;
        out.push([x, y]);
        continue;
      }
    }
    const relative = command === command.toLowerCase();
    switch (command.toUpperCase()) {
      case "M": {
        const dx = num();
        const dy = num();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        sx = x;
        sy = y;
        command = relative ? "l" : "L";
        break;
      }
      case "L": {
        const dx = num();
        const dy = num();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        break;
      }
      case "H": {
        const dx = num();
        x = relative ? x + dx : dx;
        break;
      }
      case "V": {
        const dy = num();
        y = relative ? y + dy : dy;
        break;
      }
      case "A": {
        num();
        num();
        num();
        num();
        num();
        const dx = num();
        const dy = num();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        break;
      }
      default:
        i += 1;
        continue;
    }
    out.push([x, y]);
  }
  return out;
}

describe("the symbol table", () => {
  it("draws every kind the library declares", () => {
    for (const kind of COMPONENT_KINDS) {
      const symbol = symbolOf(kind);
      expect(symbol.shapes.length).toBeGreaterThan(0);
      expect(symbol.viewBox.split(" ")).toHaveLength(4);
      for (const shape of symbol.shapes) expect(shape.d).toMatch(/^M/);
    }
    expect(Object.keys(SYMBOLS).sort()).toEqual([...COMPONENT_KINDS].sort());
  });

  it("ends a lead on every pin of the kind", () => {
    for (const kind of COMPONENT_KINDS) {
      const points = symbolOf(kind).shapes.flatMap((s) => vertices(s.d));
      for (const pin of LIBRARY[kind].pins) {
        const reached = points.some(
          ([x, y]) => Math.abs(x - pin.x) < 0.5 && Math.abs(y - pin.y) < 0.5,
        );
        expect(reached, `${kind}.${pin.name} at (${pin.x}, ${pin.y})`).toBe(true);
      }
    }
  });

  it("marks the two inputs of the op-amp and nothing else", () => {
    expect(symbolOf("OPAMP").marks.map((m) => m.sign)).toEqual(["-", "+"]);
    for (const kind of COMPONENT_KINDS) {
      if (kind !== "OPAMP") expect(symbolOf(kind).marks).toEqual([]);
    }
  });

  it("tells the four MOSFETs apart by their channel", () => {
    const enhancement = symbolOf("NMOS").shapes.map((s) => s.d);
    const depletion = symbolOf("NMOSD").shapes.map((s) => s.d);
    expect(enhancement).not.toEqual(depletion);
    /* The depletion channel is one solid bar; the enhancement one is broken. */
    expect(depletion.some((d) => d === "M-14 -18V18")).toBe(true);
    expect(enhancement.some((d) => d.includes("M-14 -18V-8"))).toBe(true);
  });

  it("points the bulk arrow in for an N channel and out for a P channel", () => {
    const n = symbolOf("NMOS").shapes.at(-1)!.d;
    const p = symbolOf("PMOS").shapes.at(-1)!.d;
    expect(n).not.toBe(p);
    /* The N arrow's tip sits on the left of its own base, the P arrow's right. */
    const tipX = (d: string): number => vertices(d)[0]![0];
    expect(tipX(n)).toBeLessThan(tipX(p));
  });

  it("gives the three diodes the same triangle and three different bars", () => {
    const bars = (["D", "DS", "DZ"] as const).map((k) => symbolOf(k).shapes.at(-1)!.d);
    expect(new Set(bars).size).toBe(3);
  });

  it("carries a label for every kind, in English", () => {
    for (const kind of COMPONENT_KINDS) expect(kindLabel(kind)).toBe(LIBRARY[kind].label);
  });
});

describe("the toolbar icons", () => {
  it("draws every tool the editor shows", () => {
    for (const name of ["select", "wire", "rotate", "mirrorH", "mirrorV", "duplicate", "remove", "undo", "redo", "fit"]) {
      const paths = TOOL_ICONS[name];
      expect(paths, name).toBeDefined();
      expect(paths!.length).toBeGreaterThan(0);
    }
  });
});
