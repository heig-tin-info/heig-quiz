import { describe, expect, it } from "vitest";

import {
  COMPONENT_KINDS,
  DEFAULT_PALETTE,
  LIBRARY,
  formatValue,
  parseValue,
  valueIssue,
} from "./library.js";

describe("parseValue", () => {
  it("reads engineering notation", () => {
    expect(parseValue("4.7k")).toBe(4700);
    expect(parseValue("100n")).toBeCloseTo(1e-7, 15);
    expect(parseValue("10")).toBe(10);
    expect(parseValue("1e3")).toBe(1000);
    expect(parseValue(".5")).toBe(0.5);
  });

  it("is case sensitive where SPICE is not: 1M is a MEGA here", () => {
    // The whole reason values are parsed in the platform and emitted as plain
    // numbers: SPICE would read `1M` as one milli.
    expect(parseValue("1M")).toBe(1e6);
    expect(parseValue("1m")).toBe(1e-3);
  });

  it("accepts both micro signs and a unit", () => {
    expect(parseValue("1µ")).toBeCloseTo(1e-6, 15);
    expect(parseValue("1μ")).toBeCloseTo(1e-6, 15);
    expect(parseValue("1u")).toBeCloseTo(1e-6, 15);
    expect(parseValue("10 kΩ")).toBe(10_000);
    expect(parseValue("100 nF")).toBeCloseTo(1e-7, 15);
  });

  it("returns null on anything else", () => {
    for (const bad of ["", "   ", "abc", "4k7", "1 2", "10kk", "--3", "1Z"]) {
      expect(parseValue(bad), bad).toBeNull();
    }
  });
});

describe("formatValue", () => {
  it("round trips through parseValue", () => {
    for (const value of [1e-12, 1e-9, 4.7e-9, 1e-6, 1e-3, 1, 10, 4700, 1e6, 1.5e9]) {
      const parsed = parseValue(formatValue(value));
      expect(parsed, formatValue(value)).not.toBeNull();
      expect(parsed ?? 0).toBeCloseTo(value, Math.max(0, -Math.log10(value) + 6));
    }
  });

  it("writes what a student would write", () => {
    expect(formatValue(4700)).toBe("4.7k");
    expect(formatValue(1e-7)).toBe("100n");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(10)).toBe("10");
  });
});

describe("valueIssue", () => {
  it("says nothing about a kind that carries no value", () => {
    expect(valueIssue("D", "")).toBeNull();
    expect(valueIssue("NPN", "")).toBeNull();
    expect(valueIssue("GND", "")).toBeNull();
  });

  it("reports the three ways a value can be wrong", () => {
    expect(valueIssue("R", "")).toBe("missing");
    expect(valueIssue("R", "   ")).toBe("missing");
    expect(valueIssue("R", "big")).toBe("invalid");
    expect(valueIssue("R", "1e20")).toBe("range");
    expect(valueIssue("C", "10")).toBe("range");
    expect(valueIssue("R", "10k")).toBeNull();
  });
});

describe("the library itself", () => {
  it("has an entry per kind, with pins in electrical order", () => {
    for (const kind of COMPONENT_KINDS) {
      const spec = LIBRARY[kind];
      expect(spec.kind, kind).toBe(kind);
      expect(spec.pins.length, kind).toBeGreaterThan(0);
      expect(new Set(spec.pins.map((p) => p.name)).size, kind).toBe(spec.pins.length);
    }
    expect(LIBRARY.NPN.pins.map((p) => p.name)).toEqual(["C", "B", "E"]);
    expect(LIBRARY.D.pins.map((p) => p.name)).toEqual(["A", "K"]);
    expect(LIBRARY.OPAMP.pins.map((p) => p.name)).toEqual(["-", "+", "out"]);
  });

  it("offers everything but the supplies in a fresh palette", () => {
    expect(DEFAULT_PALETTE).not.toContain("VCC");
    expect(DEFAULT_PALETTE).not.toContain("VEE");
    expect(DEFAULT_PALETTE).toContain("GND");
  });
});
