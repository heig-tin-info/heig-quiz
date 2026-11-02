/**
 * The logic engine (issue #459, ADR-123): event-driven, four values, unit
 * delay. The same code animates play mode in the browser and grades on the
 * server.
 *
 * COMPILING. `compileNetlist` validates a netlist once and builds its
 * topology; `createSimulator()` on the result makes a fresh simulator, as
 * many times as needed (grading makes one per row).
 *
 * STATE. A DRIVER is a cell output or an input port; each holds a value. A
 * net's value is the resolution of its drivers: `Z` yields, equal values
 * agree, a conflict is `X`. A fresh simulator has every driver at `X` (so
 * every driven net reads `X`, an undriven one `Z`) and every cell due for
 * evaluation.
 *
 * TIME. One step is one unit of delay: the pending driver changes (inputs
 * set since the last step, outputs computed on the previous one) take
 * effect, then the cells whose inputs changed are evaluated; what they now
 * drive takes effect on the next step. Inputs set on a fresh simulator are
 * therefore seen by the very first evaluation. An evaluation that brings an
 * output back to its current value cancels the pending change (a glitch
 * shorter than the delay vanishes).
 *
 * BUDGET. An EVENT is one net changing value. `settle` steps until nothing
 * is pending, and never processes more than `LOGIC_LIMITS.eventsPerRow`
 * events: a step that could cross the budget is not taken. Feedback is legal
 * (a NOR-built latch holds), so a circuit may never settle; when the budget
 * is exhausted, every net that changed within the last half of it, or still
 * has a change pending, is OSCILLATING: it is set to `X` directly (with the
 * cell drivers on it), the pending changes are dropped, and the result names
 * those nets. Nothing toggled is left at 0 or 1. Every cell is then due, so
 * the next settle starts from a full evaluation. Catching a slow ring rests
 * on arithmetic: with `LOGIC_LIMITS.components` cells, a ring's period times
 * the events per step stays under half the budget (about 930 of 1 000), so
 * every ring net changes within the window; recheck it if a limit changes.
 * A cell fed by two oscillating nets whose effects cancel (`XOR(y, y)`)
 * keeps its last 0/1 at the cut-off and reads `X` only from the next
 * settle on: it is not itself changing, which is what the rule names.
 *
 * Under constant inputs a fresh simulator never oscillates: every cell is
 * monotone over 0/1/X and the nets start at X, so a net only goes from X to
 * its final value. An oscillation needs an input to change mid-run (play
 * mode).
 *
 * The run is deterministic: cells, nets and pending changes are visited in
 * insertion order, which is the netlist's key order. Inside, a value is a
 * small integer code in typed arrays: grading runs this loop millions of
 * times.
 */
import {
  CELL_SPECS,
  cellInputs,
  LOGIC_LIMITS,
  LogicError,
  validateNetlist,
  type Bit,
  type CellType,
  type Netlist,
  type NetlistCell,
  type NetId,
  type Value,
} from "./netlist.js";

export interface SettleResult {
  /** The nets set to `X` because the event budget ran out; empty when the circuit settled. */
  readonly oscillating: NetId[];
  /** The events this settle processed, at most `LOGIC_LIMITS.eventsPerRow`. */
  readonly events: number;
}

export interface Simulator {
  /** Drives input ports; the change takes effect on the next `settle`. */
  set(inputs: Readonly<Record<string, Value>>): void;
  settle(): SettleResult;
  /** The value of every output port. */
  read(): Record<string, Value>;
  /** The value of every net, to colour the wires. */
  nets(): Record<NetId, Value>;
}

export interface CompiledNetlist {
  /** A fresh simulator of the netlist. */
  createSimulator(): Simulator;
}

/** The value codes: 0, 1, X = 2, Z = 3; `NONE` marks a driver with nothing pending. */
const X = 2;
const Z = 3;
const NONE = 255;
const VALUES: readonly Value[] = [0, 1, "X", "Z"];

const tables = new Map<string, Uint8Array>();

/**
 * A cell's function over every combination of 0/1/X inputs, the entry of
 * codes c0, c1… at Σ ci·3^i. An entry tries every 0/1 substitution of the
 * unknown inputs: the common result, else `X` — exact for one cell (`0 AND X`
 * is 0, `X XOR X` is X). Memoized by type and arity, a bounded set.
 */
function liftedTable(type: CellType, arity: number): Uint8Array {
  const key = `${type}/${arity}`;
  let table = tables.get(key);
  if (!table) {
    const { fn } = CELL_SPECS[type];
    table = Uint8Array.from({ length: 3 ** arity }, (_, index) => {
      const digits = Array.from({ length: arity }, (_, i) => Math.floor(index / 3 ** i) % 3);
      const unknown = digits.flatMap((d, i) => (d === X ? [i] : []));
      const bits = digits.map((d) => (d === 1 ? 1 : 0)) as Bit[];
      let result: Value | undefined;
      for (let mask = 0; mask < 1 << unknown.length; mask++) {
        unknown.forEach((i, k) => (bits[i] = ((mask >> k) & 1) as Bit));
        const r = fn(bits);
        if (result !== undefined && r !== result) return X;
        result = r;
      }
      return VALUES.indexOf(result!);
    });
    tables.set(key, table);
  }
  return table;
}

interface Cell {
  /** Net index per input port, -1 when unconnected. */
  readonly inputs: number[];
  /** Driver slot of `Y`, -1 when unconnected. */
  readonly output: number;
  readonly table: Uint8Array;
}

export function compileNetlist(netlist: Netlist): CompiledNetlist {
  const issues = validateNetlist(netlist);
  if (issues.length > 0) throw new LogicError("logic.netlist_invalid", null, issues.map((i) => i.code).join(", "));

  const netIds: NetId[] = [];
  const netIndex = new Map<NetId, number>();
  const readers: number[][] = [];
  const drivers: number[][] = [];
  const net = (id: NetId): number => {
    let index = netIndex.get(id);
    if (index === undefined) {
      index = netIds.push(id) - 1;
      netIndex.set(id, index);
      readers.push([]);
      drivers.push([]);
    }
    return index;
  };
  const slotNet: number[] = [];
  const cellSlot: boolean[] = [];
  const slot = (n: number, ofCell: boolean): number => {
    const s = slotNet.push(n) - 1;
    cellSlot.push(ofCell);
    drivers[n]!.push(s);
    return s;
  };
  const wire = (c: NetlistCell["connections"], port: string): NetId | undefined =>
    Object.hasOwn(c, port) ? c[port] : undefined;

  const inputSlot = new Map<string, number>();
  const outputNet = new Map<string, number>();
  for (const [name, port] of Object.entries(netlist.ports)) {
    if (port.direction === "input") inputSlot.set(name, slot(net(port.net), false));
    else outputNet.set(name, net(port.net));
  }
  const cells: Cell[] = Object.values(netlist.cells).map((c, index) => {
    const inputs = cellInputs(c).map((port) => {
      const id = wire(c.connections, port);
      if (id === undefined) return -1;
      const n = net(id);
      readers[n]!.push(index);
      return n;
    });
    const y = wire(c.connections, "Y");
    return { inputs, output: y === undefined ? -1 : slot(net(y), true), table: liftedTable(c.type, inputs.length) };
  });

  const createSimulator = (): Simulator => {
    const slotValue = new Uint8Array(slotNet.length).fill(X);
    const netValue = Uint8Array.from(drivers, (d) => (d.length === 0 ? Z : X));
    const lastChange = new Float64Array(netIds.length);
    let events = 0;
    /** The code a driver takes on the next step, `NONE` when nothing is pending (a listed slot may be cancelled). */
    const pendingValue = new Uint8Array(slotNet.length).fill(NONE);
    let pendingSlots: number[] = [];
    const isDue = new Uint8Array(cells.length).fill(1);
    let dueCells: number[] = [...cells.keys()];

    const schedule = (s: number, v: number): void => {
      if (v === slotValue[s]) {
        pendingValue[s] = NONE;
        return;
      }
      if (pendingValue[s] === NONE) pendingSlots.push(s);
      pendingValue[s] = v;
    };

    const evaluate = (c: number): void => {
      const { inputs, output, table } = cells[c]!;
      let index = 0;
      let weight = 1;
      for (const n of inputs) {
        const v = n < 0 ? X : netValue[n]!;
        index += (v > 1 ? X : v) * weight;
        weight *= 3;
      }
      if (output >= 0) schedule(output, table[index]!);
    };

    const update = (n: number): void => {
      let v = Z;
      for (const s of drivers[n]!) {
        const d = slotValue[s]!;
        if (d === Z) continue;
        if (v === Z) v = d;
        else if (v !== d) {
          v = X;
          break;
        }
      }
      if (v === netValue[n]) return;
      netValue[n] = v;
      lastChange[n] = ++events;
      for (const c of readers[n]!) {
        if (isDue[c]) continue;
        isDue[c] = 1;
        dueCells.push(c);
      }
    };

    /** One step, unless it is idle or could cross `limit` (one event per changing driver at most). */
    const step = (limit: number): "idle" | "stepped" | "exhausted" => {
      let changes = 0;
      for (const s of pendingSlots) if (pendingValue[s] !== NONE) changes++;
      if (changes === 0 && dueCells.length === 0) return "idle";
      if (events + changes > limit) return "exhausted";
      const slots = pendingSlots;
      pendingSlots = [];
      const nets: number[] = [];
      for (const s of slots) {
        const v = pendingValue[s]!;
        if (v === NONE) continue;
        pendingValue[s] = NONE;
        slotValue[s] = v;
        nets.push(slotNet[s]!);
      }
      // Every driver first, then the nets: a net with two changing drivers resolves once.
      for (const n of nets) update(n);
      const evaluating = dueCells;
      dueCells = [];
      for (const c of evaluating) {
        isDue[c] = 0;
        evaluate(c);
      }
      return "stepped";
    };

    const settle = (): SettleResult => {
      const start = events;
      const limit = start + LOGIC_LIMITS.eventsPerRow;
      let outcome = step(limit);
      while (outcome === "stepped") outcome = step(limit);
      if (outcome === "idle") return { oscillating: [], events: events - start };
      const since = limit - Math.floor(LOGIC_LIMITS.eventsPerRow / 2);
      const hot = new Set(netIds.flatMap((_, n) => (lastChange[n]! > since ? [n] : [])));
      for (const s of pendingSlots) if (pendingValue[s] !== NONE) hot.add(slotNet[s]!);
      pendingValue.fill(NONE);
      pendingSlots = [];
      for (const n of hot) {
        netValue[n] = X;
        for (const s of drivers[n]!) if (cellSlot[s]) slotValue[s] = X;
      }
      isDue.fill(1);
      dueCells = [...cells.keys()];
      return { oscillating: [...hot].sort((a, b) => a - b).map((n) => netIds[n]!), events: events - start };
    };

    return {
      set(inputs) {
        for (const [name, v] of Object.entries(inputs)) {
          const s = inputSlot.get(name);
          if (s === undefined) throw new LogicError("logic.unknown_input", null, name);
          const code = VALUES.indexOf(v);
          if (code < 0) throw new LogicError("logic.bad_value", null, String(v));
          schedule(s, code);
        }
      },
      settle,
      read: () => Object.fromEntries([...outputNet].map(([name, n]) => [name, VALUES[netValue[n]!]!])),
      nets: () => Object.fromEntries(netIds.map((id, n) => [id, VALUES[netValue[n]!]!])),
    };
  };
  return { createSimulator };
}
