/**
 * The records of an evaluation's documents (ADR-121 §1, step 3; ADR-125):
 * the staff "statement with key" and the printed hand-out, and why an
 * evaluation does not print.
 *
 * Self-contained on purpose: `evaluation.ts` reads {@link PrintRefusal}, so
 * this file takes the enums from `@quiz/domain`, never from `evaluation.ts`.
 */
import { z } from "zod";

import { EVALUATION_MODES, ITEM_COUNTINGS, MAX_PAPER_VARIANTS } from "@quiz/domain";

import { StaffItemRef } from "./common.js";

/**
 * Why an evaluation does not print (ADR-125 §5): a poll (never printed), or
 * items whose type declares no paper form (`types`, the registered type
 * ids, each once; empty for a poll). A parameterized item prints: a paper
 * is a variant, which has its draw (ADR-148).
 */
export const PrintRefusal = z.object({
  reason: z.enum(["poll", "type"]),
  types: z.array(z.string()),
});
export type PrintRefusal = z.infer<typeof PrintRefusal>;

/**
 * Why an evaluation takes no paper copy (ADR-125 §5, §11), in the order the
 * server asks: not an exam, released, never run, or it does not print. The
 * codes are the refusals of `POST /evaluations/:id/paper` (`409`).
 */
export const PAPER_ENTRY_REFUSALS = ["paper_mode", "paper_released", "paper_not_started", "not_printable"] as const;

/** A variant's number, 1 to 26 (ADR-148). */
export const PaperVariantNumber = z.number().int().min(1).max(MAX_PAPER_VARIANTS);

/** A variant's number as a query string writes it. */
export const VariantParam = z.coerce.number().pipe(PaperVariantNumber);

/**
 * The paper variants of an evaluation as the export sheet reads them
 * (ADR-148): how many (1 while none was printed), whether two can differ —
 * a count above 1 is offered only then — and whether they are fixed (the
 * evaluation opened: no Redraw, no fewer). Never a seed.
 */
export const PaperVariantsState = z.object({
  count: PaperVariantNumber,
  varies: z.boolean(),
  locked: z.boolean(),
});
export type PaperVariantsState = z.infer<typeof PaperVariantsState>;

/** `PUT /evaluations/:id/paper-variants`: how many variants the paper has (ADR-148). */
export const PaperVariantsBody = z.object({ count: PaperVariantNumber });
export type PaperVariantsBody = z.infer<typeof PaperVariantsBody>;

/**
 * The variant a document or a paper copy is of: its number, its letter (A
 * for 1) and how many the evaluation has. The letter derives from the number,
 * never from the seed.
 */
export const PaperVariantRef = z.object({
  number: PaperVariantNumber,
  letter: z.string().regex(/^[A-Z]$/),
  of: PaperVariantNumber,
});
export type PaperVariantRef = z.infer<typeof PaperVariantRef>;

/** `?variant=` of a document as Markdown or JSON: one variant, 1 by default (ADR-148). */
export const PaperVariantQuery = z.object({ variant: VariantParam.default(1) });
export type PaperVariantQuery = z.infer<typeof PaperVariantQuery>;

/** `?variant=` of a document as a PDF: one variant, or `all`, each on its own pages (ADR-148). */
export const PaperPdfQuery = z.object({
  variant: z.union([z.literal("all"), VariantParam]).default(1),
});
export type PaperPdfQuery = z.infer<typeof PaperPdfQuery>;

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
  /** "Enter a paper copy" (ADR-125 §17): `null` where a student's row offers it. */
  paper: z.enum(PAPER_ENTRY_REFUSALS).nullable(),
  /** The paper variants (ADR-148). */
  variants: PaperVariantsState,
});
export type EvaluationExports = z.infer<typeof EvaluationExports>;

/**
 * `GET /evaluations/:id/document.json` (staff, F-EXP-04): the key of the
 * evaluation's paper variant (ADR-148) — the items in the paper's order,
 * each statement as the hand-out prints it, the type's `toSolution` in that
 * view and the explanation, with the variant's values; `position` stays the
 * item's canonical place; `variant`, the one it is the key of. Version 3
 * names the variant; version 2 had one variant; version 1 listed the items
 * in the base order. `statement` and `solution` are each type's own shapes, typed per
 * type later (ADR-121 §1).
 */
export const EvaluationDocumentRecord = z.object({
  kind: z.literal("evaluation-document"),
  version: z.literal(3),
  variant: PaperVariantRef,
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
 * holds it — student shapes only. The items follow the paper's order (its
 * variant's secret seed, ADR-148), choices shuffled and values drawn as a
 * digital attempt of that seed and those values would show them; `position`
 * is the item's canonical place. No internal name, no key, no explanation,
 * no seed, no version id, no variables nor values map.
 */
export const HandoutRecord = z.object({
  kind: z.literal("handout"),
  version: z.literal(2),
  /**
   * The variant printed (ADR-148); null on a student's blank print of a
   * series, which is variant 1 and names none. Version 2 adds it.
   */
  variant: PaperVariantRef.nullable(),
  generatedAt: z.iso.datetime(),
  evaluation: z.object({ id: z.uuid(), title: z.string(), totalPoints: z.number() }),
  items: z.array(
    z.object({
      id: z.uuid(),
      position: z.number().int(),
      type: z.string(),
      points: z.number(),
      counting: z.enum(ITEM_COUNTINGS),
      /** ADR-143: the text of the section this item opens on the paper; printed before `intro`. */
      sectionIntro: z.string().nullable(),
      intro: z.string().nullable(),
      /** The type's student view, through the one exit (invariant 4). */
      statement: z.unknown(),
    }),
  ),
});
export type HandoutRecord = z.infer<typeof HandoutRecord>;
