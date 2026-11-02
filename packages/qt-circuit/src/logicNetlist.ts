/**
 * A `logic` schematic becomes the netlist `@quiz/domain/logic` simulates
 * (ADR-123 §3): rebuilt from the stored schematic at every grade, never
 * stored, and the same function lights the student's wires in play mode.
 *
 * Connectivity is `circuit`'s, read from the routed polylines alone
 * (`netlist.ts`): a pin on a wire's end, a wire's end on another wire, two
 * pins on one point. A declared input is an input port, a declared output an
 * output port, each named by the terminal; every gate and constant is a cell.
 * A pin nothing reaches is a net of its own that nobody drives: it reads `Z`,
 * an unfinished circuit still simulates and its outputs read `X`.
 *
 * Before any of that, two verdicts the grader needs (§4.18):
 * {@link portsMismatch} — the placed terminals differ from the declared ones,
 * or a wire claims a pin that does not exist — and {@link paletteViolation}.
 */
import type { Netlist, NetlistCell } from "@quiz/domain/logic";

import { LOGIC_PARTS } from "./logicLibrary.js";
import type { LogicPalette, LogicSchematic } from "./logicSchema.js";
import { isGateKind } from "./logicSchema.js";
import { Dsu, pinLocation, unionPins, unionWires, wireKey } from "./netlist.js";

export interface LogicNetlist {
  netlist: Netlist;
  /** The net each wire belongs to, by wire id: what play mode colours. */
  netOfWire: ReadonlyMap<string, string>;
}

const pinKey = (c: string, p: number): string => `${c}:${p}`;

export function buildLogicNetlist(schematic: LogicSchematic): LogicNetlist {
  const dsu = new Dsu();
  const pinNodes = schematic.components.flatMap((component) =>
    LOGIC_PARTS.part(component.kind).pins.map((pin, p) => {
      const key = pinKey(component.id, p);
      dsu.add(key);
      return { key, at: pinLocation(component, pin) };
    }),
  );
  for (const wire of schematic.wires) dsu.add(wireKey(wire.id));
  unionWires(dsu, schematic.wires);
  unionPins(dsu, pinNodes, schematic.wires);

  const net = (c: string, p: number): string => dsu.find(pinKey(c, p));
  const ports: Record<string, Netlist["ports"][string]> = {};
  const cells: Record<string, NetlistCell> = {};
  for (const component of schematic.components) {
    const spec = LOGIC_PARTS.part(component.kind);
    if (spec.cell === null) {
      ports[component.name] = { direction: component.kind === "IN" ? "input" : "output", net: net(component.id, 0) };
      continue;
    }
    const connections: Record<string, string> = {};
    spec.pins.forEach((pin, p) => (connections[pin.name] = net(component.id, p)));
    cells[component.id] = spec.width > 1 ? { type: spec.cell, connections, params: { width: spec.width } } : { type: spec.cell, connections };
  }
  return {
    netlist: { ports, cells },
    netOfWire: new Map(schematic.wires.map((wire) => [wire.id, dsu.find(wireKey(wire.id))])),
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
  const gates = schematic.components.filter((c) => isGateKind(c.kind));
  if (palette.maxGates !== null && gates.length > palette.maxGates) return true;
  return gates.some((c) => {
    const family = LOGIC_PARTS.part(c.kind).family;
    return family === null || !palette.kinds.includes(family);
  });
}
