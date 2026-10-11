/**
 * The `blocks` question type: schemas (docs/spec/04 §4.17, ADR-103).
 *
 * A program of blocks drives a warehouse robot from its start cell to the
 * loading dock; it runs on several warehouses (the cases), some hidden. What
 * a program MEANS is `@quiz/domain/blocks`, the one interpreter the browser
 * animates and the server grades with; this module only says what may be
 * stored and what may travel.
 *
 * Five shapes, one schema each, as `qt-code` and `qt-circuit` do:
 * - {@link BlocksConfig}   what the teacher authors (the reference lives here);
 * - {@link BlocksAnswer}   what the student sends back: the program;
 * - {@link BlocksStudent}  what `toStudent` may hand to a student;
 * - {@link BlocksSolution} the key: the reference and every case, maps included;
 * - {@link BlocksDetails}  the breakdown stored in `gradings.details`, never a map.
 *
 * Every schema that accepts a program — the answer, the starter, the
 * reference — measures it FIRST with the iterative `programStats`, before
 * the recursive parse (ADR-103 §4): a body nested 20 000 deep is refused
 * with a key, never a stack overflow.
 */
import { z } from "zod";

import {
  BATTERY_MAX,
  BLOCK_KINDS,
  MapError,
  PROGRAM_LIMITS,
  parseMap,
  programStats,
  usedKinds,
  type BlockKind,
  type RunReason,
  type Stmt,
} from "@quiz/domain/blocks";

export const BLOCKS_CONFIG_VERSION = 1;

/** A question has one to eight warehouses (ADR-103 amendment D14). */
export const CASES_MAX = 8;

export const BlockKindSchema = z.enum(BLOCK_KINDS as [BlockKind, ...BlockKind[]]);

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/** One statement, recursively: English kinds, no position (ADR-103 §5). */
const StmtSchema: z.ZodType<Stmt> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("forward") }),
    z.object({ kind: z.literal("turn"), dir: z.enum(["left", "right"]) }),
    z.object({
      kind: z.literal("repeat"),
      times: z.number().int().min(1).max(PROGRAM_LIMITS.repeatMax),
      body: z.array(StmtSchema),
    }),
    z.object({ kind: z.literal("repeat_until_dock"), body: z.array(StmtSchema) }),
    z.object({
      kind: z.literal("if_sensor"),
      sensor: z.enum(["free", "blocked"]),
      where: z.enum(["front", "left", "right"]),
      then: z.array(StmtSchema),
      else: z.array(StmtSchema),
    }),
  ]),
);

/**
 * A program: measured on the RAW input before anything recurses. A refusal
 * here aborts the parse (a preprocess that adds an issue stops the pipe), so
 * the recursive schema never sees a program beyond `PROGRAM_LIMITS`.
 */
export const ProgramSchema = z.preprocess((raw, ctx) => {
  if (Array.isArray(raw)) {
    const { nodes, depth } = programStats(raw as Stmt[]);
    if (depth > PROGRAM_LIMITS.depth) ctx.addIssue({ code: "custom", message: "blocks.program_too_deep" });
    else if (nodes > PROGRAM_LIMITS.nodes) ctx.addIssue({ code: "custom", message: "blocks.program_too_long" });
  }
  return raw;
}, z.array(StmtSchema));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** The rows of a warehouse; refused with the key `parseMap` throws. */
export const MapRowsSchema = z.array(z.string()).superRefine((rows, ctx) => {
  try {
    parseMap(rows);
  } catch (error) {
    if (!(error instanceof MapError)) throw error;
    ctx.addIssue({ code: "custom", message: error.key });
  }
});

/**
 * One warehouse: a test case. The battery is the case's own, maps differ in
 * size (ADR-103 §2); a whole number from 1 to `BATTERY_MAX`, which is what
 * bounds every run (amendment D14).
 */
export const CaseSchema = z.object({
  name: z.string().min(1).max(60),
  map: MapRowsSchema,
  battery: z
    .number()
    .int("blocks.battery_out_of_range")
    .min(1, "blocks.battery_out_of_range")
    .max(BATTERY_MAX, "blocks.battery_out_of_range"),
  visible: z.boolean().default(true),
  points: z.number().min(0).max(100).default(1),
});
export type BlocksCase = z.infer<typeof CaseSchema>;

/** The world fixes the block set; one member in v1 (ADR-103 §1). */
export const WorldSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("warehouse") })]);
export type BlocksWorld = z.infer<typeof WorldSchema>;

/** The kinds of `program` that `toolbox` does not offer, in toolbox order. */
export function kindsOutside(program: Stmt[], toolbox: readonly BlockKind[]): BlockKind[] {
  const used = usedKinds(program);
  return BLOCK_KINDS.filter((kind) => used.has(kind) && !toolbox.includes(kind));
}

export const BlocksConfig = z
  .object({
    configVersion: z.literal(BLOCKS_CONFIG_VERSION),
    prompt: z.string().min(1).max(20_000),
    world: WorldSchema.default({ kind: "warehouse" }),
    /** The blocks the student's palette offers: a non-empty subset of the kinds. */
    toolbox: z.array(BlockKindSchema).min(1).max(BLOCK_KINDS.length).default([...BLOCK_KINDS]),
    /** Preloaded in the student's workspace (ADR-103 §10). */
    starter: ProgramSchema.default([]),
    /** The key: mandatory at publication (`publicationIssues`), never in `toStudent`. */
    referenceSolution: ProgramSchema.nullable().default(null),
    cases: z.array(CaseSchema).min(1, "blocks.no_case").max(CASES_MAX, "blocks.too_many_cases"),
    allOrNothing: z.boolean().default(false),
  })
  .superRefine((config, ctx) => {
    // Amendment D15: otherwise `answerMisfit` would refuse every answer that
    // keeps a block of the starter.
    if (kindsOutside(config.starter, config.toolbox).length > 0) {
      ctx.addIssue({ code: "custom", message: "blocks.starter_outside_toolbox", path: ["starter"] });
    }
    if (config.referenceSolution && kindsOutside(config.referenceSolution, config.toolbox).length > 0) {
      ctx.addIssue({ code: "custom", message: "blocks.reference_outside_toolbox", path: ["referenceSolution"] });
    }
  });
export type BlocksConfig = z.infer<typeof BlocksConfig>;

/** A fresh warehouse: a small corridor the teacher reshapes (the editor's "Add"). */
export function emptyCase(): BlocksCase {
  return { name: "", map: ["......", ">....D", "......", "......"], battery: 20, visible: true, points: 1 };
}

/**
 * A fresh draft (decision D16): the shape, the defaults, one warehouse to
 * draw on and no text — it does not validate.
 */
export function emptyBlocksDraft(): BlocksConfig {
  return {
    configVersion: BLOCKS_CONFIG_VERSION,
    prompt: "",
    world: { kind: "warehouse" },
    toolbox: [...BLOCK_KINDS],
    starter: [],
    referenceSolution: null,
    cases: [emptyCase()],
    allOrNothing: false,
  };
}

export const totalCasePoints = (cases: readonly { points: number }[]): number =>
  cases.reduce((sum, c) => sum + c.points, 0);

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

/** The stack under the workspace's "when the robot starts" block (ADR-103 §5). */
export const BlocksAnswer = z.object({ program: ProgramSchema });
export type BlocksAnswer = z.infer<typeof BlocksAnswer>;

/**
 * Whether the answer holds something (issue #89): the ONE predicate behind
 * both `isAnswered` hooks. The hook sees no config, so "differs from the
 * starter" (ADR-103 §10) is the player's to write: a program equal to the
 * starter goes back as the EMPTY program, which the player shows as the
 * starter again. An untouched question therefore stays unanswered, and is
 * graded as one.
 */
export function isBlocksAnswered(answer: BlocksAnswer): boolean {
  return answer.program.length > 0;
}

// ---------------------------------------------------------------------------
// Student view
// ---------------------------------------------------------------------------

/** A visible warehouse, whole: the student runs it in the browser. */
export const StudentCase = z.object({
  name: z.string(),
  map: z.array(z.string()),
  battery: z.number(),
  points: z.number(),
});
export type StudentCase = z.infer<typeof StudentCase>;

/** What a student receives: never the reference, never a hidden case beyond its count and points. */
export const BlocksStudent = z.object({
  prompt: z.string(),
  world: WorldSchema,
  toolbox: z.array(BlockKindSchema),
  starter: ProgramSchema,
  visibleCases: z.array(StudentCase),
  hiddenCount: z.number().int(),
  hiddenPoints: z.number(),
  allOrNothing: z.boolean(),
});
export type BlocksStudent = z.infer<typeof BlocksStudent>;

// ---------------------------------------------------------------------------
// Solution
// ---------------------------------------------------------------------------

/**
 * The key (amendment D17): the reference AND every warehouse, hidden ones
 * included. Unlike `circuit`'s (ADR-037), the cases belong to it: a hidden
 * map is what a student under a shown key needs to read their own result.
 */
export const BlocksSolution = z.object({
  referenceSolution: ProgramSchema.nullable(),
  cases: z.array(StudentCase.extend({ visible: z.boolean() })),
});
export type BlocksSolution = z.infer<typeof BlocksSolution>;

// ---------------------------------------------------------------------------
// Grading details
// ---------------------------------------------------------------------------

export const RunReasonSchema = z.enum(["dock", "collision", "battery", "loop", "short"]);

/** One warehouse's run, as graded: never its map (spec 4.17). */
export const CaseResult = z.object({
  name: z.string(),
  visible: z.boolean(),
  points: z.number(),
  ok: z.boolean(),
  reason: RunReasonSchema,
  /** Forward moves made: the battery spent. */
  moves: z.number().int(),
  /** The cells the robot stood on, start first. */
  trail: z.array(z.object({ x: z.number().int(), y: z.number().int() })),
});
export type CaseResult = z.infer<typeof CaseResult>;

export const BlocksDetails = z.object({
  cases: z.array(CaseResult),
  earned: z.number(),
  total: z.number(),
});
export type BlocksDetails = z.infer<typeof BlocksDetails>;

/** A hidden warehouse as a student reads it without the key: its verdict, never its trace. */
export interface HiddenCaseResult {
  name: string;
  visible: false;
  points: number;
  ok: boolean;
  reason: RunReason;
}

/** The details a review receives: whole for the teacher and under a shown key, redacted otherwise. */
export interface BlocksReviewDetails {
  cases: (CaseResult | HiddenCaseResult)[];
  earned: number;
  total: number;
}

/** Whether a reviewed case still carries its trace. */
export const isTraced = (result: CaseResult | HiddenCaseResult): result is CaseResult => "trail" in result;
