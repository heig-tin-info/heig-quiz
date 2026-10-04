/** The `brainstorm` column of the grading table: the ideas as neutral chips. */
import type { QuestionTypeGrading } from "@quiz/core/client";
import { gradingSortKey, resolveStrings } from "@quiz/core/client";
import { NoAnswer, WordChip } from "@quiz/ui";

import type { BrainstormAnswer, BrainstormDetails, BrainstormSolution, BrainstormStudent } from "./schema.js";
import { brainstormGradingStrings } from "./strings.js";

export const brainstormGrading: QuestionTypeGrading<
  BrainstormStudent,
  BrainstormAnswer,
  BrainstormSolution,
  BrainstormDetails
> = {
  columns(_student, _solution, strings) {
    const s = resolveStrings(brainstormGradingStrings, strings);
    return [
      {
        key: "ideas",
        label: s.ideas,
        cell: ({ answer }) =>
          (answer?.ideas.length ?? 0) === 0 ? (
            <NoAnswer>{s.empty}</NoAnswer>
          ) : (
            <span className="flex flex-wrap gap-1">
              {answer!.ideas.map((idea, i) => (
                <WordChip key={i} tone="neutral" text={idea} />
              ))}
            </span>
          ),
        expected: () => null,
        sortKey: (answer) => gradingSortKey(answer?.ideas.join(" ")),
      },
    ];
  },
};
