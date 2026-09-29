/**
 * The `cloze` columns of the grading table (ADR-044): one column per blank,
 * in the order of the text, each cell what the student put in that blank —
 * the option's label for a dropdown, never its stored index — tinted by the
 * blank's own verdict from the grading's breakdown. The expected row lists
 * each blank's accepted answers.
 */
import type { GradingColumn, QuestionTypeGrading } from "@quiz/core/client";
import { fmt, gradingSortKey, resolveStrings } from "@quiz/core/client";
import { BLANK_ALTERNATIVES_SEPARATOR } from "@quiz/domain";
import { AnswerChip, breakdownOf, NoAnswer, type AnswerTone } from "@quiz/ui";

import type { ClozeAnswer, ClozeDetails, ClozeSolution, ClozeStudent } from "./schema.js";
import { clozeGradingStrings } from "./strings.js";

type Blank = ClozeStudent["blanks"][number];

/** What the student put in `blank`, as a reader sees it; null when nothing. */
function givenOf(blank: Blank, answer: ClozeAnswer | null): string | null {
  const raw = answer?.blanks[blank.index]?.trim() ?? "";
  if (raw === "") return null;
  if (blank.kind !== "select") return raw;
  return blank.options.find((option) => option.id === Number(raw))?.label ?? raw;
}

function toneOf(details: ClozeDetails | null, index: number): AnswerTone {
  const verdict = breakdownOf(details, "perBlank")?.perBlank.find((b) => b.index === index);
  return verdict === undefined ? "neutral" : verdict.ok ? "good" : "bad";
}

export const clozeGrading: QuestionTypeGrading<
  ClozeStudent,
  ClozeAnswer,
  ClozeSolution,
  ClozeDetails
> = {
  columns(student, solution, strings) {
    const s = resolveStrings(clozeGradingStrings, strings);
    return student.blanks.map(
      (blank): GradingColumn<ClozeAnswer, ClozeDetails> => ({
        key: `blank-${blank.index}`,
        label: fmt(s.blank, { n: blank.index + 1 }),
        cell: ({ answer, details }) => {
          const given = givenOf(blank, answer);
          return given === null ? (
            <NoAnswer>{s.empty}</NoAnswer>
          ) : (
            <AnswerChip tone={toneOf(details, blank.index)} title={given}>
              {given}
            </AnswerChip>
          );
        },
        expected: () => {
          const expected = solution?.blanks.find((b) => b.index === blank.index)?.expected ?? "";
          return (
            <span className="flex flex-wrap gap-1">
              {expected.split(BLANK_ALTERNATIVES_SEPARATOR).map((accepted, i) => (
                <AnswerChip key={i} tone="expected" title={accepted}>
                  {accepted}
                </AnswerChip>
              ))}
            </span>
          );
        },
        // A dropdown sorts by its label, not its index: the teacher reads the
        // label, and two blanks with the same options sort the same way.
        sortKey: (answer) => gradingSortKey(givenOf(blank, answer)),
      }),
    );
  },
};
