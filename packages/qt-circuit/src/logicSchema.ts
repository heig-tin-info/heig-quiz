/**
 * The `logic` question type: schemas (docs/spec/04 §4.18, ADR-123).
 *
 * The teacher declares the inputs and the outputs, one boolean expression per
 * output (the key), the gates the student may use and how many. The student
 * wires gates between the declared terminals on `circuit`'s canvas; the
 * answer is the schematic, and its netlist is rebuilt server-side at every
 * grade, never stored (`logicNetlist.ts`).
 *
 * Five shapes, one schema each, as `circuit` (`schema.ts`):
 * - {@link LogicConfig}   what the teacher authors (the expressions are the key);
 * - {@link LogicAnswer}   the student's schematic;
 * - {@link LogicStudent}  what `toStudent` hands a student: never an expression;
 * - {@link LogicSolution} the key: the expressions;
 * - {@link LogicDetails}  the breakdown stored in `gradings.details`.
 */
import { z } from "zod";

import { LOGIC_LIMITS, LogicError, parseExpression, toLatex } from "@quiz/domain/logic";

import {
  GATE_FAMILIES,
  gateCount,
  initialTerminals,
  LOGIC_GATES_MAX,
  LOGIC_KINDS,
  LOGIC_PARTS,
  TERMINAL_NAME_MAX,
} from "./logicLibrary.js";
import { FreeEnd, PinEnd, SchematicComponent, wireOf } from "./schema.js";

export const LOGIC_CONFIG_VERSION = 1;

// ---------------------------------------------------------------------------
// Schematic
// ---------------------------------------------------------------------------

export const LogicComponent = SchematicComponent.extend({ kind: z.enum(LOGIC_KINDS) });
export type LogicComponent = z.infer<typeof LogicComponent>;

/** A wire ends on a pin or at a free point: the logic box has no port on its border. */
export const LogicWire = wireOf(z.discriminatedUnion("kind", [PinEnd, FreeEnd]));
export type LogicWire = z.infer<typeof LogicWire>;

const unique = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

/**
 * Held to `LOGIC_LIMITS`: the gates are the netlist's cells beside the two
 * constant cells, so at most {@link LOGIC_GATES_MAX} of them, which is the
 * budget the canvas counts too (`gateCount`); the parts in all, terminals
 * and constants included, stay under the cells' and the ports' caps. Ids are
 * unique: a wire names its pin by its part's id.
 */
export const LogicSchematic = z
  .object({
    components: z.array(LogicComponent).max(LOGIC_LIMITS.components + LOGIC_LIMITS.inputs + LOGIC_LIMITS.outputs),
    wires: z.array(LogicWire).max(LOGIC_LIMITS.wires),
  })
  .refine((s) => gateCount(s) <= LOGIC_GATES_MAX, { message: "logic.too_many_components", path: ["components"] })
  .refine((s) => unique(s.components.map((c) => c.id)) && unique(s.wires.map((w) => w.id)), {
    message: "logic.duplicate_id",
  });
export type LogicSchematic = z.infer<typeof LogicSchematic>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** An input's or an output's name: an identifier of the expression grammar, short enough for its pill. */
export const PortName = z
  .string()
  .min(1)
  .max(TERMINAL_NAME_MAX)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, { message: "logic.name_invalid" });

export const GateFamilySchema = z.enum(GATE_FAMILIES);
export type GateFamilySchema = z.infer<typeof GateFamilySchema>;

/** The default palette: every gate of §4.18's list, the buffer left out. */
export const DEFAULT_FAMILIES: readonly GateFamilySchema[] = GATE_FAMILIES.filter((f) => f !== "BUF");

export const LogicPalette = z.object({
  kinds: z.array(GateFamilySchema).min(1).max(GATE_FAMILIES.length),
  /** How many gates the student may place, `NOT` and `BUF` included; `null`: as many as the limits allow. */
  maxGates: z.number().int().min(1).max(LOGIC_GATES_MAX).nullable().default(null),
});
export type LogicPalette = z.infer<typeof LogicPalette>;

export const LogicOutput = z.object({
  name: PortName,
  /** The output's boolean expression over the declared inputs: the key. */
  expression: z.string().min(1).max(LOGIC_LIMITS.expressionLength),
});
export type LogicOutput = z.infer<typeof LogicOutput>;

export const LogicSymbols = z.enum(["iec", "ansi"]);
export type LogicSymbols = z.infer<typeof LogicSymbols>;

export const LogicConfig = z
  .object({
    configVersion: z.literal(LOGIC_CONFIG_VERSION),
    prompt: z.string().min(1).max(20_000),
    symbols: LogicSymbols.default("iec"),
    inputs: z.array(PortName).min(1).max(LOGIC_LIMITS.inputs),
    outputs: z.array(LogicOutput).min(1).max(LOGIC_LIMITS.outputs),
    palette: LogicPalette.default({ kinds: [...DEFAULT_FAMILIES], maxGates: null }),
  })
  .superRefine((c, ctx) => {
    // Inputs and outputs are the ports of one netlist: one namespace.
    const seen = new Set<string>();
    const names: [string, (string | number)[]][] = [
      ...c.inputs.map((name, i): [string, (string | number)[]] => [name, ["inputs", i]]),
      ...c.outputs.map((o, i): [string, (string | number)[]] => [o.name, ["outputs", i, "name"]]),
    ];
    for (const [name, path] of names) {
      if (seen.has(name)) ctx.addIssue({ code: "custom", message: "logic.duplicate_name", path });
      seen.add(name);
    }
    c.outputs.forEach((output, i) => {
      const error = expressionError(output.expression, c.inputs);
      if (error !== null) {
        ctx.addIssue({
          code: "custom",
          message: error.code,
          path: ["outputs", i, "expression"],
          params: { position: error.position },
        });
      }
    });
  });
export type LogicConfig = z.infer<typeof LogicConfig>;

/**
 * What is wrong with an expression over the declared inputs, with its
 * position, or `null`: the config's refine, and the editor's live line.
 */
export function expressionError(
  source: string,
  inputs: readonly string[],
): { code: "logic.expression_invalid" | "logic.unknown_identifier"; position: number | null } | null {
  try {
    parseExpression(source, inputs);
    return null;
  } catch (error) {
    if (error instanceof LogicError && error.code === "logic.unknown_identifier") {
      return { code: error.code, position: error.position };
    }
    return { code: "logic.expression_invalid", position: error instanceof LogicError ? error.position : null };
  }
}

/**
 * `m = a \cdot b + …`, the KaTeX source of an output's equation (no
 * delimiters), or `null` when the expression no longer parses: the editor's
 * preview, the review's and the debrief key's one rendering.
 */
export function expressionLatex(name: string, expression: string, inputs?: readonly string[]): string | null {
  try {
    return `${toLatex({ kind: "var", name })} = ${toLatex(parseExpression(expression, inputs))}`;
  } catch {
    return null;
  }
}

/** A fresh draft: two inputs and one output whose expression the teacher writes (D16: it need not validate). */
export function emptyLogicConfig(): LogicConfig {
  return {
    configVersion: LOGIC_CONFIG_VERSION,
    prompt: "",
    symbols: "iec",
    inputs: ["a", "b"],
    outputs: [{ name: "y", expression: "" }],
    palette: { kinds: [...DEFAULT_FAMILIES], maxGates: null },
  };
}

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

export const LogicAnswer = z.object({ schematic: LogicSchematic });
export type LogicAnswer = z.infer<typeof LogicAnswer>;

/** The declared terminals where they start, nothing else: what a student opens. */
export function initialLogicAnswer(student: { inputs: readonly string[]; outputs: readonly string[] }): LogicAnswer {
  return { schematic: { components: initialTerminals(student.inputs, student.outputs), wires: [] } };
}

/**
 * Whether the student did something: a gate, a constant or a wire. The
 * terminals the question placed are not an answer (issue #89): the ONE
 * predicate behind both `isAnswered` hooks.
 */
export function isLogicAnswered(answer: LogicAnswer): boolean {
  return answer.schematic.wires.length > 0 || answer.schematic.components.some((c) => LOGIC_PARTS.part(c.kind).locked !== true);
}

// ---------------------------------------------------------------------------
// Student view and key
// ---------------------------------------------------------------------------

/** What a student receives: the names only, never an expression. */
export const LogicStudent = z.object({
  prompt: z.string(),
  symbols: LogicSymbols,
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  palette: LogicPalette,
});
export type LogicStudent = z.infer<typeof LogicStudent>;

/** The key: each output's expression. */
export const LogicSolution = z.object({
  outputs: z.array(z.object({ name: z.string(), expression: z.string() })),
});
export type LogicSolution = z.infer<typeof LogicSolution>;

// ---------------------------------------------------------------------------
// Grading details
// ---------------------------------------------------------------------------

/** How many failing rows the details keep (§4.18). */
export const FAILING_ROWS_MAX = 16;

const Level = z.union([z.literal(0), z.literal(1), z.literal("X"), z.literal("Z")]);
const Bit = z.union([z.literal(0), z.literal(1)]);

/** One failing row of the truth table: the inputs, the student's outputs, the expected ones. */
export const LogicRow = z.object({
  inputs: z.array(Bit),
  actual: z.array(Level),
  expected: z.array(Bit),
});
export type LogicRow = z.infer<typeof LogicRow>;

export const LogicDetails = z.object({
  /** The inputs' and the outputs' names, in the order of a row's columns. */
  inputs: z.array(z.string()),
  outputs: z.array(z.object({ name: z.string(), rate: z.number() })),
  /** Rows whose every output is right, out of `total`. */
  right: z.number().int(),
  total: z.number().int(),
  /** At most {@link FAILING_ROWS_MAX}; only under a shown key for a student (`studentDetails`). */
  rows: z.array(LogicRow).optional(),
  /** `empty`, `palette_violation`, `ports_mismatch`: why nothing was simulated. */
  reason: z.string().optional(),
});
export type LogicDetails = z.infer<typeof LogicDetails>;
