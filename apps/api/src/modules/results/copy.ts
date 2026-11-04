/**
 * One attempt's copy as a file: the Sources of the export factory (ADR-121
 * §1) for the two readers of a copy, built by the question types' STUDENT
 * hooks (`statementDoc`, `studentAnswerDoc`, the `copy` need of `declares`),
 * because a copy holds what the student was served, never the config (the
 * staff record's key aside, below). An
 * item's `intro` (ADR-084) is absent: `StudentResultItem` does not carry it.
 *
 *   - {@link staffCopyRecord} (ADR-125 §4, §5), for the results per-student
 *     view and the live dashboard's inspect view: {@link staffCopy}, the copy
 *     with everything shown, naming the student and the attempt; its key is
 *     `toSolution`'s, whole (#998: an essay's criteria, a hidden test case),
 *     and its breakdown is unfiltered. English: a
 *     staff document (ADR-121 §4). Its routes load the attempt through
 *     `loadEvaluationAttempt` (invariant 6).
 *   - {@link studentCopyRecord} (ADR-112 amendment of 2026-11-03, ADR-125
 *     §18), the student's own, from their feedback page: built from
 *     {@link studentFeedback} and nothing else, so it holds the key, the
 *     explanation, the answer and the comment only where the policy shows
 *     them; worded in the reader's language (ADR-125 §7). Its route loads the
 *     attempt through `ownAttempt`.
 *
 * Both draw each item with the same {@link itemBlocks}, which reads the
 * record's items and nothing else: what the student's document holds is
 * what `studentFeedback` returned. They write nothing.
 */
import type { StaffCopyRecord, StudentCopyRecord, StudentResultItem } from "@quiz/contracts";
import {
  EN_LABELS,
  heading,
  LABELS,
  labelled,
  markdown,
  number,
  points,
  separator,
  type Block,
  type Document,
  type Labels,
  type Lang,
} from "@quiz/docexport";
import { slugify } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import type { attempts } from "../../db/schema.js";
import { explanationBlocks, provenanceOf, solutionBlocks, statementBlocks } from "../../documents/blocks.js";
import { declares, type EvaluationRecord } from "../evaluation/service.js";
import { attemptOwnerName } from "../live/service.js";
import { typeOf } from "../pool/service.js";
import { ResultsError, staffCopy, studentFeedback } from "./service.js";

/** A copy's record, with its file name (without the extension). */
export interface CopyFile<R> {
  record: R;
  basename: string;
}

export type StaffCopyFile = CopyFile<StaffCopyRecord>;
export type StudentCopyFile = CopyFile<StudentCopyRecord>;

type Attempt = typeof attempts.$inferSelect;

const slugOf = (evaluation: EvaluationRecord): string => slugify(evaluation.title) || "evaluation";

/** The Source: {@link staffCopy}, its student and its attempt. */
export async function staffCopyRecord(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: Attempt,
  options: { now: Date },
): Promise<StaffCopyFile> {
  const [copy, owner] = await Promise.all([staffCopy(db, evaluation, attempt), attemptOwnerName(db, attempt)]);
  // A guest has no name of their own: the attempt's id tells two guests' files apart.
  const who = attempt.userId === null ? `guest-${attempt.id.slice(0, 8)}` : slugify(owner.displayName) || "student";
  return {
    record: {
      kind: "staff-copy",
      version: 1,
      generatedAt: iso(options.now),
      evaluation: { id: evaluation.id, title: evaluation.title, mode: evaluation.mode },
      student: { userId: attempt.userId, ...owner },
      attempt: { id: attempt.id, number: attempt.attemptNumber, state: attempt.state },
      ...copy,
    },
    basename: `${slugOf(evaluation)}-${who}-copy`,
  };
}

/**
 * The Source of the student's own copy: {@link studentFeedback} on this
 * attempt, as the feedback page reads it, without the page's actions (the
 * retake offer, the standings). Refused while the page shows no content
 * (`409 feedback_pending` with the page's `reason`) and for a practice
 * attempt (`409 practice_attempt`, ADR-122 §10).
 */
export async function studentCopyRecord(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: Attempt,
  options: { now: Date },
): Promise<StudentCopyFile> {
  if (attempt.afterDue) throw new ResultsError("practice_attempt");
  const feedback = await studentFeedback(db, evaluation, attempt, options.now);
  if (!feedback.available) throw new ResultsError("feedback_pending", undefined, { reason: feedback.reason });
  // The page's actions (`retake`, `review`) are left out of the file by the
  // contract's `.omit` (`StudentCopyRecord`), which `sendExport` parses through.
  const { available: _available, ...copy } = feedback;
  return {
    record: { kind: "student-copy", version: 1, generatedAt: iso(options.now), ...copy },
    basename: `${slugOf(evaluation)}-my-copy`,
  };
}

/**
 * The document of {@link staffCopyRecord}: who and which attempt, the
 * total, then each item in the order the student saw them — the statement,
 * the answer, the key, the explanation, the comment and the points.
 */
export function staffCopyDocument(found: StaffCopyFile): Document {
  const { record } = found;
  const attempt = record.attempt.number > 1 ? `attempt ${record.attempt.number}, ` : "";
  const pending = record.pendingCount > 0 ? `, ${record.pendingCount} still to grade` : "";
  const blocks: Block[] = [
    heading(1, record.evaluation.title),
    markdown(
      [
        `**${record.student.displayName}**${record.student.email ? ` (${record.student.email})` : ""}`,
        `${attempt}${record.attempt.state}: ${number(record.points)} / ${number(record.totalPoints)} points, grade ${number(record.grade)}${pending}`,
      ].join("  \n"),
    ),
  ];
  record.items.forEach((item, rank) => blocks.push(separator, ...itemBlocks(item, rank, STAFF_WORDS)));
  return {
    provenance: provenanceOf(record, { evaluationId: record.evaluation.id, attemptId: record.attempt.id }, [
      record.attempt.id,
    ]),
    lang: "en",
    blocks,
  };
}

/**
 * The document of {@link studentCopyRecord}, worded in `lang`: the title,
 * the points, the grade where the page shows one and the questions still
 * awaiting a grading, then each item as {@link staffCopyDocument} draws it,
 * from what the record holds.
 */
export function studentCopyDocument(found: StudentCopyFile, lang: Lang): Document {
  const { record } = found;
  const l = LABELS[lang];
  const summary = [
    labelled(l, l.points, `${number(record.points)} / ${number(record.totalPoints)}`),
    ...(record.grade !== null ? [labelled(l, l.grade, number(record.grade))] : []),
    ...(record.pendingCount > 0 ? [labelled(l, l.awaitingGrading, String(record.pendingCount))] : []),
  ];
  const blocks: Block[] = [heading(1, record.evaluation.title), markdown(summary.join("  \n"))];
  const words = studentWords(l);
  record.items.forEach((item, rank) => blocks.push(separator, ...itemBlocks(item, rank, words)));
  return {
    provenance: provenanceOf(record, { evaluationId: record.evaluation.id, attemptId: record.attemptId }, [
      record.attemptId,
    ]),
    lang,
    blocks,
  };
}

/** The fixed words of a copy's items: a staff copy's English, or the student's language. */
interface CopyWords {
  labels: Labels;
  answer: string;
  comment: string;
  /**
   * Whether an item without an answer says "No answer.": on the staff copy,
   * which shows every answer, it is the truth; on the student's, `null` may
   * as well be an answer the policy hides, so the part is left out.
   */
  saysNoAnswer: boolean;
}

const STAFF_WORDS: CopyWords = {
  labels: EN_LABELS,
  answer: "Answer",
  comment: "Comment",
  saysNoAnswer: true,
};

const studentWords = (l: Labels): CopyWords => ({
  labels: l,
  answer: l.yourAnswer,
  comment: l.comment,
  saysNoAnswer: false,
});

/**
 * One item of a copy: its statement, the answer, then the key, as the key
 * document orders them. Each part only as the item holds it: the key when
 * `solution` is there, the answer when `answer` is (the record decided).
 */
function itemBlocks(item: StudentResultItem, rank: number, words: CopyWords): Block[] {
  const l = words.labels;
  const type = typeOf(item.type);
  const printable = declares(item.type, "copy");
  const notPrintable = markdown(l.notPrintable);
  // How the item counts, when not normally (ADR-052, ADR-108).
  const counting = item.counting === "bonus" ? ` (${l.bonus})` : item.counting === "neutralized" ? ` (${l.notCounted})` : "";
  return [
    heading(2, `${l.question} ${rank + 1}${counting}`),
    ...(printable ? statementBlocks(type, item.student, l) : [notPrintable]),
    ...(item.answer === null
      ? words.saysNoAnswer
        ? [heading(3, words.answer), markdown(l.noAnswer)]
        : []
      : [
          heading(3, words.answer),
          ...(printable ? type.studentAnswerDoc!(item.student, item.answer, item.details, l) : [notPrintable]),
        ]),
    ...(item.solution !== null ? solutionBlocks(type, item.solution, item.student, l) : []),
    ...explanationBlocks(item.explanation, l),
    ...(item.comment ? [heading(3, words.comment), markdown(item.comment)] : []),
    points(item.points, item.maxPoints),
  ];
}
