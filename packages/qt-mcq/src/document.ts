/**
 * The `mcq` question as blocks of an exported document (ADR-121 §2, ADR-125).
 *
 * The statement, the key a student may read and the paper zone are drawn
 * from the student view, lettered by DISPLAYED position (ADR-097); the
 * staff's reading of an answer from the stored config, lettered by
 * canonical index, which is the position in the teacher's unshuffled view.
 * The staff's words are English (ADR-121 §4).
 */
import { answerZone, markdown, number, table, type Block, type Labels } from "@quiz/docexport";

import { choiceLetter, type McqAnswer, type McqConfig, type McqDetails, type McqSolution, type McqStudent } from "./schema.js";

/**
 * A choice under its letter. A choice is markdown and may hold a code
 * fence: one of several lines goes in a block of its own, never on the
 * letter's line, where it would break the fence.
 */
function lettered(letter: string, text: string): Block[] {
  return text.includes("\n") ? [markdown(`**${letter}.**`), markdown(text)] : [markdown(`**${letter}.** ${text}`)];
}

/** The choices of `student` at `positions`, lettered as the student saw them. */
function choicesAt(student: McqStudent, positions: readonly number[]): Block[] {
  return student.choices.flatMap((choice, at) => (positions.includes(choice.id) ? lettered(choiceLetter(at), choice.text) : []));
}

/** The prompt, the lettered choices, then what the student must know before answering. */
export function mcqStatementDoc(student: McqStudent, labels: Labels): Block[] {
  return [
    markdown(student.prompt),
    ...student.choices.flatMap((choice, at) => lettered(choiceLetter(at), choice.text)),
    ...(student.mode === "multiple" ? [markdown(labels.severalAnswers)] : []),
    ...(student.negativeMarking ? [markdown(labels.negativeMarking)] : []),
  ];
}

/** The right choices, lettered in the view the key was drawn for. */
export function mcqSolutionDoc(solution: McqSolution, student: McqStudent): Block[] {
  return choicesAt(student, solution.correct);
}

/** One bubble per choice, by letter: round for one answer, square for several. */
export function mcqAnswerZone(student: McqStudent): Block[] {
  return [
    answerZone("bubbles", {
      labels: student.choices.map((_, at) => choiceLetter(at)),
      ...(student.mode === "multiple" ? { multiple: true } : {}),
    }),
  ];
}

/** The staff's reading: the ticked choices, then how the policy scored them. */
export function mcqAnswerDoc(config: McqConfig, answer: McqAnswer, details: McqDetails | null): Block[] {
  const ticked = [...new Set(answer.selected)].filter((i) => i >= 0 && i < config.choices.length).sort((a, b) => a - b);
  const blocks =
    ticked.length === 0
      ? [markdown("No answer.")]
      : ticked.flatMap((i) => lettered(choiceLetter(i), config.choices[i]!.text));
  if (details === null) return blocks;
  const policy = details.negativeMarking ? `${details.policy}, negative marking` : details.policy;
  return [
    ...blocks,
    table(
      ["Policy", "Fraction", "Right ticks", "Wrong ticks", "Right choices", "Wrong choices"],
      [[policy, number(details.fraction), String(details.c), String(details.w), String(details.C), String(details.W)]],
    ),
  ];
}

/**
 * The student's own reading: what they ticked, lettered as they saw it.
 * The breakdown is not read: its indices are canonical (ADR-097).
 */
export function mcqStudentAnswerDoc(student: McqStudent, answer: McqAnswer, _details: unknown, labels: Labels): Block[] {
  const blocks = choicesAt(student, answer.selected);
  return blocks.length === 0 ? [markdown(labels.noAnswer)] : blocks;
}
