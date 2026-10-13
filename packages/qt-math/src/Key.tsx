/**
 * The `math` answer key of the debrief (ADR-033, ADR-109): the accepted
 * formulas, set as math and with their credit when it is less than full
 * marks, once revealed, above the host's answer groups.
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { ExpectedAnswers } from "@quiz/ui";

import type { MathSolution, MathStudent } from "./schema.js";
import { mathKeyStrings, type MathKeyStringKey } from "./strings.js";

type MathKeyProps = KeyProps<MathStudent, MathSolution> & {
  strings?: StringOverrides<MathKeyStringKey>;
};

export function MathKey({ solution, revealed, density, stats, prompt, rows, renderMarkdown, strings }: MathKeyProps) {
  const s = resolveStrings(mathKeyStrings, strings);
  const answers = solution?.answers;
  return (
    <>
      {prompt}
      <ExpectedAnswers
        label={s.expected}
        answers={(Array.isArray(answers) ? answers : []).map((a, i) => (
          <span key={i}>
            {renderMarkdown(`$${a.value}$`)}
            {a.points < 1 ? ` (${a.points})` : null}
          </span>
        ))}
        revealed={revealed}
        density={density}
        rows={rows}
        grouped={stats.distribution.length > 0}
      />
    </>
  );
}
