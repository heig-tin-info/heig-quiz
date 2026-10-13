/**
 * The `short` answer key of the debrief (ADR-033, ADR-109): the accepted
 * answers, once revealed, above the host's answer groups.
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { ExpectedAnswers } from "@quiz/ui";

import type { ShortSolution, ShortStudent } from "./schema.js";
import { shortKeyStrings, type ShortKeyStringKey } from "./strings.js";

type ShortKeyProps = KeyProps<ShortStudent, ShortSolution> & {
  strings?: StringOverrides<ShortKeyStringKey>;
};

export function ShortKey({ solution, revealed, density, stats, prompt, rows, strings }: ShortKeyProps) {
  const s = resolveStrings(shortKeyStrings, strings);
  const expected = solution?.expected;
  return (
    <>
      {prompt}
      <ExpectedAnswers
        label={s.expected}
        answers={(Array.isArray(expected) ? expected : []).map((text, i) => (
          <span key={i} className="font-mono">
            {text}
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
