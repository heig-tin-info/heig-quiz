/**
 * The `math` question as blocks of an exported document (ADR-121 §2, ADR-125).
 *
 * The statement and the paper zone read the student view only: the prompt
 * and the symbols the answer may use, never a key. A formula is written as
 * the web renders one, `$…$`. Every word is the requester's (ADR-121 §4).
 */
import { answerZone, labelled, list, markdown, noAnswerOr, type Block, type Labels } from "@quiz/docexport";

import type { MathAnswer, MathConfig, MathDetails, MathSolution, MathStudent } from "./schema.js";

/**
 * A formula inline: on one line, its dollars escaped, so an answer cannot
 * close the math early and write Markdown of its own.
 */
const inlineMath = (latex: string): string => `$${latex.replace(/\s*[\r\n]+\s*/g, " ").replaceAll("$", "\\$").trim()}$`;

/** The prompt, then the symbols the answer may use. */
export function mathStatementDoc(student: MathStudent, labels: Labels): Block[] {
  return [
    markdown(student.prompt),
    ...(student.symbols.length === 0
      ? []
      : [markdown(labelled(labels, labels.symbols, student.symbols.map(inlineMath).join(", ")))]),
  ];
}

/** The accepted answers, each with the share of the points it earns. */
export function mathSolutionDoc(solution: MathSolution): Block[] {
  return [list(solution.answers.map((a) => `${inlineMath(a.value)} (${Math.round(a.points * 100)} %)`))];
}

/** Two lines to write a formula on. */
export function mathAnswerZone(): Block[] {
  return [answerZone("lines", { lines: 2 })];
}

const isEmpty = (answer: MathAnswer): boolean => answer.latex.trim() === "";
const formula = (answer: MathAnswer): Block => markdown(inlineMath(answer.latex));

/** The staff's reading: the formula, and why it could not be read when it could not. */
export function mathAnswerDoc(_config: MathConfig, answer: MathAnswer, details: MathDetails | null, labels: Labels): Block[] {
  const problem =
    details?.status === "invalid" && details.problem
      ? [markdown(`${labelled(labels, labels.notRead, details.problem.code)}.`)]
      : [];
  return [noAnswerOr(labels, isEmpty(answer), formula(answer)), ...problem];
}

/** The student's own reading: the formula as they typed it. */
export function mathStudentAnswerDoc(_student: MathStudent, answer: MathAnswer, _details: unknown, labels: Labels): Block[] {
  return [noAnswerOr(labels, isEmpty(answer), formula(answer))];
}
