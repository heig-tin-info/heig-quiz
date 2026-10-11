/**
 * The `math` schemas (docs/spec/04 §4.16, ADR-102).
 *
 * The question declares its SYMBOLS (`x`, `R_1`…) with the interval each is
 * sampled in, and its accepted ANSWERS as LaTeX, each worth a fraction of
 * the item. Whether a key actually reads against the symbols is checked at
 * publication (`publicationIssues`, `server.ts`), never here: this schema is
 * also every read's, and a draft is stored invalid by design (D16).
 */
import { MATH_FUNCTIONS, MATH_MAX_LATEX, MATH_RESERVED_SYMBOLS, MATH_SYMBOL_PATTERN } from "@quiz/domain/math";
import { z } from "zod";

export const MATH_CONFIG_VERSION = 1;

export { MATH_MAX_LATEX } from "@quiz/domain/math";

export const MATH_MAX_SYMBOLS = 6;
export const MATH_MAX_ANSWERS = 10;
export const MATH_MAX_SAMPLES = 50;
/** The default interval of a new symbol: positive, away from 0 and 1, like most engineering quantities. */
export const MATH_DEFAULT_RANGE = { min: 0.5, max: 2 } as const;
export const MATH_DEFAULT_TOLERANCE = 1e-6;
export const MATH_DEFAULT_SAMPLES = 10;
export const MATH_DEFAULT_MAX_LENGTH = 200;
/** How many points a curve is drawn with: the target's and the answer's share one grid. */
export const MATH_PLOT_POINTS = 64;

export const MathFunctionSchema = z.enum(MATH_FUNCTIONS);

export const MathSymbolSchema = z.object({
  name: z.string().min(1).max(16).regex(MATH_SYMBOL_PATTERN),
  min: z.number(),
  max: z.number(),
});
export type MathSymbol = z.infer<typeof MathSymbolSchema>;

/** One accepted answer, worth `points` of the item; the first that matches wins. */
export const MathAnswerKeySchema = z.object({
  value: z.string().min(1).max(MATH_MAX_LATEX),
  points: z.number().min(0).max(1).default(1),
});
export type MathAnswerKey = z.infer<typeof MathAnswerKeySchema>;

/** No graph; the student's expression drawn; the key's curve drawn too, as the target to match. */
export const MathPlotSchema = z.enum(["none", "answer", "target"]);
export type MathPlot = z.infer<typeof MathPlotSchema>;

const MathConfigShape = z.object({
  configVersion: z.literal(MATH_CONFIG_VERSION),
  prompt: z.string().min(1).max(20_000),
  symbols: z.array(MathSymbolSchema).min(1).max(MATH_MAX_SYMBOLS),
  answers: z.array(MathAnswerKeySchema).min(1).max(MATH_MAX_ANSWERS),
  /** Relative, with a floor at the key's magnitude (`compareMath`). */
  tolerance: z.number().gt(0).max(0.5).default(MATH_DEFAULT_TOLERANCE),
  samples: z.number().int().min(3).max(MATH_MAX_SAMPLES).default(MATH_DEFAULT_SAMPLES),
  /** What the FIELD accepts: a student is told while typing, never afterwards. */
  forbidden: z.array(MathFunctionSchema).default([]),
  maxLength: z.number().int().min(10).max(MATH_MAX_LATEX).default(MATH_DEFAULT_MAX_LENGTH),
  plot: MathPlotSchema.default("none"),
});

function refineMathConfig(config: z.infer<typeof MathConfigShape>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  config.symbols.forEach((symbol, index) => {
    if (seen.has(symbol.name)) ctx.addIssue({ code: "custom", path: ["symbols", index, "name"], message: "math.duplicate_symbol" });
    seen.add(symbol.name);
    if (MATH_RESERVED_SYMBOLS.includes(symbol.name)) {
      ctx.addIssue({ code: "custom", path: ["symbols", index, "name"], message: "math.reserved_symbol" });
    }
    if (!(symbol.min < symbol.max)) ctx.addIssue({ code: "custom", path: ["symbols", index, "max"], message: "math.symbol_range" });
  });
  if (config.plot !== "none" && config.symbols.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["plot"], message: "math.plot_one_symbol" });
  }
}

export const MathConfigSchema = MathConfigShape.superRefine(refineMathConfig);
export type MathConfig = z.infer<typeof MathConfigSchema>;

export const MathAnswerSchema = z.object({ latex: z.string().max(MATH_MAX_LATEX) });
export type MathAnswer = z.infer<typeof MathAnswerSchema>;

/** The ONE predicate behind both `isAnswered` hooks, server and client. */
export function isMathAnswered(answer: MathAnswer): boolean {
  return answer.latex.trim() !== "";
}

/**
 * Everything a student may see. The symbols by NAME only — their intervals
 * are where the grading points are drawn, so they stay with the key — and
 * the field's rules whole. With a plot, the window of the plotted symbol
 * (`axis`) and, when the teacher asked for the target, the key's curve as
 * `MATH_PLOT_POINTS` values over that window: a deliberate exit of the key
 * in numeric form, like the circuit type's `showExpected` (docs/spec/04
 * §4.16).
 */
export const MathStudentSchema = z.object({
  prompt: z.string(),
  symbols: z.array(z.string()),
  forbidden: z.array(MathFunctionSchema),
  maxLength: z.number().int(),
  plot: MathPlotSchema,
  axis: z.object({ from: z.number(), to: z.number() }).optional(),
  target: z.array(z.number().nullable()).optional(),
});
export type MathStudent = z.infer<typeof MathStudentSchema>;

/**
 * The field's rules, as the student is shown them and as the grader reads
 * the answer with them — ONE object, so the two cannot differ (ADR-102 §7).
 * `toStudent` spreads it into the view, and the view itself is a
 * `ReadOptions`.
 */
export function fieldRules(config: Pick<MathConfig, "symbols" | "forbidden" | "maxLength">): Pick<MathStudent, "symbols" | "forbidden" | "maxLength"> {
  return { symbols: config.symbols.map((s) => s.name), forbidden: [...config.forbidden], maxLength: config.maxLength };
}

/** The key as a teacher reads it, and as a student reads it once shown (nothing is teacher-only). */
export const MathSolutionSchema = z.object({
  answers: z.array(z.object({ value: z.string(), points: z.number() })),
});
export type MathSolution = z.infer<typeof MathSolutionSchema>;

/** Why an answer could not be read (`MathProblem` of `@quiz/domain/math`), kept whole so the review can say it. */
export const MathProblemSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("empty") }),
  z.object({ code: z.literal("too_long"), max: z.number() }),
  z.object({ code: z.literal("syntax") }),
  z.object({ code: z.literal("unknown_symbol"), names: z.array(z.string()) }),
  z.object({ code: z.literal("unsupported"), names: z.array(z.string()) }),
  z.object({ code: z.literal("forbidden_function"), names: z.array(MathFunctionSchema) }),
]);

export const MathDetailsSchema = z.object({
  /** `invalid`: the answer could not be read, `problem` says why; `graded`: compared to the key. */
  status: z.enum(["invalid", "graded"]),
  problem: MathProblemSchema.optional(),
  /** Which accepted answer matched, in key order; `null` when none did. */
  matchedIndex: z.number().int().nullable(),
  fraction: z.number(),
  /** The answer as the parser understood it, for the review's echo. */
  latex: z.string().nullable(),
});
export type MathDetails = z.infer<typeof MathDetailsSchema>;

export function defaultMathSymbol(name = "x"): MathSymbol {
  return { name, ...MATH_DEFAULT_RANGE };
}

/** The shape and the defaults, no content, invalid as it stands (D16). */
export function emptyMathDraft(): MathConfig {
  return {
    configVersion: MATH_CONFIG_VERSION,
    prompt: "",
    symbols: [defaultMathSymbol()],
    answers: [{ value: "", points: 1 }],
    tolerance: MATH_DEFAULT_TOLERANCE,
    samples: MATH_DEFAULT_SAMPLES,
    forbidden: [],
    maxLength: MATH_DEFAULT_MAX_LENGTH,
    plot: "none",
  };
}
