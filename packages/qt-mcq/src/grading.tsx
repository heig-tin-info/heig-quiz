/**
 * The `mcq` columns of the grading table (ADR-044): one column per choice,
 * in CANONICAL order and lettered canonically — the grading queue sends the
 * views with `shuffle: false`, so column C is choice C on every row, however
 * each student saw the choices.
 *
 * A cell is a tick box: ticked and correct, ticked and wrong, or a correct
 * choice the student left out, drawn dashed ("missed"). Reading a column
 * down is reading how the class treated one choice.
 */
import type { GradingColumn, QuestionTypeGrading } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { ChoiceMark, headerOf, type ChoiceMarkState } from "@quiz/ui";

import type { McqAnswer, McqDetails, McqSolution, McqStudent } from "./schema.js";
import { choiceLetter } from "./schema.js";
import { mcqGradingStrings } from "./strings.js";

/** A header is a column's name, not the choice: the whole text is its tooltip. */
const HEADER_CHARS = 32;

export const mcqGrading: QuestionTypeGrading<McqStudent, McqAnswer, McqSolution, McqDetails> = {
  columns(student, solution, strings) {
    const s = resolveStrings(mcqGradingStrings, strings);
    // Without a key the ticks are the student's and nothing more: neither
    // right nor wrong, and nothing is "missed".
    const correct = solution === null ? null : new Set(solution.correct);
    const label: Record<ChoiceMarkState, string> = {
      good: s.tickedCorrect,
      bad: s.tickedWrong,
      on: s.ticked,
      missed: s.missed,
      off: s.notTicked,
      expected: s.expected,
    };
    return student.choices.map((choice): GradingColumn<McqAnswer, McqDetails> => {
      const isCorrect = correct?.has(choice.id) ?? null;
      const markOf = (answer: McqAnswer | null): ChoiceMarkState => {
        const ticked = answer?.selected.includes(choice.id) ?? false;
        if (ticked) return isCorrect === null ? "on" : isCorrect ? "good" : "bad";
        return isCorrect && answer !== null ? "missed" : "off";
      };
      return {
        key: `choice-${choice.id}`,
        ...headerOf(`${choiceLetter(choice.id)} · ${choice.text}`, HEADER_CHARS),
        align: "center",
        cell: ({ answer }) => {
          const state = markOf(answer);
          return <ChoiceMark state={state} label={label[state]} />;
        },
        expected: () =>
          isCorrect ? (
            <ChoiceMark state="expected" label={s.expected} />
          ) : (
            <ChoiceMark state="off" label={s.notExpected} />
          ),
        // Ticked first when ascending is what a teacher looking for "who
        // ticked B" wants at the top: "0" sorts before "1".
        sortKey: (answer) => (answer?.selected.includes(choice.id) ? "0" : "1"),
      };
    });
  },
};
