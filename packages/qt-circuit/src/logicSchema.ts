/**
 * The `logic` question type: schemas (docs/spec/04 §4.18, ADR-123).
 *
 * The teacher declares the inputs and the outputs, the key, the gates the
 * student may use and how many. The key is, for a COMBINATIONAL question,
 * one boolean expression per output or a reference circuit drawn on the
 * student's canvas (`keyFrom`); for a SEQUENTIAL one, test vectors
 * (`@quiz/domain/logic`'s `parseVectors`), steps run in order from the
 * initial state, whose outputs the reference circuit may fill (an authoring
 * aid: the vectors stay the key). The student
 * wires gates between the declared terminals on `circuit`'s canvas; the
 * answer is the schematic, and its netlist is rebuilt server-side at every
 * grade, never stored (`logicNetlist.ts`).
 *
 * Five shapes, one schema each, as `circuit` (`schema.ts`):
 * - {@link LogicConfig}   what the teacher authors (the expressions, the reference or the vectors are the key);
 * - {@link LogicAnswer}   the student's schematic;
 * - {@link LogicStudent}  what `toStudent` hands a student: never an expression, a vector nor the reference;
 * - {@link LogicSolution} the key: the expressions, or the vectors;
 * - {@link LogicDetails}  the breakdown stored in `gradings.details`.
 */
import { z } from "zod";

import {
  circuitKey,
  LOGIC_LIMITS,
  LogicError,
  parseExpression,
  parseVectors,
  toLatex,
  type LogicErrorCode,
  type TestVectors,
  type VectorErrorCode,
} from "@quiz/domain/logic";

import {
  GATE_FAMILIES,
  GATES,
  gateCount,
  initialTerminals,
  LOGIC_KINDS,
  LOGIC_PARTS,
  MEMORY_FAMILIES,
  TERMINAL_NAME_MAX,
} from "./logicLibrary.js";
import { buildLogicNetlist, portsMismatch } from "./logicNetlist.js";
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
 * constant cells, so at most `LOGIC_LIMITS.gates` of them, which is the
 * budget the canvas counts too (`gateCount`); the parts in all, terminals
 * and constants included, stay under the cells' and the ports' caps. Ids are
 * unique: a wire names its pin by its part's id.
 */
export const LogicSchematic = z
  .object({
    components: z.array(LogicComponent).max(LOGIC_LIMITS.components + LOGIC_LIMITS.inputs + LOGIC_LIMITS.outputs),
    wires: z.array(LogicWire).max(LOGIC_LIMITS.wires),
  })
  .refine((s) => gateCount(s) <= LOGIC_LIMITS.gates, { message: "logic.too_many_components", path: ["components"] })
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

/** The default palette: every gate of §4.18's list, the buffer left out, no memory. */
export const DEFAULT_FAMILIES: readonly GateFamilySchema[] = GATES.filter((f) => f !== "BUF");

export const LogicPalette = z.object({
  kinds: z.array(GateFamilySchema).min(1).max(GATE_FAMILIES.length),
  /** How many gates the student may place, `NOT` and `BUF` included; `null`: as many as the limits allow. */
  maxGates: z.number().int().min(1).max(LOGIC_LIMITS.gates).nullable().default(null),
});
export type LogicPalette = z.infer<typeof LogicPalette>;

export const LogicOutput = z.object({
  name: PortName,
  /** The output's boolean expression over the declared inputs: the key of a combinational question, unread otherwise. */
  expression: z.string().max(LOGIC_LIMITS.expressionLength).default(""),
});
export type LogicOutput = z.infer<typeof LogicOutput>;

export const LogicSymbols = z.enum(["iec", "ansi"]);
export type LogicSymbols = z.infer<typeof LogicSymbols>;

/** What the key is: an expression per output, or test vectors. */
export const LogicMode = z.enum(["combinational", "sequential"]);
export type LogicMode = z.infer<typeof LogicMode>;

/** Where a combinational question's expected outputs come from: the expressions, or the reference circuit. */
export const LogicKeyFrom = z.enum(["expressions", "reference"]);
export type LogicKeyFrom = z.infer<typeof LogicKeyFrom>;

export const LogicConfig = z
  .object({
    configVersion: z.literal(LOGIC_CONFIG_VERSION),
    prompt: z.string().min(1).max(20_000),
    symbols: LogicSymbols.default("iec"),
    mode: LogicMode.default("combinational"),
    /** Combinational only: the expressions are the key, or the reference circuit is. */
    keyFrom: LogicKeyFrom.default("expressions"),
    inputs: z.array(PortName).min(1).max(LOGIC_LIMITS.inputs),
    outputs: z.array(LogicOutput).min(1).max(LOGIC_LIMITS.outputs),
    /** The test vectors, the key of a sequential question; unread otherwise. */
    vectors: z.string().max(LOGIC_LIMITS.vectorLength).default(""),
    palette: LogicPalette.default({ kinds: [...DEFAULT_FAMILIES], maxGates: null }),
    /**
     * The teacher's circuit on the student's canvas, held to an answer's caps:
     * the key of a combinational question whose `keyFrom` is `reference`,
     * what fills the vectors' outputs of a sequential one. Never sent to a
     * student; its netlist is rebuilt at every use, never stored.
     */
    reference: LogicSchematic.nullable().default(null),
  })
  .superRefine((c, ctx) => {
    // Inputs and outputs are the ports of one netlist: one namespace.
    const seen = new Set<string>();
    const names: [string, (string | number)[]][] = [
      ...c.inputs.map((name, i): [string, (string | number)[]] => [name, ["inputs", i]]),
      ...c.outputs.map((o, i): [string, (string | number)[]] => [o.name, ["outputs", i, "name"]]),
    ];
    let duplicate = false;
    for (const [name, path] of names) {
      if (seen.has(name)) {
        duplicate = true;
        ctx.addIssue({ code: "custom", message: "logic.duplicate_name", path });
      }
      seen.add(name);
    }
    if (c.mode === "sequential") {
      const error = vectorsError(c.vectors, declaredOf(c));
      if (error !== null) ctx.addIssue({ code: "custom", message: error.code, path: ["vectors"], params: { line: error.position } });
      return;
    }
    if (c.keyFrom === "reference") {
      // Duplicate names already have their issue; the terminals cannot match them.
      const problem = duplicate ? null : (referencePortsProblem(c) ?? (hasMemory(c.reference!) ? "logic.reference_memory" : null));
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem, path: ["reference"] });
      return;
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
export const expressionError = (source: string, inputs: readonly string[]) =>
  logicErrorOf(() => parseExpression(source, inputs));

/** The code and position of the `LogicError` a parse throws, or `null` when it parses. */
function logicErrorOf(parse: () => unknown): { code: LogicErrorCode; position: number | null } | null {
  try {
    parse();
    return null;
  } catch (error) {
    if (error instanceof LogicError) return { code: error.code, position: error.position };
    throw error;
  }
}

/**
 * What keeps the reference from being read at all, or `null`: none drawn, or
 * terminals that differ from the declared ones. Cheap: the schema's refine
 * and "Use as reference" both ask it.
 */
export function referencePortsProblem(
  c: Pick<LogicConfig, "inputs" | "outputs" | "reference">,
): "logic.reference_missing" | "logic.reference_ports" | null {
  if (c.reference === null) return "logic.reference_missing";
  return portsMismatch(c.reference, declaredOf(c)) ? "logic.reference_ports" : null;
}

/**
 * A latch or a flip-flop: never in a combinational reference, whose rows each
 * start from a fresh state, and where a looped latch could spend the event
 * budget on every row.
 */
const hasMemory = (schematic: LogicSchematic): boolean =>
  schematic.components.some((c) => (MEMORY_FAMILIES as readonly string[]).includes(LOGIC_PARTS.part(c.kind).family ?? ""));

/**
 * The first row of the truth table on which a combinational reference reads
 * `X` or `Z` (`inputs[0]` the most significant bit), or `null`: up to 1 024
 * simulations, so it runs at publication and in the editor only
 * (`publicationIssues`), never on a read. The reference has passed
 * {@link referencePortsProblem}.
 */
export function referenceUndefinedRow(c: Pick<LogicConfig, "inputs" | "outputs"> & { reference: LogicSchematic }): number | null {
  try {
    circuitKey(buildLogicNetlist(c.reference).netlist, c.inputs, c.outputs.map((o) => o.name));
    return null;
  } catch (error) {
    if (error instanceof LogicError && error.code === "logic.reference_undefined") return error.position;
    throw error;
  }
}

/** The declared signals by name, as the vectors' header and the student view name them. */
export const declaredOf = (c: Pick<LogicConfig, "inputs" | "outputs">) => ({
  inputs: c.inputs,
  outputs: c.outputs.map((o) => o.name),
});

/**
 * What is wrong with test vectors over the declared signals, its `position`
 * the 1-based line (`null`: the text as a whole), or `null`: the config's
 * refine, and the editor's live line.
 */
export const vectorsError = (source: string, declared: { inputs: readonly string[]; outputs: readonly string[] }) =>
  logicErrorOf(() => parseVectors(source, declared)) as { code: VectorErrorCode; position: number | null } | null;

/**
 * The vectors as a Markdown table, the header first, or as typed in a code
 * block when they no longer parse: the review's and the debrief key's one
 * rendering.
 */
export function vectorsMarkdown(
  source: string,
  declared: { inputs: readonly string[]; outputs: readonly string[] },
): string {
  let vectors: TestVectors;
  try {
    vectors = parseVectors(source, declared);
  } catch {
    return `\`\`\`\n${source}\n\`\`\``;
  }
  const line = (cells: readonly (string | number)[]) => `| ${cells.join(" | ")} |`;
  return [
    line([...vectors.inputs, ...vectors.outputs]),
    line([...vectors.inputs, ...vectors.outputs].map(() => ":-:")),
    ...vectors.rows.map((row) => line([...row.inputs, ...row.outputs])),
  ].join("\n");
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
    mode: "combinational",
    inputs: ["a", "b"],
    outputs: [{ name: "y", expression: "" }],
    keyFrom: "expressions",
    vectors: "",
    palette: { kinds: [...DEFAULT_FAMILIES], maxGates: null },
    reference: null,
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

/** What a student receives: the names only, never an expression, a vector nor the reference. */
export const LogicStudent = z.object({
  prompt: z.string(),
  symbols: LogicSymbols,
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  palette: LogicPalette,
});
export type LogicStudent = z.infer<typeof LogicStudent>;

/**
 * The key: each output's expression (combinational), the test vectors
 * (sequential, `outputs` empty), or the reference circuit when it is the key
 * (`outputs` empty), drawn read-only where the expressions would be (as
 * `circuit`'s reference, ADR-037).
 */
export const LogicSolution = z.object({
  outputs: z.array(z.object({ name: z.string(), expression: z.string() })),
  vectors: z.string().optional(),
  reference: LogicSchematic.optional(),
});
export type LogicSolution = z.infer<typeof LogicSolution>;

// ---------------------------------------------------------------------------
// Grading details
// ---------------------------------------------------------------------------

/** How many failing rows the details keep (§4.18). */
export const FAILING_ROWS_MAX = 16;

const Level = z.union([z.literal(0), z.literal(1), z.literal("X"), z.literal("Z")]);
const Bit = z.union([z.literal(0), z.literal(1)]);

/**
 * One failing row of the truth table or of the vectors: the inputs (`C` a
 * clock pulse), the student's outputs, the expected ones (`X` not checked).
 */
export const LogicRow = z.object({
  inputs: z.array(z.union([Bit, z.literal("C")])),
  actual: z.array(Level),
  expected: z.array(z.union([Bit, z.literal("X")])),
});
export type LogicRow = z.infer<typeof LogicRow>;

export const LogicDetails = z.object({
  /** The inputs' and the outputs' names, in the order of a row's columns. */
  inputs: z.array(z.string()),
  outputs: z.array(z.object({ name: z.string(), rate: z.number() })),
  /** Rows whose every output is right, out of `total` (a step that checks no output is not counted). */
  right: z.number().int(),
  total: z.number().int(),
  /** At most {@link FAILING_ROWS_MAX}; only under a shown key for a student (`studentDetails`). */
  rows: z.array(LogicRow).optional(),
  /** `empty`, `palette_violation`, `ports_mismatch`: why nothing was simulated. */
  reason: z.string().optional(),
});
export type LogicDetails = z.infer<typeof LogicDetails>;
