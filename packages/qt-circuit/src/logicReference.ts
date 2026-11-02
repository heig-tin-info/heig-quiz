/**
 * The editor's side of a `logic` question's reference circuit (docs/spec/04
 * §4.18, ADR-123 amendment of 2026-11-02): its terminals follow the declared
 * inputs and outputs as the teacher edits them, and in sequential mode it
 * fills the test vectors' outputs ("Use as reference") through the very run
 * the grade makes (`fillVectors` through `runSteps`). The grade and the config's refine read the
 * reference through `logicSchema.ts` and `logicGrade.ts`, never through here.
 */
import { fillVectors } from "@quiz/domain/logic";

import { nextId } from "./canvas/geometry.js";
import { initialTerminals } from "./logicLibrary.js";
import { buildLogicNetlist } from "./logicNetlist.js";
import { declaredOf, referencePortsProblem, type LogicConfig, type LogicSchematic } from "./logicSchema.js";

type Declared = { inputs: readonly string[]; outputs: readonly string[] };

/**
 * The reference with its terminals moved from `before`'s declared names to
 * `after`'s. Same count and order: a rename, in place, its wires kept.
 * Otherwise by name: a terminal no longer declared goes with its wires, a
 * newly declared one is placed where a student's would start.
 */
export function fitTerminals(schematic: LogicSchematic, before: Declared, after: Declared): LogicSchematic {
  let components = schematic.components;
  const dropped = new Set<string>();
  const added: LogicSchematic["components"] = [];
  const start = initialTerminals(after.inputs, after.outputs);
  for (const [kind, prev, next] of [
    ["IN", before.inputs, after.inputs],
    ["OUT", before.outputs, after.outputs],
  ] as const) {
    const placed = components.filter((c) => c.kind === kind);
    if (prev.length === next.length && placed.length === prev.length && placed.every((c, i) => c.name === prev[i])) {
      const renamed = new Map(placed.map((c, i) => [c.id, next[i]!]));
      components = components.map((c) => (renamed.has(c.id) ? { ...c, name: renamed.get(c.id)! } : c));
      continue;
    }
    const kept = new Set<string>();
    for (const c of placed) {
      if (next.includes(c.name) && !kept.has(c.name)) kept.add(c.name);
      else dropped.add(c.id);
    }
    for (const name of new Set(next)) {
      if (kept.has(name)) continue;
      const at = start.find((t) => t.kind === kind && t.name === name)!;
      added.push({ ...at, id: nextId("c", [...components, ...added].map((c) => c.id)) });
    }
  }
  return {
    components: [...components.filter((c) => !dropped.has(c.id)), ...added],
    wires: schematic.wires.filter((w) => ![w.a, w.b].some((end) => end.kind === "pin" && dropped.has(end.c))),
  };
}

/** The vectors filled, or why the reference cannot fill them: the editor's "Use as reference". */
export type Filled = { vectors: string } | { problem: "logic.reference_missing" | "logic.reference_ports" };

/**
 * The vectors whose output columns the reference circuit wrote, on the
 * teacher's stimulus (`fillVectors`). Throws the `logic.vector_*` errors of
 * a stimulus it cannot read, and `logic.reference_undefined` (by line) for a
 * step on which the reference reads `X` or `Z`.
 */
export function vectorsFromReference(config: LogicConfig): Filled {
  const problem = referencePortsProblem(config);
  if (problem !== null) return { problem };
  return { vectors: fillVectors(config.vectors, declaredOf(config), buildLogicNetlist(config.reference!).netlist) };
}
