import { describe, expect, it } from "vitest";

import { BOX, GRID, LIBRARY, PORT_IDS } from "../library.js";
import { Schematic, type Orientation, type SchematicComponent } from "../schema.js";

import {
  FIT_VIEW,
  MIRROR_X,
  MIRROR_Y,
  ORIENTATIONS,
  ORIENT_0,
  ORIENT_90,
  ROTATE,
  clampToBox,
  directionOf,
  extentOf,
  multiply,
  newComponent,
  nextId,
  nextName,
  overlaps,
  pinAt,
  pinPosition,
  portPosition,
  rectOf,
  resolveEnd,
  sameEnd,
  screenToWorld,
  snap,
  viewScale,
  zoomAt,
} from "./geometry.js";

const at = (kind: SchematicComponent["kind"], x: number, y: number, m: Orientation = ORIENT_0): SchematicComponent => ({
  id: "c1",
  kind,
  x,
  y,
  m,
  name: "R1",
  value: "10k",
});

describe("orientations", () => {
  it("holds exactly eight, all with determinant ±1", () => {
    expect(ORIENTATIONS).toHaveLength(8);
    const seen = new Set(ORIENTATIONS.map((m) => m.join(",")));
    expect(seen.size).toBe(8);
    for (const m of ORIENTATIONS) {
      expect(Math.abs(m[0] * m[3] - m[1] * m[2])).toBe(1);
    }
  });

  it("is closed under the three the toolbar applies", () => {
    for (const m of ORIENTATIONS) {
      for (const t of [ROTATE, MIRROR_X, MIRROR_Y]) {
        const product = multiply(t, m).join(",");
        expect(ORIENTATIONS.map((o) => o.join(","))).toContain(product);
      }
    }
  });

  it("comes back to the identity after four quarter turns", () => {
    let m: Orientation = ORIENT_0;
    for (let i = 0; i < 4; i += 1) m = multiply(ROTATE, m);
    expect(m).toEqual(ORIENT_0);
  });

  it("every product still validates against the schema", () => {
    for (const m of ORIENTATIONS) {
      const parsed = Schematic.parse({
        components: [{ id: "c1", kind: "R", x: 200, y: 200, m, name: "R1", value: "10k" }],
        wires: [],
      });
      expect(parsed.components[0]?.m).toEqual(m);
    }
  });
});

describe("pinPosition", () => {
  it("places a resistor's two pins under every orientation", () => {
    /* The resistor's pins are at ±40 on x; under the eight symmetries they land
       on the four cardinal points, twice each. */
    const found = new Set<string>();
    for (const m of ORIENTATIONS) {
      const c = at("R", 200, 200, m);
      const a = pinPosition(c, 0);
      const b = pinPosition(c, 1);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      /* The two pins stay 80 apart and centred on the component. */
      expect((a!.x + b!.x) / 2).toBe(200);
      expect((a!.y + b!.y) / 2).toBe(200);
      expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBe(80);
      found.add(`${a!.x - 200},${a!.y - 200}`);
    }
    expect([...found].sort()).toEqual(["-40,0", "0,-40", "0,40", "40,0"]);
  });

  it("turns a pin's direction with the symbol", () => {
    const upright = pinPosition(at("R", 200, 200, ORIENT_0), 1);
    expect(upright?.d).toBe(0); // out along +x
    const turned = pinPosition(at("R", 200, 200, ORIENT_90), 1);
    expect(turned?.d).toBe(1); // a quarter turn later, out along +y
  });

  it("keeps every pin on the grid under every orientation", () => {
    for (const kind of Object.keys(LIBRARY) as Array<SchematicComponent["kind"]>) {
      for (const m of ORIENTATIONS) {
        const c = at(kind, 200, 200, m);
        LIBRARY[kind].pins.forEach((_, i) => {
          const q = pinPosition(c, i);
          expect(q).not.toBeNull();
          expect(q!.x % GRID).toBe(0);
          expect(q!.y % GRID).toBe(0);
        });
      }
    }
  });

  it("returns null for a pin the kind does not have", () => {
    expect(pinPosition(at("R", 200, 200), 7)).toBeNull();
  });
});

describe("ports", () => {
  it("sits on the box border, pointing inward", () => {
    for (const port of PORT_IDS) {
      const q = portPosition(port);
      expect(q.x === 0 || q.x === BOX.width).toBe(true);
      expect(q.d).toBe(q.x === 0 ? 0 : 2);
    }
  });

  it("resolves as a wire end", () => {
    expect(resolveEnd({ kind: "port", port: "out+" }, new Map())).toEqual(portPosition("out+"));
    expect(resolveEnd({ kind: "free", x: 40, y: 60 }, new Map())).toEqual({ x: 40, y: 60, d: -1 });
    expect(resolveEnd({ kind: "pin", c: "nope", p: 0 }, new Map())).toBeNull();
  });
});

describe("rectangles", () => {
  it("turns the body with the symbol", () => {
    const flat = rectOf(at("R", 200, 200));
    expect(flat).toEqual({ x0: 170, y0: 190, x1: 230, y1: 210 });
    const turned = rectOf(at("R", 200, 200, ORIENT_90));
    expect(turned).toEqual({ x0: 190, y0: 170, x1: 210, y1: 230 });
  });

  it("takes the pins into the extent", () => {
    const e = extentOf(at("R", 200, 200));
    expect(e).toEqual({ x0: 160, y0: 190, x1: 240, y1: 210 });
  });

  it("detects an overlap", () => {
    expect(overlaps({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 20, y1: 20 })).toBe(true);
    expect(overlaps({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 11, y0: 0, x1: 20, y1: 20 })).toBe(false);
  });
});

describe("clampToBox", () => {
  it("keeps every kind's whole symbol inside the box, at every orientation", () => {
    for (const kind of Object.keys(LIBRARY) as Array<SchematicComponent["kind"]>) {
      for (const m of ORIENTATIONS) {
        for (const [x, y] of [
          [-500, -500],
          [BOX.width + 500, BOX.height + 500],
          [0, 0],
          [BOX.width, BOX.height],
        ]) {
          const p = clampToBox(kind, m, x as number, y as number);
          expect(p.x % GRID).toBe(0);
          expect(p.y % GRID).toBe(0);
          const e = extentOf({ kind, m, x: p.x, y: p.y });
          expect(e.x0).toBeGreaterThanOrEqual(0);
          expect(e.y0).toBeGreaterThanOrEqual(0);
          expect(e.x1).toBeLessThanOrEqual(BOX.width);
          expect(e.y1).toBeLessThanOrEqual(BOX.height);
        }
      }
    }
  });

  it("leaves a component that already fits where it is", () => {
    expect(clampToBox("R", ORIENT_0, 400, 240)).toEqual({ x: 400, y: 240 });
  });
});

describe("identity", () => {
  it("numbers the next id past the largest already there", () => {
    expect(nextId("c", [])).toBe("c1");
    expect(nextId("c", ["c1", "c7", "c3"])).toBe("c8");
    expect(nextId("w", ["w2"])).toBe("w3");
  });

  it("numbers a name per prefix, and never numbers a terminal", () => {
    const list = [at("R", 0, 0), { ...at("R", 0, 0), id: "c2", name: "R2" }];
    expect(nextName("R", list)).toBe("R3");
    expect(nextName("C", list)).toBe("C1");
    expect(nextName("GND", list)).toBe("GND");
    expect(nextName("VCC", list)).toBe("VCC");
  });

  it("builds a fresh component the schema accepts", () => {
    const c = newComponent("C", 190, 205, ORIENT_90, [at("R", 0, 0)]);
    expect(c.id).toBe("c2");
    expect(c.name).toBe("C1");
    expect(c.value).toBe(LIBRARY.C.defaultValue);
    expect(c.x % GRID).toBe(0);
    expect(() => Schematic.parse({ components: [c], wires: [] })).not.toThrow();
  });
});

describe("wire ends", () => {
  it("compares two ends by what they name", () => {
    expect(sameEnd({ kind: "pin", c: "c1", p: 0 }, { kind: "pin", c: "c1", p: 0 })).toBe(true);
    expect(sameEnd({ kind: "pin", c: "c1", p: 0 }, { kind: "pin", c: "c1", p: 1 })).toBe(false);
    expect(sameEnd({ kind: "port", port: "in+" }, { kind: "port", port: "in+" })).toBe(true);
    expect(sameEnd({ kind: "port", port: "in+" }, { kind: "free", x: 0, y: 0 })).toBe(false);
  });

  it("finds the pin or the port under a point", () => {
    const list = [at("R", 200, 200)];
    expect(pinAt(list, 162, 200, 9)).toEqual({ kind: "pin", c: "c1", p: 0 });
    expect(pinAt(list, 0, 160, 9)).toEqual({ kind: "port", port: "in+" });
    expect(pinAt(list, 400, 400, 9)).toBeNull();
  });
});

describe("the view", () => {
  const rect = { left: 0, top: 0, width: FIT_VIEW.w, height: FIT_VIEW.h };

  it("maps a client point back to the world one to one when the view fits", () => {
    expect(viewScale(rect, FIT_VIEW)).toBe(1);
    expect(screenToWorld(rect, FIT_VIEW, 212, 172)).toEqual({ x: 200, y: 160 });
  });

  it("takes the letterbox into account when the element is wider than the view", () => {
    const wide = { left: 0, top: 0, width: FIT_VIEW.w * 2, height: FIT_VIEW.h };
    /* `meet` centres the view: half the slack is a dead margin on each side. */
    const p = screenToWorld(wide, FIT_VIEW, FIT_VIEW.w / 2 + 212, 172);
    expect(p).toEqual({ x: 200, y: 160 });
  });

  it("survives an element with no layout, which is every jsdom test", () => {
    const p = screenToWorld({ left: 0, top: 0, width: 0, height: 0 }, FIT_VIEW, 10, 10);
    expect(Number.isFinite(p.x)).toBe(true);
  });

  it("keeps the point under the cursor put while zooming", () => {
    const zoomed = zoomAt(FIT_VIEW, 2, 200, 160);
    expect(zoomed.w).toBeCloseTo(FIT_VIEW.w / 2);
    expect(200).toBeCloseTo(zoomed.x + ((200 - FIT_VIEW.x) / FIT_VIEW.w) * zoomed.w);
  });

  it("refuses to zoom past its limits", () => {
    expect(zoomAt(FIT_VIEW, 1000, 0, 0).w).toBeCloseTo(FIT_VIEW.w / 4);
    expect(zoomAt(FIT_VIEW, 1 / 1000, 0, 0).w).toBeCloseTo(FIT_VIEW.w * 4);
  });
});

describe("small helpers", () => {
  it("snaps to the grid", () => {
    expect(snap(9)).toBe(0);
    expect(snap(11)).toBe(20);
    expect(snap(-11)).toBe(-20);
  });

  it("names the four directions the mockup's way", () => {
    expect(directionOf(1, 0)).toBe(0);
    expect(directionOf(0, 1)).toBe(1);
    expect(directionOf(-1, 0)).toBe(2);
    expect(directionOf(0, -1)).toBe(3);
  });
});
