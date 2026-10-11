/**
 * The `blocks` column of the grading table (ADR-044): ONE wide column, the
 * program as indented text in the clamped box (`ClampedCode`, `@quiz/ui`),
 * after a chip that says how many warehouses it brought to the dock — read
 * from the grading's breakdown, never judged here. The expected row holds
 * the reference in the same box.
 *
 * The words of the program are the canvas's: the host hands this column the
 * canvas dictionary merged with its own (`qt.blocks.c.*` and `qt.blocks.g.*`).
 */
import type { ReactNode } from "react";

import type { QuestionTypeGrading } from "@quiz/core/client";
import { gradingSortKey, plural, resolveStrings } from "@quiz/core/client";
import { breakdownOf, ClampedCode, countTone, Dash, WordChip } from "@quiz/ui";

import { pseudoCode } from "./pseudo.js";
import type { BlocksAnswer, BlocksDetails, BlocksSolution, BlocksStudent } from "./schema.js";
import { blocksCanvasStrings, blocksGradingStrings } from "./strings.js";

/** The column's dictionary: its own words and the canvas's, which spell the program. */
export const blocksGradingDictionary = { ...blocksCanvasStrings, ...blocksGradingStrings };

export const blocksGrading: QuestionTypeGrading<BlocksStudent, BlocksAnswer, BlocksSolution, BlocksDetails> = {
  columns(_student, solution, strings) {
    const s = resolveStrings(blocksGradingDictionary, strings as Partial<typeof blocksGradingDictionary> | undefined);
    const box = (program: BlocksAnswer["program"], tone: "neutral" | "expected") => (
      <ClampedCode
        code={program.length === 0 ? s.emptyProgram : pseudoCode(program, s)}
        tone={tone}
        more={(n) => plural(s, "more", n)}
        expand={s.expand}
        collapse={s.collapse}
      />
    );
    const row = (first: ReactNode, program: ReactNode) => (
      <div className="flex w-full min-w-0 items-start gap-3">
        <div className="flex w-24 shrink-0 justify-start pt-1">{first}</div>
        {program}
      </div>
    );
    const lead = (details: BlocksDetails | null): ReactNode => {
      const cases = breakdownOf(details, "cases")?.cases ?? [];
      if (cases.length === 0) return null;
      const passed = cases.filter((c) => c.ok).length;
      return (
        <WordChip
          tone={countTone(passed, cases.length)}
          text={plural(s, "warehouses", cases.length, { passed, total: cases.length })}
        />
      );
    };
    return [
      {
        key: "program",
        label: s.program,
        cell: ({ answer, details }) => row(lead(details), box(answer?.program ?? [], "neutral")),
        expected: () =>
          row(null, solution?.referenceSolution ? box(solution.referenceSolution, "expected") : <Dash />),
        // The program in the canvas's English words: two answers that read the same sort together.
        sortKey: (answer) => gradingSortKey(pseudoCode(answer?.program ?? [], blocksCanvasStrings)),
      },
    ];
  },
};
