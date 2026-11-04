/**
 * The `mcq` question as blocks of an exported document (ADR-121 §2, ADR-125).
 *
 * Every reading lists ALL the choices beside their boxes (a `choices`
 * block): none ticked on the statement, the right ones on the key, the
 * ticked ones on an answer. The statement, the key a student may read and
 * the student's own answer are drawn from the student view, lettered by
 * DISPLAYED position (ADR-097); the staff's reading of an answer from the
 * stored config, lettered by canonical index, which is the position in the
 * teacher's unshuffled view. On a hand-out the statement's choices are the
 * paper zone itself (ADR-125 §6), so the type adds no zone of its own.
 */
import { choices, markdown, number, table, type Block, type Labels } from "@quiz/docexport";

import { choiceLetter, type McqAnswer, type McqConfig, type McqDetails, type McqSolution, type McqStudent } from "./schema.js";

/** The choices of `student`, lettered as the student saw them, those whose id is in `ticked` ticked. */
function studentChoices(student: McqStudent, ticked: readonly number[]): Block {
  return choices(
    student.choices.map((choice, at) => ({ label: choiceLetter(at), text: choice.text })),
    student.mode === "multiple",
    student.choices.flatMap((choice, at) => (ticked.includes(choice.id) ? [at] : [])),
  );
}

/** The prompt, the choices with their empty boxes, then what the student must know before answering. */
export function mcqStatementDoc(student: McqStudent, labels: Labels): Block[] {
  return [
    markdown(student.prompt),
    studentChoices(student, []),
    ...(student.mode === "multiple" ? [markdown(labels.severalAnswers)] : []),
    ...(student.negativeMarking ? [markdown(labels.negativeMarking)] : []),
  ];
}

/** Every choice, the right ones ticked, lettered in the view the key was drawn for. */
export function mcqSolutionDoc(solution: McqSolution, student: McqStudent): Block[] {
  return [studentChoices(student, solution.correct)];
}

/** No zone of its own: the statement's choices are where the student ticks (ADR-125 §6). */
export function mcqAnswerZone(): Block[] {
  return [];
}

/** The staff's reading: every choice, the ticked ones ticked, then how the policy scored them. */
export function mcqAnswerDoc(config: McqConfig, answer: McqAnswer, details: McqDetails | null, labels: Labels): Block[] {
  const ticked = [...new Set(answer.selected)].filter((i) => i >= 0 && i < config.choices.length).sort((a, b) => a - b);
  const blocks =
    ticked.length === 0
      ? [markdown(labels.noAnswer)]
      : [
          choices(
            config.choices.map((choice, i) => ({ label: choiceLetter(i), text: choice.text })),
            config.mode === "multiple",
            ticked,
          ),
        ];
  if (details === null) return blocks;
  const policy = details.negativeMarking ? `${details.policy}, ${labels.negativeMarkingShort}` : details.policy;
  return [
    ...blocks,
    table(
      [labels.policy, labels.fraction, labels.rightTicks, labels.wrongTicks, labels.rightChoices, labels.wrongChoices],
      [[policy, number(details.fraction), String(details.c), String(details.w), String(details.C), String(details.W)]],
    ),
  ];
}

/**
 * The student's own reading: every choice, the ones they ticked ticked,
 * lettered as they saw them. The breakdown is not read: its indices are
 * canonical (ADR-097).
 */
export function mcqStudentAnswerDoc(student: McqStudent, answer: McqAnswer, _details: unknown, labels: Labels): Block[] {
  const shown = student.choices.some((choice) => answer.selected.includes(choice.id));
  return shown ? [studentChoices(student, answer.selected)] : [markdown(labels.noAnswer)];
}
