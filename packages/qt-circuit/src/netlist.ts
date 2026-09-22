/**
 * Netlist extraction: a schematic becomes a set of NETS (docs/spec/04 §4.11).
 *
 * This is the one place connectivity is decided, and it is a PURE function of
 * the stored answer — the server never routes a wire. The geometry of record
 * is `wire.points`: the editor routed the polyline, stored it, and the
 * extractor reads nothing else. Two consequences the rest of the package
 * leans on:
 *
 * - the same answer always yields the same netlist, so a grading can be
 *   replayed and a diff between two attempts means something;
 * - the browser cannot influence the netlist beyond what it stored, which is
 *   what makes invariant 14 (the source is rebuilt server-side) hold for a
 *   `circuit` question: `spice.ts` emits from HERE, never from a request.
 *
 * The extractor also reports what is WRONG with the schematic — a floating
 * pin, a port nobody wired, a value outside its range — as machine codes. It
 * never refuses: a broken schematic still extracts, and the grader decides
 * what to do with the diagnostics.
 */
import {
  LIBRARY,
  PORTS,
  PORT_IDS,
  valueIssue,
  type ComponentKind,
  type PinSpec,
  type PortId,
} from "./library.js";
import type { Palette, Schematic, SchematicComponent, Supplies } from "./schema.js";

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

/** A pin of a placed component, by index, or one of the four box ports. */
export type PinRef = { c: string; p: number } | { port: PortId };

/** The stable key of a pin inside one schematic: `"c3:1"` or `"port:in+"`. */
export function pinKey(ref: PinRef): string {
  return "port" in ref ? `port:${ref.port}` : `${ref.c}:${ref.p}`;
}

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/**
 * Where a pin sits on the canvas: the component's origin plus its local pin
 * offset through the orientation matrix. `m` is in SVG order `[a, b, c, d]`,
 * so `x' = a·x + c·y` and `y' = b·x + d·y` — the same convention the editor
 * writes into the `transform` attribute, which is why a symbol drawn there
 * and a pin computed here cannot drift apart.
 */
export function pinPosition(component: SchematicComponent, pin: PinSpec): Point2 {
  const [a, b, c, d] = component.m;
  return {
    x: component.x + a * pin.x + c * pin.y,
    y: component.y + b * pin.x + d * pin.y,
  };
}

/** Where a port sits: fixed on the box border. */
export function portPosition(port: PortId): Point2 {
  const spec = PORTS[port];
  return { x: spec.x, y: spec.y };
}

// ---------------------------------------------------------------------------
// Nets and diagnostics
// ---------------------------------------------------------------------------

export interface Net {
  /** Index in {@link Netlist.nets}; stable for one extraction. */
  id: number;
  /**
   * The SPICE node name: `"0"` (ground), `"in"`, `"inn"`, `"out"`, `"outn"`,
   * `"vcc"`, `"vee"`, or `"n<k>"` for everything the student wired inside.
   */
  name: string;
  pins: PinRef[];
}

export type NetlistIssueCode =
  | "floating_pin"
  | "unconnected_port"
  | "dangling_wire"
  | "no_ground"
  | "missing_value"
  | "invalid_value"
  | "value_out_of_range"
  | "duplicate_name"
  | "too_many_components"
  | "kind_not_allowed";

export interface NetlistIssue {
  code: NetlistIssueCode;
  /**
   * What the issue is about, in the words the student reads on the canvas:
   * `"R1.2"` (a pin), `"out+"` (a port), `"w4"` (a wire), `"R1"` (a
   * component). A schematic-wide issue (`no_ground`, `too_many_components`)
   * carries an empty ref.
   */
  ref: string;
}

export interface Netlist {
  nets: Net[];
  /** Key from {@link pinKey} → the net the pin belongs to. Pins with no net are absent. */
  netOfPin: Map<string, Net>;
  issues: NetlistIssue[];
  /** Non-terminal components: what `palette.maxComponents` counts. */
  counted: number;
}

export interface ExtractOptions {
  commonGround: boolean;
  /** Given: the palette limits are checked (a tampered or stale answer). */
  palette?: Palette;
  /** Given: a supply terminal the harness does not offer is refused. */
  supplies?: Supplies;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const samePoint = (a: Point2, b: Point2): boolean => a.x === b.x && a.y === b.y;

/** Inclusive: an endpoint of the segment counts as being on it. */
function onSegment(p: Point2, s: Point2, e: Point2): boolean {
  const cross = (e.x - s.x) * (p.y - s.y) - (e.y - s.y) * (p.x - s.x);
  if (cross !== 0) return false;
  return (
    p.x >= Math.min(s.x, e.x) &&
    p.x <= Math.max(s.x, e.x) &&
    p.y >= Math.min(s.y, e.y) &&
    p.y <= Math.max(s.y, e.y)
  );
}

/**
 * Whether a point lies on the polyline. Used ONLY with a free end of another
 * wire: an interior crossing — two wires that merely cross, neither of them
 * ending there — is not a connection, which is exactly the rule a hand-drawn
 * schematic follows (a junction is drawn with a dot, i.e. an end).
 */
function onPolyline(p: Point2, points: ReadonlyArray<readonly [number, number]>): boolean {
  for (let i = 0; i + 1 < points.length; i += 1) {
    const s = points[i];
    const e = points[i + 1];
    if (s === undefined || e === undefined) continue;
    if (onSegment(p, { x: s[0], y: s[1] }, { x: e[0], y: e[1] })) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

class Dsu {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    let root = key;
    for (;;) {
      const next = this.parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    let walk = key;
    for (;;) {
      const next = this.parent.get(walk);
      if (next === undefined || next === walk) break;
      this.parent.set(walk, root);
      walk = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * When one net carries several named things — a `GND` symbol dropped on the
 * input port, say — the strongest name wins, and the weaker one is simply not
 * mentioned. Ground first: a shorted input is still ground.
 */
const NAME_PRIORITY: readonly string[] = ["0", "vcc", "vee", "in", "inn", "out", "outn"];

const strongerName = (a: string, b: string): string =>
  NAME_PRIORITY.indexOf(a) <= NAME_PRIORITY.indexOf(b) ? a : b;

/** The terminal kinds and the global net each one names. */
const TERMINAL_NET: Readonly<Partial<Record<ComponentKind, string>>> = {
  GND: "0",
  VCC: "vcc",
  VEE: "vee",
};

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Reads the nets out of a schematic.
 *
 * Connectivity, in full:
 * - a wire is ONE net along all of its points;
 * - two wires connect when a free END of one lies anywhere on the other, or
 *   when their ends coincide (the T-junction and the junction dot);
 * - a pin or a port connects to a wire when it sits exactly on one of the
 *   wire's two ends;
 * - two pins at the same position connect directly (touching symbols);
 * - `GND`, `VCC` and `VEE` symbols name a global net wherever they are, and
 *   all the instances of one kind are the same net.
 */
export function extractNets(schematic: Schematic, options: ExtractOptions): Netlist {
  const { commonGround } = options;
  const dsu = new Dsu();
  const issues: NetlistIssue[] = [];

  // --- the nodes: one per component pin, one per port, one per wire --------
  interface PinNode {
    key: string;
    ref: PinRef;
    at: Point2;
    /** Sort key: the component's index, or −1 for a port (always named anyway). */
    order: number;
    /** Terminal pins are exempt from `floating_pin`: the symbol IS the connection. */
    terminal: boolean;
  }

  const pinNodes: PinNode[] = [];
  for (const [index, component] of schematic.components.entries()) {
    const spec = LIBRARY[component.kind];
    for (const [p, pin] of spec.pins.entries()) {
      const ref: PinRef = { c: component.id, p };
      const key = pinKey(ref);
      dsu.add(key);
      pinNodes.push({
        key,
        ref,
        at: pinPosition(component, pin),
        order: index,
        terminal: spec.terminal,
      });
    }
  }
  for (const port of PORT_IDS) {
    const ref: PinRef = { port };
    const key = pinKey(ref);
    dsu.add(key);
    pinNodes.push({ key, ref, at: portPosition(port), order: -1, terminal: false });
  }

  const wireKey = (id: string): string => `wire:${id}`;
  const wireOrder = (index: number): number => schematic.components.length + index;
  for (const wire of schematic.wires) dsu.add(wireKey(wire.id));

  // --- wire ↔ wire ---------------------------------------------------------
  const endsOf = (wire: Schematic["wires"][number]): Point2[] => {
    const first = wire.points[0];
    const last = wire.points[wire.points.length - 1];
    const out: Point2[] = [];
    if (first !== undefined) out.push({ x: first[0], y: first[1] });
    if (last !== undefined) out.push({ x: last[0], y: last[1] });
    return out;
  };

  for (let i = 0; i < schematic.wires.length; i += 1) {
    const a = schematic.wires[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < schematic.wires.length; j += 1) {
      const b = schematic.wires[j];
      if (b === undefined) continue;
      const touches =
        endsOf(a).some((p) => onPolyline(p, b.points)) ||
        endsOf(b).some((p) => onPolyline(p, a.points));
      if (touches) dsu.union(wireKey(a.id), wireKey(b.id));
    }
  }

  // --- pin ↔ wire, pin ↔ pin ----------------------------------------------
  const hasWire = new Set<string>();
  for (const wire of schematic.wires) {
    const ends = endsOf(wire);
    for (const node of pinNodes) {
      if (ends.some((e) => samePoint(e, node.at))) {
        dsu.union(node.key, wireKey(wire.id));
        hasWire.add(node.key);
      }
    }
  }

  for (let i = 0; i < pinNodes.length; i += 1) {
    const a = pinNodes[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < pinNodes.length; j += 1) {
      const b = pinNodes[j];
      if (b === undefined) continue;
      if (samePoint(a.at, b.at)) dsu.union(a.key, b.key);
    }
  }

  // --- the harness's own ties ---------------------------------------------
  // With a common ground the negative port of each side IS the reference
  // node, so the two of them and every `GND` symbol are one net; without it
  // they are two free nets the student has to wire, and only `GND` names 0.
  const groundKeys: string[] = [];
  if (commonGround) {
    groundKeys.push(pinKey({ port: "in-" }), pinKey({ port: "out-" }));
  }
  const railKeys = new Map<string, string[]>([
    ["0", groundKeys],
    ["vcc", []],
    ["vee", []],
  ]);
  for (const component of schematic.components) {
    const net = TERMINAL_NET[component.kind];
    if (net === undefined) continue;
    railKeys.get(net)?.push(pinKey({ c: component.id, p: 0 }));
  }
  for (const keys of railKeys.values()) {
    const first = keys[0];
    if (first === undefined) continue;
    for (const key of keys) dsu.union(first, key);
  }

  // --- the fixed names -----------------------------------------------------
  const fixedName = new Map<string, string>();
  const nameNode = (key: string, name: string): void => {
    const root = dsu.find(key);
    const current = fixedName.get(root);
    fixedName.set(root, current === undefined ? name : strongerName(current, name));
  };
  nameNode(pinKey({ port: "in+" }), "in");
  nameNode(pinKey({ port: "out+" }), "out");
  nameNode(pinKey({ port: "in-" }), commonGround ? "0" : "inn");
  nameNode(pinKey({ port: "out-" }), commonGround ? "0" : "outn");
  for (const [net, keys] of railKeys) {
    for (const key of keys) nameNode(key, net);
  }

  // --- group ---------------------------------------------------------------
  interface Group {
    root: string;
    pins: PinRef[];
    order: number;
    wires: number;
  }
  const groups = new Map<string, Group>();
  const touch = (root: string, order: number): Group => {
    const existing = groups.get(root);
    if (existing !== undefined) {
      existing.order = Math.min(existing.order, order);
      return existing;
    }
    const created: Group = { root, pins: [], order, wires: 0 };
    groups.set(root, created);
    return created;
  };
  for (const node of pinNodes) touch(dsu.find(node.key), node.order).pins.push(node.ref);
  for (const [index, wire] of schematic.wires.entries()) {
    touch(dsu.find(wireKey(wire.id)), wireOrder(index)).wires += 1;
  }

  // A group with no pin at all is a wire floating in the void: it is not a
  // node of the circuit, so it is not a net (the wire still shows up in the
  // diagnostics through its ends).
  const ordered = [...groups.values()]
    .filter((g) => g.pins.length > 0)
    .sort((a, b) => a.order - b.order);

  const nets: Net[] = [];
  const netOfPin = new Map<string, Net>();
  let anonymous = 0;
  for (const group of ordered) {
    const fixed = fixedName.get(group.root);
    anonymous += fixed === undefined ? 1 : 0;
    const net: Net = {
      id: nets.length,
      name: fixed ?? `n${anonymous}`,
      pins: group.pins,
    };
    nets.push(net);
    for (const ref of group.pins) netOfPin.set(pinKey(ref), net);
  }

  // --- diagnostics ---------------------------------------------------------
  const groupOf = (key: string): Group | undefined => groups.get(dsu.find(key));

  const seenNames = new Set<string>();
  const counted = schematic.components.filter((c) => !LIBRARY[c.kind].terminal).length;

  for (const component of schematic.components) {
    const spec = LIBRARY[component.kind];

    if (options.palette !== undefined && !options.palette.kinds.includes(component.kind)) {
      issues.push({ code: "kind_not_allowed", ref: component.name });
    } else if (
      options.supplies !== undefined &&
      ((component.kind === "VCC" && options.supplies.vcc === null) ||
        (component.kind === "VEE" && options.supplies.vee === null))
    ) {
      // The harness offers no such rail, so the symbol names a net no source
      // ever drives. Same verdict as a kind outside the palette.
      issues.push({ code: "kind_not_allowed", ref: component.name });
    }

    const lowered = component.name.toLowerCase();
    if (seenNames.has(lowered)) issues.push({ code: "duplicate_name", ref: component.name });
    seenNames.add(lowered);

    switch (valueIssue(component.kind, component.value)) {
      case "missing":
        issues.push({ code: "missing_value", ref: component.name });
        break;
      case "invalid":
        issues.push({ code: "invalid_value", ref: component.name });
        break;
      case "range":
        issues.push({ code: "value_out_of_range", ref: component.name });
        break;
      default:
        break;
    }

    if (spec.terminal) continue;
    for (const [p, pin] of spec.pins.entries()) {
      const group = groupOf(pinKey({ c: component.id, p }));
      // A pin is floating when nothing ELSE electrical shares its node: a
      // wire that leads nowhere leaves the pin just as unconnected.
      if (group === undefined || group.pins.length < 2) {
        issues.push({ code: "floating_pin", ref: `${component.name}.${pin.name}` });
      }
    }
  }

  for (const wire of schematic.wires) {
    const resolve = (end: Schematic["wires"][number]["a"]): Point2 | null => {
      if (end.kind === "free") return { x: end.x, y: end.y };
      if (end.kind === "port") return portPosition(end.port);
      const component = schematic.components.find((c) => c.id === end.c);
      if (component === undefined) return null;
      const pin = LIBRARY[component.kind].pins[end.p];
      if (pin === undefined) return null;
      return pinPosition(component, pin);
    };
    const ends = endsOf(wire);
    const first = ends[0];
    const last = ends[ends.length - 1];
    const a = resolve(wire.a);
    const b = resolve(wire.b);
    // The polyline is the geometry of record; `a`/`b` only say what the
    // editor MEANT to attach. When the two disagree the wire is reported and
    // the connectivity above still stands.
    const attached =
      a !== null && b !== null && first !== undefined && last !== undefined &&
      samePoint(a, first) && samePoint(b, last);
    if (!attached) issues.push({ code: "dangling_wire", ref: wire.id });
  }

  for (const port of PORT_IDS) {
    const key = pinKey({ port });
    const group = groupOf(key);
    // Under a common ground `in-` and `out-` are tied by the harness itself,
    // so they are never "unconnected": the pair always shares a node.
    if (group === undefined || (group.pins.length < 2 && group.wires === 0)) {
      issues.push({ code: "unconnected_port", ref: port });
    }
  }

  if (!nets.some((n) => n.name === "0")) issues.push({ code: "no_ground", ref: "" });

  if (options.palette !== undefined && counted > options.palette.maxComponents) {
    issues.push({ code: "too_many_components", ref: "" });
  }

  return { nets, netOfPin, issues, counted };
}

/** `floating_pin:R1.2`, `no_ground:` — the flat form stored in `details.netlist.issues`. */
export function formatIssue(issue: NetlistIssue): string {
  return `${issue.code}:${issue.ref}`;
}

/** The two codes that mean the answer no longer fits the question, not that it is wrong. */
export const PALETTE_ISSUE_CODES: readonly NetlistIssueCode[] = [
  "too_many_components",
  "kind_not_allowed",
];

export const hasPaletteViolation = (issues: readonly NetlistIssue[]): boolean =>
  issues.some((i) => (PALETTE_ISSUE_CODES as readonly string[]).includes(i.code));
