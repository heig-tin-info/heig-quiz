/**
 * The `circuit` answer key of the debrief (ADR-033, ADR-109): the reference
 * schematic, read only, under the host's statement.
 *
 * Hidden, a hatched block: a student starts from an empty box, so there is
 * nothing of the question to show in its place. Its frame keeps one height
 * per density (`KeyFrame`), so nothing moves at the reveal. The question's
 * stimuli, its tolerance and its grading criteria never appear: they are the
 * grader's (ADR-037), and the debrief is read by a class.
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyProps } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { KeyFigure, KeyFrame } from "@quiz/ui";

import { SchematicView, type CanvasStrings } from "./canvas/index.js";
import type { CircuitSolution, CircuitStudent } from "./schema.js";
import { KEY_STRINGS, type CircuitKeyStrings } from "./strings.js";

type CircuitKeyProps = KeyProps<CircuitStudent, CircuitSolution> & {
  strings?: Partial<CircuitKeyStrings>;
  canvasStrings?: Partial<CanvasStrings>;
};

export function CircuitKey({ solution, revealed, density, stats, prompt, rows, strings, canvasStrings }: CircuitKeyProps) {
  const s = resolveStrings(KEY_STRINGS, strings);
  const reference = solution?.reference ?? null;
  return (
    <>
      {prompt}
      {reference === null ? null : (
        <KeyFigure density={density} caption={revealed ? s.reference : s.hidden}>
          <KeyFrame density={density} shown={revealed ? reference : null} revealed={revealed}>
            {(schematic, height) => (
              <SchematicView schematic={schematic} height={height} strings={canvasStrings} aria-label={s.reference} />
            )}
          </KeyFrame>
        </KeyFigure>
      )}
      {/* No circuit groups its answers today; the rows stand ready all the same. */}
      {stats.distribution.length > 0 ? rows : null}
    </>
  );
}
