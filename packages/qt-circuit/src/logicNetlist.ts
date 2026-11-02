/**
 * A `logic` schematic becomes the netlist `@quiz/domain/logic` simulates
 * (ADR-123 §3): rebuilt from the stored schematic at every grade, never
 * stored, and the same function lights the student's wires in play mode.
 *
 * Connectivity is `circuit`'s, read from the routed polylines alone
 * (`netlist.ts`): a pin on a wire's end, a wire's end on another wire, two
 * pins on one point. A declared input is an input port, a declared output an
 * output port, each named by the terminal; every gate is a cell, and each constant level one more.
 * A pin nothing reaches is a net of its own that nobody drives: it reads `Z`,
 * an unfinished circuit still simulates and its outputs read `X`.
 *
 * Before any of that, two verdicts the grader needs (§4.18):
 * {@link portsMismatch} — the placed terminals differ from the declared ones,
 * or a wire claims a pin that does not exist — and {@link paletteViolation}.
 */
import type { CellType, Netlist, NetlistCell } from "@quiz/domain/logic";

import { gateCount, LOGIC_PARTS } from "./logicLibrary.js";
import type { LogicPalette, LogicSchematic } from "./logicSchema.js";
import { connect, pinLocation } from "./netlist.js";

export interface LogicNetlist {
  netlist: Netlist;
  /** The net each wire belongs to, by wire id: what play mode colours. */
  netOfWire: ReadonlyMap<string, string>;
}

const pinKey = (c: string, p: number): string => `${c}:${p}`;

/**
 * Every `LOW` part is one net, driven by one `$const0` cell, and every `HIGH`
 * part another, as `circuit`'s ground symbols are one net: a constant is a
 * terminal, never counted, and an answer holds at most two constant cells.
 */
const CONSTANT_CELLS: readonly { kind: "LOW" | "HIGH"; cell: CellType }[] = [
  { kind: "LOW", cell: "$const0" },
  { kind: "HIGH", cell: "$const1" },
];

export function buildLogicNetlist(schematic: LogicSchematic): LogicNetlist {
  const pins = schematic.components.flatMap((component) =>
    LOGIC_PARTS.part(component.kind).pins.map((pin, p) => ({ key: pinKey(component.id, p), at: pinLocation(component, pin) })),
  );
  const rails = CONSTANT_CELLS.map(({ kind }) =>
    schematic.components.filter((c) => c.kind === kind).map((c) => pinKey(c.id, 0)),
  );
  const { netOf, netOfWire } = connect(pins, schematic.wires, rails);

  const ports: Record<string, Netlist["ports"][string]> = {};
  const cells: Record<string, NetlistCell> = {};
  for (const component of schematic.components) {
    const spec = LOGIC_PARTS.part(component.kind);
    if (spec.cell === null) {
      ports[component.name] = { direction: component.kind === "IN" ? "input" : "output", net: netOf(pinKey(component.id, 0)) };
    } else if (spec.family !== null) {
      const connections: Record<string, string> = {};
      spec.pins.forEach((pin, p) => (connections[pin.name] = netOf(pinKey(component.id, p))));
      cells[component.id] = spec.width > 1 ? { type: spec.cell, connections, params: { width: spec.width } } : { type: spec.cell, connections };
    }
  }
  CONSTANT_CELLS.forEach(({ kind, cell }, i) => {
    const first = rails[i]?.[0];
    if (first !== undefined) cells[kind] = { type: cell, connections: { Y: netOf(first) } };
  });
  return {
    netlist: { ports, cells },
    netOfWire: new Map(schematic.wires.map((wire) => [wire.id, netOfWire(wire.id)])),
  };
}

/** Whether `names` holds each of `declared` exactly once and nothing else. */
const sameNames = (names: readonly string[], declared: readonly string[]): boolean =>
  names.length === declared.length && new Set(names).size === names.length && declared.every((n) => names.includes(n));

/**
 * The placed terminals are not the declared ones — one missing, one twice,
 * one undeclared — or a wire claims a pin no part has: the editor cannot
 * produce it, so the answer is stale or forged and is never simulated.
 */
export function portsMismatch(
  schematic: LogicSchematic,
  declared: { inputs: readonly string[]; outputs: readonly string[] },
): boolean {
  const named = (kind: string) => schematic.components.filter((c) => c.kind === kind).map((c) => c.name);
  if (!sameNames(named("IN"), declared.inputs) || !sameNames(named("OUT"), declared.outputs)) return true;
  const pins = new Map(schematic.components.map((c) => [c.id, LOGIC_PARTS.part(c.kind).pins.length]));
  return schematic.wires.some((wire) =>
    [wire.a, wire.b].some((end) => end.kind === "pin" && !(end.p < (pins.get(end.c) ?? 0))),
  );
}

/** A gate outside the allowed families, or more gates than `maxGates`. */
export function paletteViolation(schematic: LogicSchematic, palette: LogicPalette): boolean {
  if (palette.maxGates !== null && gateCount(schematic) > palette.maxGates) return true;
  return schematic.components.some((c) => {
    const family = LOGIC_PARTS.part(c.kind).family;
    return family !== null && !palette.kinds.includes(family);
  });
}
