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
 *
 * The canvas has its own `pinPosition` (`canvas/geometry.ts`), which takes a
 * pin INDEX and also returns the direction the wire leaves in; this one is
 * the position alone, and it is the one a grade depends on.
 */
export function pinLocation(component: SchematicComponent, pin: PinSpec): Point2 {
  const [a, b, c, d] = component.m;
  return {
    x: component.x + a * pin.x + c * pin.y,
    y: component.y + b * pin.x + d * pin.y,
  };
}

/** Where a port sits: fixed on the box border (the canvas's `portPosition` adds its direction). */
export function portLocation(port: PortId): Point2 {
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

type SchematicWire = Schematic["wires"][number];

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
 * Whether a point lies EXACTLY on the polyline: collinear with one of its
 * segments and within it, by exact arithmetic — not the canvas's hit-test
 * `onPolyline`, which is a bounding box with slack. Used ONLY with a free end
 * of another wire: an interior crossing — two wires that merely cross,
 * neither of them ending there — is not a connection, which is exactly the
 * rule a hand-drawn schematic follows (a junction is drawn with a dot, i.e.
 * an end).
 */
function liesOnPolyline(p: Point2, points: ReadonlyArray<readonly [number, number]>): boolean {
  for (let i = 0; i + 1 < points.length; i += 1) {
    const s = points[i];
    const e = points[i + 1];
    if (s === undefined || e === undefined) continue;
    if (onSegment(p, { x: s[0], y: s[1] }, { x: e[0], y: e[1] })) return true;
  }
  return false;
}

/** The first and the last point of a wire's polyline (the same point twice for a one-point wire). */
function endsOf(wire: SchematicWire): Point2[] {
  const first = wire.points[0];
  const last = wire.points[wire.points.length - 1];
  const out: Point2[] = [];
  if (first !== undefined) out.push({ x: first[0], y: first[1] });
  if (last !== undefined) out.push({ x: last[0], y: last[1] });
  return out;
}

/**
 * Values bucketed by EXACT position: `"x,y"` → the values sitting there.
 *
 * Two finite numbers print the same if and only if they are equal, so a
 * lookup here is `samePoint` without the pairwise scan. `NaN` is never equal
 * to itself, so a point with a `NaN` coordinate is never indexed — it matched
 * nothing under `samePoint` either.
 */
class PointIndex<T> {
  private readonly buckets = new Map<string, T[]>();

  private static keyOf(p: Point2): string | null {
    return Number.isNaN(p.x) || Number.isNaN(p.y) ? null : `${p.x},${p.y}`;
  }

  add(p: Point2, value: T): void {
    const key = PointIndex.keyOf(p);
    if (key === null) return;
    const bucket = this.buckets.get(key);
    if (bucket === undefined) this.buckets.set(key, [value]);
    else bucket.push(value);
  }

  at(p: Point2): readonly T[] {
    const key = PointIndex.keyOf(p);
    return (key === null ? undefined : this.buckets.get(key)) ?? [];
  }

  groups(): IterableIterator<readonly T[]> {
    return this.buckets.values();
  }
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
// Extraction, phase by phase
// ---------------------------------------------------------------------------

/** One component pin or one box port: a node of the union-find with a position. */
interface PinNode {
  key: string;
  ref: PinRef;
  at: Point2;
  /** Sort key: the component's index, or −1 for a port (always named anyway). */
  order: number;
  /** Terminal pins are exempt from `floating_pin`: the symbol IS the connection. */
  terminal: boolean;
}

const wireKey = (id: string): string => `wire:${id}`;

/** The nodes: one per component pin, one per port, one per wire. */
function collectNodes(schematic: Schematic, dsu: Dsu): PinNode[] {
  const pinNodes: PinNode[] = [];
  for (const [index, component] of schematic.components.entries()) {
    const spec = LIBRARY[component.kind];
    for (const [p, pin] of spec.pins.entries()) {
      const ref: PinRef = { c: component.id, p };
      const key = pinKey(ref);
      dsu.add(key);
      pinNodes.push({ key, ref, at: pinLocation(component, pin), order: index, terminal: spec.terminal });
    }
  }
  for (const port of PORT_IDS) {
    const ref: PinRef = { port };
    const key = pinKey(ref);
    dsu.add(key);
    pinNodes.push({ key, ref, at: portLocation(port), order: -1, terminal: false });
  }
  for (const wire of schematic.wires) dsu.add(wireKey(wire.id));
  return pinNodes;
}

/** Wire ↔ wire: a free end of one lies anywhere on the other. */
function unionWires(dsu: Dsu, wires: readonly SchematicWire[]): void {
  const ends = wires.map(endsOf);
  for (let i = 0; i < wires.length; i += 1) {
    for (let j = i + 1; j < wires.length; j += 1) {
      const a = wires[i] as SchematicWire;
      const b = wires[j] as SchematicWire;
      const touches =
        (ends[i] ?? []).some((p) => liesOnPolyline(p, b.points)) ||
        (ends[j] ?? []).some((p) => liesOnPolyline(p, a.points));
      if (touches) dsu.union(wireKey(a.id), wireKey(b.id));
    }
  }
}

/**
 * Pin ↔ wire (a pin or a port on one of the wire's two ends) and pin ↔ pin
 * (touching symbols), both through one index of the pins by exact position.
 */
function unionPins(dsu: Dsu, pinNodes: readonly PinNode[], wires: readonly SchematicWire[]): void {
  const index = new PointIndex<PinNode>();
  for (const node of pinNodes) index.add(node.at, node);
  for (const wire of wires) {
    for (const end of endsOf(wire)) {
      for (const node of index.at(end)) dsu.union(node.key, wireKey(wire.id));
    }
  }
  for (const bucket of index.groups()) {
    const first = bucket[0];
    if (first === undefined) continue;
    for (const node of bucket) dsu.union(first.key, node.key);
  }
}

/**
 * The harness's own ties, as rail → the keys that sit on it.
 *
 * With a common ground the negative port of each side IS the reference node,
 * so the two of them and every `GND` symbol are one net; without it they are
 * two free nets the student has to wire, and only `GND` names 0.
 */
function railKeysOf(schematic: Schematic, commonGround: boolean): Map<string, string[]> {
  const groundKeys = commonGround ? [pinKey({ port: "in-" }), pinKey({ port: "out-" })] : [];
  const railKeys = new Map<string, string[]>([
    ["0", groundKeys],
    ["vcc", []],
    ["vee", []],
  ]);
  for (const component of schematic.components) {
    const net = TERMINAL_NET[component.kind];
    if (net !== undefined) railKeys.get(net)?.push(pinKey({ c: component.id, p: 0 }));
  }
  return railKeys;
}

/** All the instances of one rail are one net. */
function tieRails(dsu: Dsu, railKeys: ReadonlyMap<string, readonly string[]>): void {
  for (const keys of railKeys.values()) {
    const first = keys[0];
    if (first === undefined) continue;
    for (const key of keys) dsu.union(first, key);
  }
}

/** The fixed names: root → the strongest name any of its members carries. */
function assignNames(
  dsu: Dsu,
  railKeys: ReadonlyMap<string, readonly string[]>,
  commonGround: boolean,
): Map<string, string> {
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
  return fixedName;
}

/** One connected set of nodes: its pins, its wire count, and the order it is numbered in. */
interface Group {
  root: string;
  pins: PinRef[];
  order: number;
  wires: number;
}

/** Root → group, in the order the pins and then the wires first reach each root. */
function groupNodes(dsu: Dsu, schematic: Schematic, pinNodes: readonly PinNode[]): Map<string, Group> {
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
  const wireOrder = (index: number): number => schematic.components.length + index;
  for (const [index, wire] of schematic.wires.entries()) {
    touch(dsu.find(wireKey(wire.id)), wireOrder(index)).wires += 1;
  }
  return groups;
}

/**
 * The nets, numbered by their first member, the anonymous ones `n1`, `n2`…
 *
 * A group with no pin at all is a wire floating in the void: it is not a
 * node of the circuit, so it is not a net (the wire still shows up in the
 * diagnostics through its ends).
 */
function buildNets(
  groups: ReadonlyMap<string, Group>,
  fixedName: ReadonlyMap<string, string>,
): Pick<Netlist, "nets" | "netOfPin"> {
  const ordered = [...groups.values()]
    .filter((g) => g.pins.length > 0)
    .sort((a, b) => a.order - b.order);
  const nets: Net[] = [];
  const netOfPin = new Map<string, Net>();
  let anonymous = 0;
  for (const group of ordered) {
    const fixed = fixedName.get(group.root);
    anonymous += fixed === undefined ? 1 : 0;
    const net: Net = { id: nets.length, name: fixed ?? `n${anonymous}`, pins: group.pins };
    nets.push(net);
    for (const ref of group.pins) netOfPin.set(pinKey(ref), net);
  }
  return { nets, netOfPin };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

type GroupOf = (key: string) => Group | undefined;

const VALUE_ISSUE_CODE: Readonly<Record<"missing" | "invalid" | "range", NetlistIssueCode>> = {
  missing: "missing_value",
  invalid: "invalid_value",
  range: "value_out_of_range",
};

/**
 * A kind outside the palette, or a supply terminal the harness does not
 * offer: such a symbol names a net no source ever drives, which is the same
 * verdict as a kind outside the palette.
 */
function kindRefused(component: SchematicComponent, options: ExtractOptions): boolean {
  const { palette, supplies } = options;
  if (palette !== undefined && !palette.kinds.includes(component.kind)) return true;
  if (supplies === undefined) return false;
  return (
    (component.kind === "VCC" && supplies.vcc === null) ||
    (component.kind === "VEE" && supplies.vee === null)
  );
}

/**
 * A pin is floating when nothing ELSE electrical shares its node: a wire
 * that leads nowhere leaves the pin just as unconnected. Terminals are exempt.
 */
function floatingPins(component: SchematicComponent, groupOf: GroupOf): NetlistIssue[] {
  const spec = LIBRARY[component.kind];
  if (spec.terminal) return [];
  const issues: NetlistIssue[] = [];
  for (const [p, pin] of spec.pins.entries()) {
    const group = groupOf(pinKey({ c: component.id, p }));
    if (group === undefined || group.pins.length < 2) {
      issues.push({ code: "floating_pin", ref: `${component.name}.${pin.name}` });
    }
  }
  return issues;
}

/** Per component, in order: the kind, the name, the value, then the floating pins. */
function diagnoseComponents(schematic: Schematic, options: ExtractOptions, groupOf: GroupOf): NetlistIssue[] {
  const issues: NetlistIssue[] = [];
  const seenNames = new Set<string>();
  for (const component of schematic.components) {
    const ref = component.name;
    if (kindRefused(component, options)) issues.push({ code: "kind_not_allowed", ref });
    const lowered = component.name.toLowerCase();
    if (seenNames.has(lowered)) issues.push({ code: "duplicate_name", ref });
    seenNames.add(lowered);
    const value = valueIssue(component.kind, component.value);
    if (value !== null) issues.push({ code: VALUE_ISSUE_CODE[value], ref });
    issues.push(...floatingPins(component, groupOf));
  }
  return issues;
}

/** Where a wire end claims to be attached; `null` for a pin that does not exist. */
function endLocation(end: SchematicWire["a"], schematic: Schematic): Point2 | null {
  if (end.kind === "free") return { x: end.x, y: end.y };
  if (end.kind === "port") return portLocation(end.port);
  const component = schematic.components.find((c) => c.id === end.c);
  const pin = component === undefined ? undefined : LIBRARY[component.kind].pins[end.p];
  return component === undefined || pin === undefined ? null : pinLocation(component, pin);
}

/**
 * The polyline is the geometry of record; `a`/`b` only say what the editor
 * MEANT to attach. When the two disagree the wire is reported and the
 * connectivity above still stands.
 */
function diagnoseWires(schematic: Schematic): NetlistIssue[] {
  const issues: NetlistIssue[] = [];
  for (const wire of schematic.wires) {
    const ends = endsOf(wire);
    const first = ends[0];
    const last = ends[ends.length - 1];
    const a = endLocation(wire.a, schematic);
    const b = endLocation(wire.b, schematic);
    const attached =
      a !== null && b !== null && first !== undefined && last !== undefined &&
      samePoint(a, first) && samePoint(b, last);
    if (!attached) issues.push({ code: "dangling_wire", ref: wire.id });
  }
  return issues;
}

/**
 * A port nobody wired. Under a common ground `in-` and `out-` are tied by the
 * harness itself, so they are never "unconnected": the pair always shares a
 * node.
 */
function diagnosePorts(groupOf: GroupOf): NetlistIssue[] {
  const issues: NetlistIssue[] = [];
  for (const port of PORT_IDS) {
    const group = groupOf(pinKey({ port }));
    if (group === undefined || (group.pins.length < 2 && group.wires === 0)) {
      issues.push({ code: "unconnected_port", ref: port });
    }
  }
  return issues;
}

/** The schematic-wide issues: no ground net at all, too many parts for the palette. */
function diagnoseSchematic(nets: readonly Net[], counted: number, palette: Palette | undefined): NetlistIssue[] {
  const issues: NetlistIssue[] = [];
  if (!nets.some((n) => n.name === "0")) issues.push({ code: "no_ground", ref: "" });
  if (palette !== undefined && counted > palette.maxComponents) {
    issues.push({ code: "too_many_components", ref: "" });
  }
  return issues;
}

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

  const pinNodes = collectNodes(schematic, dsu);
  unionWires(dsu, schematic.wires);
  unionPins(dsu, pinNodes, schematic.wires);
  const railKeys = railKeysOf(schematic, commonGround);
  tieRails(dsu, railKeys);
  const fixedName = assignNames(dsu, railKeys, commonGround);

  const groups = groupNodes(dsu, schematic, pinNodes);
  const { nets, netOfPin } = buildNets(groups, fixedName);

  const groupOf: GroupOf = (key) => groups.get(dsu.find(key));
  const counted = schematic.components.filter((c) => !LIBRARY[c.kind].terminal).length;
  const issues = [
    ...diagnoseComponents(schematic, options, groupOf),
    ...diagnoseWires(schematic),
    ...diagnosePorts(groupOf),
    ...diagnoseSchematic(nets, counted, options.palette),
  ];

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
