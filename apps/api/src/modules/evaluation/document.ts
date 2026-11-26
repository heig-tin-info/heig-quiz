/**
 * The two documents of a whole evaluation (ADR-121 §8 step 3, ADR-125): the
 * Sources of the export factory for the export sheet.
 *
 *   - {@link evaluationDocument}, the staff "statement with key" (F-EXP-04):
 *     of an evaluation whose hand-out prints, the key of its paper variant
 *     (ADR-147) — every item in the paper's order, its statement as the
 *     hand-out prints it, its whole key in that view and its explanation,
 *     with the variant's values; of any other, every item in the base order,
 *     its statement as a student is served it (seed 0, no shuffle, like the
 *     grading panel's expected row), a parameterized one with its example
 *     values (ADR-056 §9), said so. Worded in the reader's language (ADR-121
 *     §4, amended 2026-11-04).
 *   - {@link handout}, the paper a student is handed (ADR-125 §5–§8): the
 *     student views only, through the one exit (invariant 4), in the order,
 *     with the shuffles and the values of the evaluation's paper variant —
 *     built exactly as a digital attempt of that seed and those values is
 *     (`live.previewView`) — each item followed by its answer zones; the
 *     name frame first. Worded in the reader's language (ADR-125 §7).
 *
 * The staff routes load the evaluation through `staffEvaluation`
 * (invariant 6); the hand-out has a second reader, a student printing a past
 * series, loaded by the privacy module's `findPastSeries` (ADR-112 amendment
 * of 2026-11-03). Each document is refused as a whole (`409 not_printable`)
 * when the evaluation does not print (`printRefusal`), before anything else
 * is read.
 *
 * It lives beside the `evaluation` service, which re-exports it: it reads the
 * `live` module's student exit, which itself imports the service.
 */
import type { EvaluationDocumentRecord, HandoutRecord } from "@quiz/contracts";
import {
  answerZone,
  heading,
  LABELS,
  markdown,
  pointsAside,
  scopeZones,
  type Block,
  type Document,
  type Lang,
} from "@quiz/docexport";
import { evaluationTotal, slugify } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { explanationBlocks, itemKeyBlocks, provenanceOf } from "../../documents/blocks.js";
import * as live from "../live/service.js";
import { exampleInstance, explanationOrNull, loadConfig, typeOf } from "../pool/service.js";
import { paperVariant, printRefusal } from "./print.js";
import { joinedItems, type JoinedItem } from "./reads.js";
import { EvaluationError, type EvaluationRecord } from "./shared.js";

/** A record, with what its Markdown needs beside it. */
export interface Found<R> {
  record: R;
  /** The file name, without its extension. */
  basename: string;
}

/** The items of `evaluation`, or the route's `409 not_printable { reason, types }`. */
async function printableItems(
  db: Db,
  evaluation: EvaluationRecord,
  document: Parameters<typeof printRefusal>[2],
): Promise<JoinedItem[]> {
  const items = await joinedItems(db, evaluation.id);
  const refusal = printRefusal(evaluation, items, document);
  if (refusal) throw new EvaluationError("not_printable", undefined, refusal);
  return items;
}

/** `<title>-<suffix>`, as a slug. */
const basenameOf = (evaluation: EvaluationRecord, suffix: string): string =>
  `${slugify(evaluation.title) || "evaluation"}-${suffix}`;

/** One item of the statement with key, before it becomes a record's row. */
interface KeyedItem {
  entry: JoinedItem;
  statement: unknown;
  solution: unknown;
  explanation: string;
  /** Shown with its example values: every student had their own (ADR-056 §9). */
  example: boolean;
}

/**
 * Each item of `evaluation` in the base order, with its key: a static one as
 * written, a parameterized one with its example values (`exampleInstance`,
 * draw 0), never its template — a template never reaches a type's hook
 * (ADR-056 §4).
 */
const baseKey = (items: readonly JoinedItem[]): KeyedItem[] =>
  items.map((entry) => {
    const { type } = entry.question;
    const instance = exampleInstance(type, entry.version);
    const { student, solution } = live.staffViews(type, loadConfig(type, instance.version), entry.item.id);
    return { entry, statement: student, solution, explanation: instance.explanation, example: instance.values !== null };
  });

/**
 * The staff "statement with key" (F-EXP-04): the record. An evaluation whose
 * hand-out prints gets the key of its paper variant (ADR-147), in the paper's
 * order with its values, so the key and the hand-out agree; any other, the
 * base order.
 */
export async function evaluationDocument(
  db: Db,
  evaluation: EvaluationRecord,
  options: { now: Date },
): Promise<Found<EvaluationDocumentRecord>> {
  const items = await printableItems(db, evaluation, "document");
  const keyed: KeyedItem[] =
    printRefusal(evaluation, items, "handout") === null
      ? live
          .paperKeyItems(evaluation, items, await paperVariant(db, evaluation, items, options.now))
          .map((key) => ({ ...key, example: false }))
      : baseKey(items);
  return {
    record: {
      kind: "evaluation-document",
      version: 1,
      generatedAt: iso(options.now),
      evaluation: {
        id: evaluation.id,
        title: evaluation.title,
        mode: evaluation.mode,
        totalPoints: evaluationTotal(items.map((i) => i.item)),
      },
      items: keyed.map(({ entry, statement, solution, explanation, example }) => ({
        id: entry.item.id,
        position: entry.item.position,
        internalName: entry.question.internalName,
        type: entry.question.type,
        points: entry.item.points,
        counting: entry.item.counting,
        questionId: entry.question.id,
        questionVersionId: entry.version.id,
        intro: entry.item.intro,
        statement,
        solution,
        explanation: explanationOrNull(explanation),
        example,
      })),
    },
    basename: basenameOf(evaluation, "key"),
  };
}

/**
 * The Markdown tree of {@link evaluationDocument}, worded in `lang`: each
 * item numbered in the record's order — the paper's, or the base order — and
 * an item shown with example values says so under its heading. No rule
 * between items: each heading opens one.
 */
export function evaluationDocumentTree(found: Found<EvaluationDocumentRecord>, lang: Lang): Document {
  const { record } = found;
  const l = LABELS[lang];
  const blocks: Block[] = [heading(1, record.evaluation.title)];
  record.items.forEach((item, rank) => {
    const [head, ...key] = itemKeyBlocks(typeOf(item.type), rank, item.internalName, item.points, item.statement, item.solution, l);
    blocks.push(
      // The teacher's passage before the item (ADR-084).
      ...(item.intro ? [markdown(item.intro)] : []),
      head!,
      ...(item.example ? [markdown(`*${l.exampleValues}*`)] : []),
      ...key,
      ...explanationBlocks(item.explanation, l),
    );
  });
  return { provenance: provenanceOf(record, { evaluationId: record.evaluation.id }, []), lang, blocks };
}

/**
 * The hand-out (ADR-125): the record, in the paper's order. The views are a
 * digital attempt's of the paper variant (ADR-147), through the live
 * module's one builder, so the paper, its key and a paper attempt entered
 * later agree item for item, choice for choice and value for value
 * (ADR-097). The variant's seed and values map go nowhere.
 */
export async function handout(
  db: Db,
  evaluation: EvaluationRecord,
  options: { now: Date },
): Promise<Found<HandoutRecord>> {
  const items = await printableItems(db, evaluation, "handout");
  const variant = await paperVariant(db, evaluation, items, options.now);
  const view = await live.previewView(db, evaluation, options.now, variant, items);
  return {
    record: {
      kind: "handout",
      version: 1,
      generatedAt: iso(options.now),
      evaluation: { id: evaluation.id, title: evaluation.title, totalPoints: view.evaluation.totalPoints },
      items: view.items.map((item) => ({
        id: item.id,
        position: item.position,
        type: item.type,
        points: item.points,
        counting: item.counting,
        sectionIntro: item.sectionIntro,
        intro: item.intro,
        statement: item.student,
      })),
    },
    basename: basenameOf(evaluation, "handout"),
  };
}

/**
 * The Markdown tree of {@link handout}, worded in `lang`: the name frame,
 * the title, then each item numbered in the paper's order, its points at
 * the heading's end, its statement and its answer zones, all keyed to the
 * item (`scopeZones`): a statement's choices are its zone.
 */
export function handoutTree(found: Found<HandoutRecord>, lang: Lang): Document {
  const { record } = found;
  const l = LABELS[lang];
  const blocks: Block[] = [{ ...answerZone("name"), id: "name" }, heading(1, record.evaluation.title)];
  record.items.forEach((item, rank) => {
    const type = typeOf(item.type);
    blocks.push(
      // ADR-143: a section's text, once, at its head; then the item's own.
      ...[item.sectionIntro, item.intro].flatMap((text) => (text ? [markdown(text)] : [])),
      heading(2, `${l.question} ${rank + 1}`, pointsAside(l, item.points)),
      // Both hooks are there: `printRefusal` refused the hand-out otherwise.
      ...scopeZones(item.id, [...type.statementDoc!(item.statement, l), ...type.answerZone!(item.statement)]),
    );
  });
  return { provenance: provenanceOf(record, { evaluationId: record.evaluation.id }, []), lang, blocks };
}
