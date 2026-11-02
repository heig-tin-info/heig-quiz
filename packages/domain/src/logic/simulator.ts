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
 * MEMORY. A latch or a flip-flop holds a state, 0 in a fresh simulator, and
 * drives it on `Q` (its complement on `QN`) at each evaluation. A latch
 * computes its next state whenever it is evaluated; a flip-flop only when
 * its clock, last seen at 0, now reads 1. A flip-flop samples what its data
 * inputs read at that step, before anything the edge causes takes effect: a
 * chain of flip-flops on one clock shifts.
 *
 * BUDGET. An EVENT is one net changing value. `settle` steps until nothing
 * is pending, and never processes more than `LOGIC_LIMITS.eventsPerRow`
 * events: a step that could cross the budget is not taken. Feedback is legal
 * (a NOR-built latch holds), so a circuit may never settle; when the budget
 * is exhausted, every net that changed within the last half of it, or still
 * has a change pending, is OSCILLATING: it is set to `X` directly (with the
 * cell drivers on it, and the state of a latch or a flip-flop driving it),
 * the pending changes are dropped, and the result names those nets.
 * Nothing toggled is left at 0 or 1. Every cell is then due, so
 * the next settle starts from a full evaluation. Catching a slow ring rests
 * on arithmetic: with `LOGIC_LIMITS.components` cells, a ring's period times
 * the events per step stays under half the budget (about 930 of 1 000), so
 * every ring net changes within the window; recheck it if a limit changes.
 * A cell fed by two oscillating nets whose effects cancel (`XOR(y, y)`)
 * keeps its last 0/1 at the cut-off and reads `X` only from the next
 * settle on: it is not itself changing, which is what the rule names.
 *
 * Under constant inputs a fresh circuit of gates never oscillates: every
 * gate is monotone over 0/1/X and the nets start at X, so a net only goes
 * from X to its final value. An oscillation needs an input to change mid-run
 * (play mode, a step of test vectors) or a memory cell, which starts at 0,
 * in a loop (a transparent latch fed its own complement).
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
  type CellKind,
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
  readonly kind: CellKind;
  /** Net index per input port, -1 when unconnected; a flip-flop's clock is the last. */
  readonly inputs: number[];
  /** Driver slot per output port (`Y`, or `Q` then `QN`), -1 when unconnected. */
  readonly outputs: number[];
  /** Over the data inputs (all but a flip-flop's `CLK`), then the state for a latch or a flip-flop. */
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
  /** The cell a driver slot belongs to, -1 for an input port. */
  const slotCell: number[] = [];
  const slot = (n: number, cell: number): number => {
    const s = slotNet.push(n) - 1;
    slotCell.push(cell);
    drivers[n]!.push(s);
    return s;
  };
  const wire = (c: NetlistCell["connections"], port: string): NetId | undefined =>
    Object.hasOwn(c, port) ? c[port] : undefined;

  const inputSlot = new Map<string, number>();
  const outputNet = new Map<string, number>();
  for (const [name, port] of Object.entries(netlist.ports)) {
    if (port.direction === "input") inputSlot.set(name, slot(net(port.net), -1));
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
    const { kind, outputs: ports } = CELL_SPECS[c.type];
    const outputs = ports.map((port) => {
      const id = wire(c.connections, port);
      return id === undefined ? -1 : slot(net(id), index);
    });
    // A latch's table reads its state after its inputs; a flip-flop's reads it in place of its clock.
    return { kind, inputs, outputs, table: liftedTable(c.type, kind === "latch" ? inputs.length + 1 : inputs.length) };
  });

  const createSimulator = (): Simulator => {
    const slotValue = new Uint8Array(slotNet.length).fill(X);
    const netValue = Uint8Array.from(drivers, (d) => (d.length === 0 ? Z : X));
    const lastChange = new Float64Array(netIds.length);
    /** Per cell: a latch's or a flip-flop's state, and the clock a flip-flop last saw. */
    const state = Uint8Array.from(cells, (c) => (c.kind === "comb" ? X : 0));
    const clock = new Uint8Array(cells.length).fill(X);
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

    /** A net as a cell input reads it: `Z` and an unconnected input read `X`. */
    const level = (n: number): number => {
      const v = n < 0 ? X : netValue[n]!;
      return v > 1 ? X : v;
    };

    const evaluate = (c: number): void => {
      const { kind, inputs, outputs, table } = cells[c]!;
      const data = kind === "flop" ? inputs.length - 1 : inputs.length;
      let index = 0;
      let weight = 1;
      for (let i = 0; i < data; i++) {
        index += level(inputs[i]!) * weight;
        weight *= 3;
      }
      const y = outputs[0]!;
      if (kind === "comb") {
        if (y >= 0) schedule(y, table[index]!);
        return;
      }
      if (kind === "latch") state[c] = table[index + state[c]! * weight]!;
      else {
        const edge = level(inputs[data]!);
        if (clock[c] === 0 && edge === 1) state[c] = table[index + state[c]! * weight]!;
        clock[c] = edge;
      }
      const q = state[c]!;
      const yn = outputs[1]!;
      if (y >= 0) schedule(y, q);
      if (yn >= 0) schedule(yn, q === X ? X : 1 - q);
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
        for (const s of drivers[n]!) {
          const c = slotCell[s]!;
          if (c < 0) continue;
          slotValue[s] = X;
          state[c] = X;
        }
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
