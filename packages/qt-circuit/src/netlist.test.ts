import { describe, expect, it } from "vitest";

import type { Palette, Schematic, Supplies } from "./schema.js";
import { extractNets, pinKey, type NetlistIssueCode } from "./netlist.js";
import {
  ROT90,
  at,
  component,
  freeEnd,
  pinEnd,
  portEnd,
  rcLowPass,
  resetIds,
  wire,
} from "./test/fixtures.js";

const common = { commonGround: true } as const;

const codes = (schematic: Schematic, options = common): NetlistIssueCode[] =>
  extractNets(schematic, options).issues.map((i) => i.code);

const nameOfPin = (schematic: Schematic, id: string, p: number): string | undefined =>
  extractNets(schematic, common).netOfPin.get(pinKey({ c: id, p }))?.name;

describe("pinKey", () => {
  it("is stable and distinguishes a port from a pin", () => {
    expect(pinKey({ c: "c3", p: 1 })).toBe("c3:1");
    expect(pinKey({ port: "in+" })).toBe("port:in+");
  });
});

describe("connectivity", () => {
  it("joins two pins that touch, with no wire at all", () => {
    resetIds();
    const a = component("R", "R1", 200, 160, { value: "1k" });
    const b = component("R", "R2", 280, 160, { value: "1k" });
    expect(at(a, 1)).toEqual(at(b, 0));
    const schematic: Schematic = { components: [a, b], wires: [] };
    const nets = extractNets(schematic, common);
    expect(nameOfPin(schematic, a.id, 1)).toBe(nameOfPin(schematic, b.id, 0));
    // in, out, 0 and the shared node: four nets, and no floating pin between them.
    expect(nets.issues.filter((i) => i.ref === "R1.2")).toEqual([]);
  });

  it("joins a free end landing on another wire: the T-junction", () => {
    const { schematic, c } = rcLowPass();
    // w3's free end sits in the MIDDLE of w2, which runs from R1 to out+.
    expect(nameOfPin(schematic, c.id, 0)).toBe("out");
  });

  it("does NOT join two wires that merely cross", () => {
    resetIds();
    const horizontal = component("R", "R1", 60, 100, { value: "1k" });
    const vertical = component("R", "R2", 200, 180, { value: "1k", m: ROT90 });
    const schematic: Schematic = {
      components: [horizontal, vertical],
      wires: [
        wire("w1", pinEnd(horizontal, 1), freeEnd(300, 100), [
          [100, 100],
          [300, 100],
        ]),
        // Crosses w1 at (200, 100), which is INTERIOR to both: no junction.
        wire("w2", pinEnd(vertical, 0), freeEnd(200, 60), [
          [200, 140],
          [200, 60],
        ]),
      ],
    };
    const a = nameOfPin(schematic, horizontal.id, 1);
    const b = nameOfPin(schematic, vertical.id, 0);
    expect(a).not.toBe(b);
  });

  it("joins two wires whose ends coincide", () => {
    resetIds();
    const r = component("R", "R1", 400, 160, { value: "1k" });
    const [rx, ry] = at(r, 0);
    const schematic: Schematic = {
      components: [r],
      wires: [
        wire("w1", portEnd("in+"), freeEnd(200, 160), [
          [0, 160],
          [200, 160],
        ]),
        wire("w2", freeEnd(200, 160), pinEnd(r, 0), [
          [200, 160],
          [rx, ry],
        ]),
      ],
    };
    expect(nameOfPin(schematic, r.id, 0)).toBe("in");
  });
});

describe("naming", () => {
  it("names the ports and folds the negative ones into ground", () => {
    const { schematic, r, c } = rcLowPass();
    expect(nameOfPin(schematic, r.id, 0)).toBe("in");
    expect(nameOfPin(schematic, r.id, 1)).toBe("out");
    expect(nameOfPin(schematic, c.id, 1)).toBe("0");
    const nets = extractNets(schematic, common);
    const ground = nets.nets.find((n) => n.name === "0");
    expect(ground?.pins).toContainEqual({ port: "in-" });
    expect(ground?.pins).toContainEqual({ port: "out-" });
  });

  it("gives `inn`/`outn` and no ground of its own without a common ground", () => {
    resetIds();
    const r = component("R", "R1", 400, 160, { value: "1k" });
    const [rx0, ry0] = at(r, 0);
    const [rx1, ry1] = at(r, 1);
    const schematic: Schematic = {
      components: [r],
      wires: [
        wire("w1", portEnd("in+"), pinEnd(r, 0), [
          [0, 160],
          [rx0, ry0],
        ]),
        wire("w2", pinEnd(r, 1), portEnd("out+"), [
          [rx1, ry1],
          [800, 160],
        ]),
        wire("w3", portEnd("in-"), portEnd("out-"), [
          [0, 320],
          [800, 320],
        ]),
      ],
    };
    const nets = extractNets(schematic, { commonGround: false });
    expect(nets.nets.map((n) => n.name).sort()).toEqual(["in", "inn", "out"]);
    expect(nets.issues.map((i) => i.code)).toContain("no_ground");
  });

  it("names the supply rails wherever their symbols sit", () => {
    resetIds();
    const vcc = component("VCC", "VCC", 200, 100);
    const vee = component("VEE", "VEE", 300, 100);
    const gnd = component("GND", "GND", 400, 100);
    const schematic: Schematic = { components: [vcc, vee, gnd], wires: [] };
    expect(nameOfPin(schematic, vcc.id, 0)).toBe("vcc");
    expect(nameOfPin(schematic, vee.id, 0)).toBe("vee");
    expect(nameOfPin(schematic, gnd.id, 0)).toBe("0");
  });

  it("numbers the inner nets deterministically, by lowest component then wire", () => {
    resetIds();
    const r1 = component("R", "R1", 200, 160, { value: "1k" });
    const r2 = component("R", "R2", 320, 160, { value: "1k" });
    const schematic: Schematic = {
      components: [r1, r2],
      wires: [
        wire("w1", portEnd("in+"), pinEnd(r1, 0), [
          [0, 160],
          [160, 160],
        ]),
        wire("w2", pinEnd(r1, 1), pinEnd(r2, 0), [
          [240, 160],
          [280, 160],
        ]),
        wire("w3", pinEnd(r2, 1), portEnd("out+"), [
          [360, 160],
          [800, 160],
        ]),
      ],
    };
    const names = extractNets(schematic, common).nets.map((n) => n.name);
    expect(names).toEqual(["in", "out", "0", "n1"]);
    // Same schematic, same names: the emitter and a re-grading must agree.
    expect(extractNets(schematic, common).nets.map((n) => n.name)).toEqual(names);
  });
});

describe("diagnostics", () => {
  it("reports a pin nothing shares a node with", () => {
    resetIds();
    const r = component("R", "R1", 400, 160, { value: "1k" });
    const [rx0, ry0] = at(r, 0);
    const schematic: Schematic = {
      components: [r],
      wires: [
        wire("w1", portEnd("in+"), pinEnd(r, 0), [
          [0, 160],
          [rx0, ry0],
        ]),
      ],
    };
    const issues = extractNets(schematic, common).issues;
    expect(issues).toContainEqual({ code: "floating_pin", ref: "R1.2" });
    expect(issues).not.toContainEqual({ code: "floating_pin", ref: "R1.1" });
  });

  it("does not call a terminal's pin floating", () => {
    resetIds();
    const gnd = component("GND", "GND", 400, 300);
    expect(codes({ components: [gnd], wires: [] })).not.toContain("floating_pin");
  });

  it("reports a port nobody wired, and never the grounded pair", () => {
    const issues = extractNets({ components: [], wires: [] }, common).issues;
    const refs = issues.filter((i) => i.code === "unconnected_port").map((i) => i.ref);
    expect(refs).toEqual(["in+", "out+"]);
  });

  it("reports a wire whose polyline left its ends behind", () => {
    resetIds();
    const r = component("R", "R1", 400, 160, { value: "1k" });
    const schematic: Schematic = {
      components: [r],
      wires: [
        // `a` claims the port, but the polyline starts somewhere else.
        wire("w1", portEnd("in+"), pinEnd(r, 0), [
          [100, 160],
          [360, 160],
        ]),
      ],
    };
    expect(codes(schematic)).toContain("dangling_wire");
    expect(
      extractNets(schematic, common).issues.filter((i) => i.code === "dangling_wire"),
    ).toEqual([{ code: "dangling_wire", ref: "w1" }]);
  });

  it("reports the three ways a value can be wrong, and a duplicate designator", () => {
    resetIds();
    const missing = component("R", "R1", 100, 100);
    const invalid = component("R", "R2", 200, 100, { value: "big" });
    const range = component("R", "R3", 300, 100, { value: "1e20" });
    const duplicate = component("R", "R1", 400, 100, { value: "1k" });
    const issues = extractNets(
      { components: [missing, invalid, range, duplicate], wires: [] },
      common,
    ).issues;
    expect(issues).toContainEqual({ code: "missing_value", ref: "R1" });
    expect(issues).toContainEqual({ code: "invalid_value", ref: "R2" });
    expect(issues).toContainEqual({ code: "value_out_of_range", ref: "R3" });
    expect(issues.filter((i) => i.code === "duplicate_name")).toEqual([
      { code: "duplicate_name", ref: "R1" },
    ]);
  });

  it("counts the non-terminal components and refuses more than the palette allows", () => {
    resetIds();
    const palette: Palette = { kinds: ["R", "GND"], maxComponents: 1 };
    const schematic: Schematic = {
      components: [
        component("R", "R1", 100, 100, { value: "1k" }),
        component("R", "R2", 200, 100, { value: "1k" }),
        component("GND", "GND", 300, 100),
      ],
      wires: [],
    };
    const nets = extractNets(schematic, { commonGround: true, palette });
    expect(nets.counted).toBe(2);
    expect(nets.issues).toContainEqual({ code: "too_many_components", ref: "" });
  });

  it("refuses a kind outside the palette", () => {
    resetIds();
    const palette: Palette = { kinds: ["R"], maxComponents: 10 };
    const schematic: Schematic = {
      components: [component("C", "C1", 100, 100, { value: "100n", m: ROT90 })],
      wires: [],
    };
    expect(extractNets(schematic, { commonGround: true, palette }).issues).toContainEqual({
      code: "kind_not_allowed",
      ref: "C1",
    });
  });

  it("refuses a supply symbol the harness does not offer", () => {
    resetIds();
    const supplies: Supplies = { vcc: null, vee: -12 };
    const schematic: Schematic = {
      components: [component("VCC", "VCC", 100, 100), component("VEE", "VEE", 200, 100)],
      wires: [],
    };
    const issues = extractNets(schematic, { commonGround: true, supplies }).issues;
    expect(issues.filter((i) => i.code === "kind_not_allowed")).toEqual([
      { code: "kind_not_allowed", ref: "VCC" },
    ]);
  });

  it("leaves a well-formed schematic with nothing to say", () => {
    const { schematic } = rcLowPass();
    expect(
      extractNets(schematic, {
        commonGround: true,
        palette: { kinds: ["R", "C", "GND"], maxComponents: 10 },
        supplies: { vcc: null, vee: null },
      }).issues,
    ).toEqual([]);
  });

  it("covers every issue code at least once across this suite", () => {
    const all: NetlistIssueCode[] = [
      "floating_pin",
      "unconnected_port",
      "dangling_wire",
      "no_ground",
      "missing_value",
      "invalid_value",
      "value_out_of_range",
      "duplicate_name",
      "too_many_components",
      "kind_not_allowed",
    ];
    resetIds();
    // One schematic that is wrong in every way at once.
    const r = component("R", "R1", 400, 160);
    const bad = component("R", "R1", 500, 160, { value: "1e20" });
    const worse = component("C", "C1", 600, 160, { value: "big", m: ROT90 });
    const vcc = component("VCC", "VCC", 700, 100);
    const seen = new Set(
      extractNets(
        {
          components: [r, bad, worse, vcc],
          wires: [wire("w1", portEnd("in+"), pinEnd(r, 0), [[100, 160], [360, 160]])],
        },
        {
          commonGround: false,
          palette: { kinds: ["R"], maxComponents: 2 },
          supplies: { vcc: null, vee: null },
        },
      ).issues.map((i) => i.code),
    );
    for (const code of all) expect(seen, code).toContain(code);
  });
});
