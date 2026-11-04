/**
 * The `short` question as blocks of an exported document (ADR-121 §2, ADR-125).
 *
 * The statement and the paper zone read the student view only: the prompt
 * and the kind of the field, never a matcher. Every word is the
 * requester's (ADR-121 §4).
 */
import { answerZone, code, list, markdown, noAnswerOr, type Block, type Labels } from "@quiz/docexport";

import type { ShortAnswer, ShortConfig, ShortDetails, ShortKind, ShortSolution, ShortStudent } from "./schema.js";

const HINT: Record<ShortKind, ((labels: Labels) => string) | null> = {
  text: null,
  number: (l) => l.expectNumber,
  date: (l) => l.expectDate,
  time: (l) => l.expectTime,
};

/** The prompt, and what kind of answer the field takes when it is not a text. */
export function shortStatementDoc(student: ShortStudent, labels: Labels): Block[] {
  const hint = HINT[student.kind];
  return [markdown(student.prompt), ...(hint ? [markdown(hint(labels))] : [])];
}

/** The accepted answers, as the key renders them. */
export function shortSolutionDoc(solution: ShortSolution): Block[] {
  return [list(solution.expected)];
}

/** One line for a number, a date or a time; two for a text. */
export function shortAnswerZone(student: ShortStudent): Block[] {
  return [answerZone("lines", { lines: student.kind === "text" ? 2 : 1 })];
}

const isEmpty = (answer: ShortAnswer): boolean => answer.text.trim() === "";

/** The answer as typed, in a block no answer can close. */
const typed = (answer: ShortAnswer): Block => code("text", answer.text);

/** The staff's reading: the answer, then which accepted answer took it. */
export function shortAnswerDoc(
  _config: ShortConfig,
  answer: ShortAnswer,
  details: ShortDetails | null,
  labels: Labels,
): Block[] {
  const given = noAnswerOr(labels, isEmpty(answer), typed(answer));
  if (details === null) return [given];
  // The matcher's kind is a code (`regex`), printed as stored.
  const kind = details.matchedKind === null ? "" : ` (${details.matchedKind})`;
  const verdict =
    details.matchedIndex === null ? labels.noMatch : `${labels.matchedAnswer} ${details.matchedIndex + 1}${kind}.`;
  return [given, markdown(verdict)];
}

/** The student's own reading: the answer as they typed it. */
export function shortStudentAnswerDoc(_student: ShortStudent, answer: ShortAnswer, _details: unknown, labels: Labels): Block[] {
  return [noAnswerOr(labels, isEmpty(answer), typed(answer))];
}
