/**
 * The `math` column of the grading table (ADR-044): ONE column, the typed
 * LaTeX as a chip tinted by its verdict, and the accepted answers on the
 * expected row. Sorted by the normal form of the text, so two papers that
 * wrote the same thing sit together.
 */
import type { QuestionTypeGrading } from "@quiz/core/client";
import { gradingSortKey, resolveStrings } from "@quiz/core/client";
import { AnswerChip, NoAnswer, type AnswerTone } from "@quiz/ui";

import type { MathAnswer, MathDetails, MathSolution, MathStudent } from "./schema.js";
import { mathGradingStrings } from "./strings.js";

const toneOf = (details: MathDetails | null): AnswerTone =>
  details === null ? "neutral" : details.fraction >= 1 ? "good" : details.fraction > 0 ? "partial" : "bad";

export const mathGrading: QuestionTypeGrading<MathStudent, MathAnswer, MathSolution, MathDetails> = {
  columns(_student, solution, strings) {
    const s = resolveStrings(mathGradingStrings, strings);
    return [
      {
        key: "latex",
        label: s.answer,
        cell: ({ answer, details }) => {
          const text = answer?.latex.trim() ?? "";
          return text === "" ? (
            <NoAnswer>{s.empty}</NoAnswer>
          ) : (
            <AnswerChip tone={toneOf(details)} title={text}>
              {text}
            </AnswerChip>
          );
        },
        expected: () => (
          <span className="flex flex-wrap gap-1">
            {(solution?.answers ?? []).map((accepted, i) => (
              <AnswerChip key={i} tone="expected" title={accepted.value}>
                {accepted.value}
              </AnswerChip>
            ))}
          </span>
        ),
        sortKey: (answer) => gradingSortKey(answer?.latex),
      },
    ];
  },
};
