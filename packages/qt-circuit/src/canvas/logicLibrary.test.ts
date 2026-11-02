/**
 * The two logic libraries obey the part table: every lead starts on its pin,
 * every output reaches x = 40, and a terminal's pill hugs its name.
 */
import { describe, expect, it } from "vitest";

import { LOGIC_KINDS, LOGIC_PARTS } from "../logicLibrary.js";
import { LOGIC_ANSI_LIBRARY, LOGIC_IEC_LIBRARY, pillWidth } from "./logicLibrary.js";

const gates = LOGIC_KINDS.filter((kind) => LOGIC_PARTS.part(kind).family !== null);

describe.each([
  ["IEC", LOGIC_IEC_LIBRARY],
  ["ANSI", LOGIC_ANSI_LIBRARY],
])("the %s library", (_style, library) => {
  it.each(gates)("draws %s with a lead from each input pin and to each output pin", (kind) => {
    const paths = library.symbol(kind).shapes.map((s) => s.d).join(" ");
    for (const pin of LOGIC_PARTS.part(kind).pins) {
      expect(paths).toMatch(pin.x < 0 ? `M${pin.x} ${pin.y}H` : new RegExp(`M[\\d.]+ ${pin.y}H40`));
    }
  });

  it("marks the clock of a flip-flop with the dynamic-input triangle, never a latch's enable", () => {
    const triangle = (kind: string) => library.symbol(kind).shapes.some((s) => s.d.startsWith("M-20 15L-13 20"));
    expect(triangle("DFF")).toBe(true);
    expect(triangle("DLATCH")).toBe(false);
  });

  it("has no port on the box border, and locks the declared terminals only", () => {
    expect(library.ports).toEqual([]);
    expect(LOGIC_KINDS.filter((kind) => library.part(kind).locked === true)).toEqual(["IN", "OUT"]);
  });
});

describe("a flip-flop", () => {
  it("qualifies its inputs in IEC and names its pins in ANSI", () => {
    const text = (library: typeof LOGIC_IEC_LIBRARY) => (library.symbol("DFF").texts ?? []).map((t) => t.text);
    expect(text(LOGIC_IEC_LIBRARY)).toEqual(["1D", "C1"]);
    expect(text(LOGIC_ANSI_LIBRARY)).toEqual(["D", "Q", "Q̄"]);
  });
});

describe("a terminal", () => {
  it("prints its name, upright, in a pill as wide as the name", () => {
    const short = LOGIC_IEC_LIBRARY.symbol("IN", "a");
    const long = LOGIC_IEC_LIBRARY.symbol("IN", "carry");
    expect(short.texts).toEqual([{ x: -14, y: 0, text: "a" }]);
    expect(pillWidth("a")).toBe(28);
    expect(pillWidth("carry")).toBeGreaterThan(pillWidth("cin"));
    expect(long.texts?.[0]?.text).toBe("carry");
  });

  it("never draws wider than the body the router keeps clear", () => {
    expect(pillWidth("abcdef")).toBeLessThanOrEqual(LOGIC_PARTS.part("IN").body[2]);
  });
});
