/**
 * The records of an evaluation's documents (ADR-121 §1, step 3; ADR-125):
 * the staff "statement with key" and the printed hand-out, and why an
 * evaluation does not print.
 *
 * Self-contained on purpose: `evaluation.ts` reads {@link PrintRefusal}, so
 * this file takes the enums from `@quiz/domain`, never from `evaluation.ts`.
 */
import { z } from "zod";

import { EVALUATION_MODES, ITEM_COUNTINGS } from "@quiz/domain";

import { StaffItemRef } from "./common.js";

/**
 * Why an evaluation does not print (ADR-125 §5): a poll (never printed), a
 * parameterized item (a copy has no draw, ADR-056), or items whose type
 * declares no paper form (`types`, the registered type ids, each once;
 * empty for the other reasons).
 */
export const PrintRefusal = z.object({
  reason: z.enum(["poll", "parameterized", "type"]),
  types: z.array(z.string()),
});
export type PrintRefusal = z.infer<typeof PrintRefusal>;

/**
 * What the export sheet offers of one evaluation, without a round trip:
 * `null` where the document is served, else why it is not (`409
 * not_printable` with the same body).
 */
export const EvaluationExports = z.object({
  /** The staff "statement with answer key"; the refusal reasons are `PrintRefusal`'s. */
  document: PrintRefusal.nullable(),
  /** The hand-out to print; the refusal reasons are `PrintRefusal`'s. */
  handout: PrintRefusal.nullable(),
});
export type EvaluationExports = z.infer<typeof EvaluationExports>;

/**
 * `GET /evaluations/:id/document.json` (staff, F-EXP-04): every item in the
 * base order, its statement as a student is served it (seed 0, no shuffle),
 * the type's `toSolution` and the explanation. `statement` and `solution`
 * are each type's own shapes, typed per type later (ADR-121 §1).
 */
export const EvaluationDocumentRecord = z.object({
  kind: z.literal("evaluation-document"),
  version: z.literal(1),
  /** The server's clock. */
  generatedAt: z.iso.datetime(),
  evaluation: z.object({
    id: z.uuid(),
    title: z.string(),
    mode: z.enum(EVALUATION_MODES),
    totalPoints: z.number(),
  }),
  items: z.array(
    StaffItemRef.extend({
      counting: z.enum(ITEM_COUNTINGS),
      questionId: z.uuid(),
      questionVersionId: z.uuid(),
      /** The teacher's passage before the item (ADR-084); null when none. */
      intro: z.string().nullable(),
      statement: z.unknown(),
      solution: z.unknown(),
      explanation: z.string().nullable(),
    }),
  ),
});
export type EvaluationDocumentRecord = z.infer<typeof EvaluationDocumentRecord>;

/**
 * `GET /evaluations/:id/handout.json` (ADR-125): the paper as every student
 * holds it — student shapes only. The items follow the paper's order (the
 * evaluation's secret paper seed, ADR-125 §8), choices shuffled as a digital
 * attempt of that seed would show them; `position` is the item's canonical
 * place. No internal name, no key, no explanation, no seed.
 */
export const HandoutRecord = z.object({
  kind: z.literal("handout"),
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  evaluation: z.object({ id: z.uuid(), title: z.string(), totalPoints: z.number() }),
  items: z.array(
    z.object({
      id: z.uuid(),
      position: z.number().int(),
      type: z.string(),
      points: z.number(),
      counting: z.enum(ITEM_COUNTINGS),
      intro: z.string().nullable(),
      /** The type's student view, through the one exit (invariant 4). */
      statement: z.unknown(),
    }),
  ),
});
export type HandoutRecord = z.infer<typeof HandoutRecord>;
