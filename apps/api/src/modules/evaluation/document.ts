/**
 * The two documents of a whole evaluation (ADR-121 §8 step 3, ADR-125): the
 * Sources of the export factory for the export sheet.
 *
 *   - {@link evaluationDocument}, the staff "statement with key" (F-EXP-04):
 *     every item in the base order, its statement as a student is served it
 *     (seed 0, no shuffle, like the grading panel's expected row), the
 *     type's key and the explanation. English (ADR-121 §4).
 *   - {@link handout}, the paper a student is handed (ADR-125 §5–§8): the
 *     student views only, through the one exit (invariant 4), in the order
 *     and with the shuffles of the evaluation's secret paper seed — built
 *     exactly as a digital attempt of that seed is (`live.previewView`) —
 *     each item followed by its answer zones; the name frame first. Worded
 *     in the reader's language (ADR-125 §7).
 *
 * Staff-only, both: the routes load the evaluation through `staffEvaluation`
 * (invariant 6). Each is refused as a whole (`409 not_printable`) when the
 * evaluation does not print (`printRefusal`), before anything else is read.
 *
 * It lives beside the `evaluation` service rather than in it: it reads the
 * `live` module's student exit, which itself imports the service.
 */
import type { EvaluationDocumentRecord, HandoutRecord } from "@quiz/contracts";
import {
  answerZone,
  EN_LABELS,
  heading,
  LABELS,
  markdown,
  number,
  scopeZones,
  separator,
  type Block,
  type Document,
  type Lang,
} from "@quiz/docexport";
import { evaluationTotal, slugify } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { explanationBlocks, itemKeyBlocks, provenanceOf } from "../../documents/blocks.js";
import * as live from "../live/service.js";
import { explanationOrNull, loadConfig, typeOf } from "../pool/service.js";
import { paperSeedOf, printRefusal } from "./print.js";
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

/** The staff "statement with key" (F-EXP-04): the record, in the base order. */
export async function evaluationDocument(
  db: Db,
  evaluation: EvaluationRecord,
  options: { now: Date },
): Promise<Found<EvaluationDocumentRecord>> {
  const items = await printableItems(db, evaluation, "document");
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
      items: items.map((entry) => {
        const { type } = entry.question;
        // Static by the refusal above.
        const { student, solution } = live.staffViews(type, loadConfig(type, entry.version), entry.item.id);
        return {
          id: entry.item.id,
          position: entry.item.position,
          internalName: entry.question.internalName,
          type,
          points: entry.item.points,
          counting: entry.item.counting,
          questionId: entry.question.id,
          questionVersionId: entry.version.id,
          intro: entry.item.intro,
          statement: student,
          solution,
          explanation: explanationOrNull(entry.version.explanation),
        };
      }),
    },
    basename: basenameOf(evaluation, "key"),
  };
}

/** The Markdown tree of {@link evaluationDocument}. */
export function evaluationDocumentTree(found: Found<EvaluationDocumentRecord>): Document {
  const { record } = found;
  // A staff document: English (ADR-121 §4).
  const l = EN_LABELS;
  const blocks: Block[] = [heading(1, record.evaluation.title)];
  for (const item of record.items) {
    blocks.push(
      separator,
      // The teacher's passage before the item (ADR-084).
      ...(item.intro ? [markdown(item.intro)] : []),
      ...itemKeyBlocks(typeOf(item.type), item.position, item.internalName, item.points, item.statement, item.solution, l),
      ...explanationBlocks(item.explanation, l),
    );
  }
  return { provenance: provenanceOf(record, { evaluationId: record.evaluation.id }, []), lang: "en", blocks };
}

/**
 * The hand-out (ADR-125): the record, in the paper's order. The views are a
 * digital attempt's of the paper seed, through the live module's one
 * builder, so the paper and a paper attempt entered later agree item for
 * item and choice for choice (ADR-097). The seed itself goes nowhere.
 */
export async function handout(
  db: Db,
  evaluation: EvaluationRecord,
  options: { now: Date },
): Promise<Found<HandoutRecord>> {
  const items = await printableItems(db, evaluation, "handout");
  const seed = await paperSeedOf(db, evaluation);
  const view = await live.previewView(db, evaluation, options.now, seed, items);
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
        intro: item.intro,
        statement: item.student,
      })),
    },
    basename: basenameOf(evaluation, "handout"),
  };
}

/**
 * The Markdown tree of {@link handout}, worded in `lang`: the name frame,
 * the title, then each item numbered in the paper's order, its statement
 * and its answer zones, keyed to the item (`scopeZones`).
 */
export function handoutTree(found: Found<HandoutRecord>, lang: Lang): Document {
  const { record } = found;
  const l = LABELS[lang];
  const blocks: Block[] = [{ ...answerZone("name"), id: "name" }, heading(1, record.evaluation.title)];
  record.items.forEach((item, rank) => {
    const type = typeOf(item.type);
    blocks.push(
      separator,
      ...(item.intro ? [markdown(item.intro)] : []),
      heading(2, `${l.question} ${rank + 1} (${number(item.points)} ${l.pointsShort})`),
      // Both hooks are there: `printRefusal` refused the hand-out otherwise.
      ...type.statementDoc!(item.statement, l),
      ...scopeZones(item.id, type.answerZone!(item.statement)),
    );
  });
  return { provenance: provenanceOf(record, { evaluationId: record.evaluation.id }, []), lang, blocks };
}
