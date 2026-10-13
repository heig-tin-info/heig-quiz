/**
 * The `diagram` answer key of the debrief (ADR-033, ADR-109): the reference
 * diagram, read only, under the host's statement and above its answer groups.
 *
 * Hidden, it is the starter the class drew from, named as such, or a hatched
 * block when there was none — never the reference, nor its counts of
 * elements and links, which the review shows beside it. Its frame keeps one
 * height per density (`KeyFrame`), so nothing moves at the reveal.
 *
 * NEVER its grading criteria (`solution.rubric`), nor the text forms of the
 * review (ADR-046 §4): they are the grader's, on the grading screen
 * (ADR-037), and the debrief is read by a class.
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { DiagramView, type DiagramStrings } from "@quiz/diagram/client";
import { isEmptyScene } from "@quiz/diagram/server";
import { KeyFigure, KeyFrame } from "@quiz/ui";

import type { DiagramSolution, DiagramStudent } from "./schema.js";
import { diagramKeyStrings, type DiagramKeyStringKey } from "./strings.js";

type DiagramKeyProps = KeyProps<DiagramStudent, DiagramSolution> & {
  strings?: StringOverrides<DiagramKeyStringKey>;
  canvasStrings?: Partial<DiagramStrings>;
};

export function DiagramKey({
  student,
  solution,
  revealed,
  density,
  stats,
  prompt,
  rows,
  strings,
  canvasStrings,
}: DiagramKeyProps) {
  const s = resolveStrings(diagramKeyStrings, strings);
  const reference = solution?.reference ?? null;
  const starter = student.starter !== undefined && !isEmptyScene(student.starter) ? student.starter : null;
  const shown = revealed ? reference : starter;
  const label = revealed ? s.reference : shown === null ? s.hidden : s.start;
  return (
    <>
      {prompt}
      {reference === null ? null : (
        <KeyFigure density={density} caption={label}>
          <KeyFrame density={density} shown={shown} revealed={revealed}>
            {(scene, height) => (
              <DiagramView kind={student.kind} value={scene} maxHeight={height} strings={canvasStrings} aria-label={label} />
            )}
          </KeyFrame>
        </KeyFigure>
      )}
      {/* The blanks alone say nothing the head does not: a row of them needs groups. */}
      {stats.distribution.length > 0 ? rows : null}
    </>
  );
}
