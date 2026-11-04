/**
 * The `rich` question (an essay) as blocks of an exported document
 * (ADR-121 §2, ADR-125).
 *
 * The statement and the paper zone read the student view only. The key
 * renders what the solution object holds and nothing more: the staff's
 * holds the rubric and the criteria, a student's (`studentSolution`) the
 * model answer alone, so the same hook serves both. Every word is the
 * requester's (ADR-121 §4).
 */
import { answerZone, code, labelled, markdown, noAnswerOr, table, type Block, type Labels } from "@quiz/docexport";

import {
  a4Pages,
  CHARS_PER_A4_PAGE,
  type RichAnswer,
  type RichConfig,
  type RichDetails,
  type RichFormat,
  type RichSolution,
  type RichStudent,
} from "./schema.js";

/** The prompt, and the length limit when the question sets one. */
export function richStatementDoc(student: RichStudent, labels: Labels): Block[] {
  return [
    markdown(student.prompt),
    ...(student.maxChars === undefined
      ? []
      : [markdown(labelled(labels, labels.lengthLimit, `${student.maxChars} ${labels.characters}`))]),
  ];
}

/** The model answer, then — the staff's only — the rubric and the criteria. */
export function richSolutionDoc(solution: RichSolution, _student: RichStudent, labels: Labels): Block[] {
  const reference = solution.reference?.trim() ? [markdown(solution.reference)] : [];
  const rubric = solution.rubric?.trim() ? [markdown(`**${labels.rubric}**`), markdown(solution.rubric)] : [];
  const criteria = solution.criteria?.length
    ? [
        table(
          [labels.criterion, labels.weight, labels.graderNote],
          solution.criteria.map((c) => [c.title, String(c.weight), c.prompt]),
        ),
      ]
    : [];
  return [...reference, ...rubric, ...criteria];
}

/** The frame of a handwritten essay: ~a page per 3000 characters of its limit, within one page. */
const FRAME_MM = { min: 60, max: 230 } as const;

/** A free frame sized by the question's limit (a page when it sets none). */
export function richAnswerZone(student: RichStudent): Block[] {
  const pages = a4Pages(student.maxChars ?? CHARS_PER_A4_PAGE);
  const heightMm = Math.min(FRAME_MM.max, Math.max(FRAME_MM.min, Math.round(pages * FRAME_MM.max)));
  return [answerZone("free", { heightMm })];
}

const isEmpty = (answer: RichAnswer): boolean => answer.text.trim() === "";

/** The essay as written: formatted when the field was, verbatim in a block otherwise. */
const essay = (format: RichFormat, answer: RichAnswer): Block =>
  format === "markdown" ? markdown(answer.text) : code("text", answer.text);

/** The staff's reading: the essay, then the validated points per criterion when there are any. */
export function richAnswerDoc(config: RichConfig, answer: RichAnswer, details: RichDetails | null, labels: Labels): Block[] {
  const breakdown = details?.breakdown ?? [];
  return [
    noAnswerOr(labels, isEmpty(answer), essay(config.format, answer)),
    ...(breakdown.length === 0
      ? []
      : [table([labels.criterion, labels.points], breakdown.map((b) => [b.title, `${b.points} / ${b.maxPoints}`]))]),
  ];
}

/** The student's own reading: the essay as they wrote it. */
export function richStudentAnswerDoc(student: RichStudent, answer: RichAnswer, _details: unknown, labels: Labels): Block[] {
  return [noAnswerOr(labels, isEmpty(answer), essay(student.format, answer))];
}
