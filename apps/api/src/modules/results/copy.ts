/**
 * One student's copy as a file (ADR-125 §4, §5): the Source of the export
 * factory (ADR-121 §1) for the results per-student view and the live
 * dashboard's inspect view. The record wraps {@link staffCopy} — the copy
 * with everything shown — and names the student and the attempt; the
 * document is drawn from it by the question types' STUDENT hooks
 * (`statementDoc`, `studentAnswerDoc`, the `copy` need of `declares`),
 * because the copy holds what the student was served, never the config.
 * English: a staff document (ADR-121 §4). An item's `intro` (ADR-084) is
 * absent: `StudentResultItem` does not carry it.
 *
 * Staff-only: the routes load the attempt through `loadEvaluationAttempt`
 * (invariant 6). It writes nothing.
 */
import type { StaffCopyRecord, StudentResultItem } from "@quiz/contracts";
import { EN_LABELS, heading, markdown, number, points, separator, type Block, type Document } from "@quiz/docexport";
import { slugify } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import type { attempts } from "../../db/schema.js";
import { explanationBlocks, provenanceOf, solutionBlocks, statementBlocks } from "../../documents/blocks.js";
import { declares, type EvaluationRecord } from "../evaluation/service.js";
import { attemptOwnerName } from "../live/service.js";
import { typeOf } from "../pool/service.js";
import { staffCopy } from "./service.js";

/** The record, with its file name (without the extension). */
export interface StaffCopyFile {
  record: StaffCopyRecord;
  basename: string;
}

/** The Source: {@link staffCopy}, its student and its attempt. */
export async function staffCopyRecord(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: typeof attempts.$inferSelect,
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
    basename: `${slugify(evaluation.title) || "evaluation"}-${who}-copy`,
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
  record.items.forEach((item, rank) => blocks.push(separator, ...itemBlocks(item, rank)));
  return {
    provenance: provenanceOf(record, { evaluationId: record.evaluation.id, attemptId: record.attempt.id }, [
      record.attempt.id,
    ]),
    lang: "en",
    blocks,
  };
}

/** Words a staff document holds beside {@link EN_LABELS}: a counting the student is told apart. */
const COUNTING_NOTE: Record<StudentResultItem["counting"], string> = {
  normal: "",
  bonus: " (bonus)",
  neutralized: " (not counted)",
};

/** What stands for the statement and the answer of a type that does not declare the copy's hooks. */
const NOT_PRINTABLE = markdown("Not printable: read it in Quiz.");

/** One item of the copy: its statement, the answer, then the key, as the key document orders them. */
function itemBlocks(item: StudentResultItem, rank: number): Block[] {
  const l = EN_LABELS;
  const type = typeOf(item.type);
  const printable = declares(item.type, "copy");
  return [
    heading(2, `${l.question} ${rank + 1}${COUNTING_NOTE[item.counting]}`),
    ...(printable ? statementBlocks(type, item.student, l) : [NOT_PRINTABLE]),
    heading(3, "Answer"),
    ...(item.answer === null
      ? [markdown(l.noAnswer)]
      : printable
        ? type.studentAnswerDoc!(item.student, item.answer, item.details, l)
        : [NOT_PRINTABLE]),
    ...(item.solution !== null ? solutionBlocks(type, item.solution, item.student, l) : []),
    ...explanationBlocks(item.explanation, l),
    ...(item.comment ? [heading(3, "Comment"), markdown(item.comment)] : []),
    points(item.points, item.maxPoints),
  ];
}
