/**
 * The two files of the criteria-3 contract (ADR-119), each defined once
 * here and published as a JSON Schema generated from it by the web's
 * build (`publishedSchemas`, `apps/web/scripts/write-schemas.mjs`, served
 * under `/schemas/`):
 *
 * - `results-1.json`, a graded run's `results.json`: what the CI uploads as
 *   its `results` artifact. `ResultsFile` is what the platform validates
 *   with; `checkOutcomes` of `@quiz/domain` maps it onto the criteria.
 * - `criteria-3.json`, a schema-3 `criteria.yml`, for editors and other
 *   tools. The platform's reference is `parseCriteria` of `@quiz/domain`
 *   (closed codes with paths); `CriteriaFile3` states its structure, and
 *   is looser where JSON Schema cannot say a rule (both a `description`
 *   and a `desc`, a maximum of 0).
 */
import {
  CHECK_SCORE_PATTERN,
  COMMAND_MAX_ARGS,
  CRITERIA_SCHEMA_ID,
  MILESTONE_PATTERN,
  NAME_PATTERN,
  PLAIN_SOURCE_PATTERN,
  RESULTS_SCHEMA_ID,
} from "@quiz/domain";
import { z } from "zod";

import { CriterionId } from "./project.js";

// ---------------------------------------------------------------- results-1

/** A check's result, `n/m`: `n` and `m` decimal, `m > 0` (ADR-119 §4). A number too large to be finite reads as no result (`parseCheckScore`). */
export const CheckScore = z.string().regex(CHECK_SCORE_PATTERN, "not a fraction n/m with m > 0");

/**
 * One criterion's entry: its `n/m` and its log. The log is not bounded
 * here: the platform keeps its tail (8 KiB of UTF-8, `tailUtf8`). Unknown
 * keys are ignored, as StudentScore may add some.
 */
export const CheckResult = z.looseObject({
  score: CheckScore,
  log: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

/** The whole file: each `command` criterion's entry under its dotted id; an unknown id, or an unknown key, is ignored. */
export const ResultsFile = z
  .looseObject({
    $schema: z.string().optional(),
    criteria: z.record(CriterionId, CheckResult),
  })
  .meta({ $id: RESULTS_SCHEMA_ID, title: "Quiz graded run results, version 1" });
export type ResultsFile = z.infer<typeof ResultsFile>;

// ---------------------------------------------------------------- criteria-3

/** No argv word can carry NUL. */
const ARGV_WORD = /^[^\0]*$/;
/** A string, or a list of strings joined by lines. */
const Text = z.union([z.string(), z.array(z.string())]);

/** A check's argv: 1 to 20 words, the first non-empty; never a shell string. */
const Command = z
  .tuple([z.string().min(1).regex(ARGV_WORD)], z.string().regex(ARGV_WORD))
  .refine((argv) => argv.length <= COMMAND_MAX_ARGS)
  .meta({ maxItems: COMMAND_MAX_ARGS, description: "An argv run from the directory of criteria.yml, without a shell." });

const LeafBase = {
  prompt: z.string().optional().meta({ description: "Makes the criterion proposed by the model." }),
  command: Command.optional(),
  milestone: z.string().regex(MILESTONE_PATTERN).optional(),
  awarded_points: z.unknown().optional().meta({ description: "Written by a grading tool; ignored by the platform." }),
  rationale: z.unknown().optional().meta({ description: "Written by a grading tool; ignored by the platform." }),
};
const MaxPoints = { max_points: z.number().meta({ description: "Its points, never 0; negative for a penalty." }) };
const BonusPoints = { bonus_points: z.number().positive() };

/** A criterion: a description (or `desc`) and either `max_points` or `bonus_points`. */
const Criterion = z.union(
  [MaxPoints, BonusPoints].flatMap((points) => [
    z.strictObject({ description: Text, ...points, ...LeafBase }),
    z.strictObject({ desc: Text, ...points, ...LeafBase }),
  ]),
);

/** A section: an optional description, then sections and criteria under their names. */
interface Section {
  description?: string | null | undefined;
  [name: string]: unknown;
}
const Section: z.ZodType<Section> = z
  .looseObject({ description: z.string().nullable().optional() })
  .catchall(z.union([Criterion, z.lazy(() => Section)]))
  .superRefine((section, ctx) => {
    for (const name of Object.keys(section)) if (!NAME_PATTERN.test(name)) ctx.addIssue({ code: "custom", message: "a name holds neither a dot nor a space", path: [name] });
  })
  .meta({ propertyNames: { pattern: NAME_PATTERN.source } });

export const CriteriaFile3 = z
  .strictObject({
    schema_version: z.literal(3),
    grading: z
      .strictObject({
        context: Text.optional(),
        student: z.strictObject({ level: z.string().optional(), knows: z.array(z.string()).optional(), learning: z.array(z.string()).optional() }).optional(),
        sources: z
          .array(z.string().regex(PLAIN_SOURCE_PATTERN))
          .optional()
          .meta({ description: "Plain paths from the repository root; a directory ends with /. No wildcard." }),
      })
      .nullable()
      .optional(),
    criteria: Section,
  })
  .meta({ $id: CRITERIA_SCHEMA_ID, title: "Quiz project criteria, schema version 3" });

/** The JSON Schemas the platform publishes, by file name, generated from the definitions above. */
export function publishedSchemas(): Record<string, unknown> {
  const generate = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" });
  return { "criteria-3.json": generate(CriteriaFile3), "results-1.json": generate(ResultsFile) };
}
