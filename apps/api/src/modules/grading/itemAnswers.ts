/**
 * Every answer to one item, as one file (F-EXP-01, issue #972): the Source
 * of the export factory for the grading panel (ADR-121 §1).
 *
 * One record per enrolled student — the attempt that counts (ADR-025), a
 * teacher's test walk left out like the CSV (ADR-018), a student with no
 * attempt or no answer listed as such — and the Markdown document drawn
 * from it by the question type's hooks. Staff-only: the route loads the
 * evaluation through `staffEvaluation` (invariant 6).
 *
 * A lean read (open question 23): the item, the roster, the attempts, then
 * this item's answers and standing gradings for the counted attempts only —
 * never the whole grading queue with its views and histories.
 *
 * It reads `enrollments` (the `org` module's), `attempts` and `answers` (the
 * `live` module's) by select, and writes nothing.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { ItemAnswersRecord } from "@quiz/contracts";
import { heading, markdown, points, separator, type Block, type Document } from "@quiz/docexport";
import { slugify } from "@quiz/domain";
import { formattedValues } from "@quiz/domain/parameters";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers, enrollments } from "../../db/schema.js";
import { joinedItem, seatsOf, type EvaluationRecord } from "../evaluation/service.js";
import { typeOf } from "../pool/config.js";
import { parametersOf, readingPerAttempt } from "../pool/service.js";
import { exportsText, expectedViews, GradingError, keptAttempts, pairKey, standingGradings } from "./service.js";

/** The record, with what the document needs beside it. */
export interface ItemAnswers {
  record: ItemAnswersRecord;
  /** `configs[i]`: the parsed config of `record.answers[i]`'s attempt, which `answerDoc` rebuilds the source from. */
  configs: readonly unknown[];
  /** The counted attempts, for the provenance. */
  attempts: readonly string[];
  /** The file name, without its extension: the evaluation and the item, as a slug. */
  basename: string;
}

/**
 * The Source (ADR-121 §1). Null when the item is not the evaluation's.
 * `text: true` asks for the Markdown export: an item whose type does not
 * render as text is refused at once (`409 not_exportable`), before any read.
 */
export async function itemAnswers(
  db: Db,
  evaluation: EvaluationRecord,
  itemId: string,
  options: { now: Date; text: boolean },
): Promise<ItemAnswers | null> {
  const item = await joinedItem(db, evaluation.id, itemId);
  if (!item) return null;
  if (options.text && !exportsText(item.question.type, item.version)) throw new GradingError("not_exportable");
  const [roster, kept] = await Promise.all([
    db
      .select({
        userId: enrollments.userId,
        lastName: enrollments.nom,
        firstName: enrollments.prenom,
        email: enrollments.email,
      })
      .from(enrollments)
      .where(and(seatsOf(evaluation), eq(enrollments.staff, false)))
      .orderBy(asc(enrollments.nom), asc(enrollments.prenom)),
    keptAttempts(db, evaluation),
  ]);
  const counted = roster.flatMap((s) => {
    const attempt = s.userId === null ? undefined : kept.get(s.userId);
    return attempt ? [attempt] : [];
  });
  const ids = counted.map((a) => a.id);
  const [answerRows, standing] = await Promise.all([
    ids.length === 0
      ? []
      : db
          .select()
          .from(answers)
          .where(and(eq(answers.itemId, item.item.id), inArray(answers.attemptId, ids))),
    standingGradings(db, evaluation.id, { itemId: item.item.id }),
  ]);
  const answerOf = new Map(answerRows.map((a) => [a.attemptId, a.payload]));
  const read = readingPerAttempt(item);
  const variables = parametersOf(item.version);
  const expected = expectedViews(item);

  const rows = roster.map((student) => {
    const attempt = student.userId === null ? undefined : kept.get(student.userId);
    const grading = attempt ? standing.get(pairKey(attempt.id, item.item.id)) : undefined;
    const reading = attempt ? read(attempt) : null;
    return {
      record: {
        student,
        attempt: attempt ? { id: attempt.id, number: attempt.attemptNumber, state: attempt.state } : null,
        ...(variables && reading?.values ? { values: formattedValues(variables, reading.values) } : {}),
        answer: attempt ? (answerOf.get(attempt.id) ?? null) : null,
        grading: grading
          ? { points: grading.points, maxPoints: grading.maxPoints, state: grading.state, details: grading.details }
          : null,
      },
      config: reading?.config,
    };
  });

  return {
    record: {
      kind: "item-answers",
      version: 1,
      generatedAt: iso(options.now),
      evaluation: { id: evaluation.id, title: evaluation.title },
      item: {
        id: item.item.id,
        position: item.item.position,
        internalName: item.question.internalName,
        type: item.question.type,
        points: item.item.points,
        counting: item.item.counting,
        questionId: item.question.id,
        questionVersionId: item.version.id,
      },
      statement: expected.student,
      solution: expected.solution,
      answers: rows.map((r) => r.record),
    },
    configs: rows.map((r) => r.config),
    attempts: ids,
    basename: slugify(`${evaluation.title} q${item.item.position + 1}`) || "answers",
  };
}

/**
 * The Markdown document of {@link itemAnswers} asked with `text: true`: the
 * header (title, item, statement, key), then one section per student.
 * `app` is the build's commit, for the provenance (ADR-121 §5).
 */
export function itemAnswersDocument(found: ItemAnswers, app: string | null): Document {
  const { record } = found;
  const { item } = record;
  const type = typeOf(item.type);
  const blocks: Block[] = [
    heading(1, record.evaluation.title),
    heading(2, `Question ${item.position + 1}: ${item.internalName} (${item.points} points)`),
    heading(3, "Statement"),
    ...type.statementDoc!(record.statement),
  ];
  if (type.solutionDoc) {
    blocks.push(heading(3, "Reference solution"), ...type.solutionDoc(record.solution, record.statement));
  }
  record.answers.forEach((row, i) => {
    const name = `${row.student.lastName} ${row.student.firstName}`.trim() || row.student.email;
    blocks.push(separator, heading(2, row.attempt && row.attempt.number > 1 ? `${name} (attempt ${row.attempt.number})` : name));
    if (row.attempt === null) {
      blocks.push(markdown("No attempt."));
      return;
    }
    blocks.push(...answerBlocks(type, found.configs[i], row.answer, row.grading?.details ?? null));
    blocks.push(points(row.grading?.points ?? null, item.points));
  });
  return {
    provenance: {
      kind: record.kind,
      version: record.version,
      source: {
        evaluationId: record.evaluation.id,
        itemId: item.id,
        questionId: item.questionId,
        questionVersionId: item.questionVersionId,
      },
      attempts: found.attempts,
      generatedAt: record.generatedAt,
      app,
    },
    blocks,
  };
}

/** One answer through the type's `answerDoc`, or a sentence saying why there is none to show. */
function answerBlocks(
  type: ReturnType<typeof typeOf>,
  config: unknown,
  payload: unknown,
  details: unknown,
): Block[] {
  if (payload === null) return [markdown("No answer.")];
  const answer = type.answerSchema.safeParse(payload);
  if (!answer.success) return [markdown("The stored answer cannot be read.")];
  const parsed = details === null ? null : type.detailsSchema.safeParse(details);
  return type.answerDoc!(config, answer.data, parsed?.success ? parsed.data : null);
}
