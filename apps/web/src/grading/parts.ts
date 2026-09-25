import type { ReviewSections } from "@quiz/core/client";

import type { Dict } from "../i18n";

/**
 * The parts of an open answer a teacher may put away while grading (#109),
 * to read the students' answers and little else. The student's answer is
 * not one of them: it is what is being graded, and it is always drawn.
 *
 * Three are drawn by the grading page itself (the question's internal name
 * on the line above the answer, the explanation, the grading comment) and
 * simply not rendered. The name is hidden on THAT line only: by student it
 * is also what names the list rows, the detail header and the step picker,
 * which is why the checkbox says "above the answer". The prompt and
 * the solution are drawn by the question type's own review, which receives
 * them as `sections` (`@quiz/core/client`) and honours them. Hiding the
 * comment hides its display only: Adjust still asks for one.
 */
export const ANSWER_PARTS = ["internalName", "prompt", "explanation", "solution", "comment"] as const;
export type AnswerPart = (typeof ANSWER_PARTS)[number];
export type ShownParts = Record<AnswerPart, boolean>;

/** Everything shown: a teacher who never opens the menu sees the whole answer. */
export const ALL_PARTS_SHOWN: Readonly<ShownParts> = Object.freeze({
  internalName: true,
  prompt: true,
  explanation: true,
  solution: true,
  comment: true,
});

export const PART_LABELS: Record<AnswerPart, keyof Dict> = {
  internalName: "grading.parts.internalName",
  prompt: "grading.parts.prompt",
  explanation: "grading.parts.explanation",
  solution: "grading.parts.solution",
  comment: "grading.parts.comment",
};

/** The two parts a question type's review draws, as its contract names them. */
export function reviewSections(parts: ShownParts): ReviewSections {
  return { prompt: parts.prompt, solution: parts.solution };
}
