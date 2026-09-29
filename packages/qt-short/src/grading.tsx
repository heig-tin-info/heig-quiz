/**
 * The `short` column of the grading table (ADR-044): ONE column, the typed
 * answer as a chip tinted by its verdict, and the accepted answers of the
 * key on the expected row. Sorted by the normal form of the text, so
 * "Malloc" sits next to "malloc" — the rows a teacher grades alike.
 */
import type { QuestionTypeGrading } from "@quiz/core/client";
import { gradingSortKey, resolveStrings } from "@quiz/core/client";
import { AnswerChip, NoAnswer, type AnswerTone } from "@quiz/ui";

import type { ShortAnswer, ShortDetails, ShortSolution, ShortStudent } from "./schema.js";
import { shortGradingStrings } from "./strings.js";

/** Graded, any credit reads right; not graded yet, the chip stays neutral. */
const toneOf = (details: ShortDetails | null): AnswerTone =>
  details === null ? "neutral" : details.fraction > 0 ? "good" : "bad";

export const shortGrading: QuestionTypeGrading<
  ShortStudent,
  ShortAnswer,
  ShortSolution,
  ShortDetails
> = {
  columns(_student, solution, strings) {
    const s = resolveStrings(shortGradingStrings, strings);
    return [
      {
        key: "text",
        label: s.answer,
        cell: ({ answer, details }) => {
          const text = answer?.text.trim() ?? "";
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
            {(solution?.expected ?? []).map((accepted, i) => (
              <AnswerChip key={i} tone="expected" title={accepted}>
                {accepted}
              </AnswerChip>
            ))}
          </span>
        ),
        sortKey: (answer) => gradingSortKey(answer?.text),
      },
    ];
  },
};
