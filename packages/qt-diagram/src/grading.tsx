/**
 * The `diagram` column of the grading table (ADR-044): ONE column, the size
 * of the drawing in counts — "7 elements · 6 links" — and no thumbnail
 * (decision 3 of the ADR-046 addendum). A count tells an empty canvas from a
 * sketch and a sketch from a diagram; the answer panel draws it. The expected
 * row gives the reference's counts.
 */
import type { GradingColumn, QuestionTypeGrading } from "@quiz/core/client";
import { gradingSortKey, plural, resolveStrings } from "@quiz/core/client";
import { isEmptyScene, type Scene } from "@quiz/diagram/server";
import { Dash, WordChip } from "@quiz/ui";

import type { DiagramAnswer, DiagramDetails, DiagramSolution, DiagramStudent } from "./schema.js";
import { diagramGradingStrings } from "./strings.js";

/** "7 elements · 6 links", or `null` for an empty canvas; the review's words carry the same keys. */
export function countsOf(scene: Scene | undefined, s: Readonly<Record<"elements" | "elements.one" | "links" | "links.one", string>>): string | null {
  if (scene === undefined || isEmptyScene(scene)) return null;
  return `${plural(s, "elements", scene.nodes.length)} · ${plural(s, "links", scene.links.length)}`;
}

export const diagramGrading: QuestionTypeGrading<DiagramStudent, DiagramAnswer, DiagramSolution, DiagramDetails> = {
  columns(_student, solution, strings) {
    const s = resolveStrings(diagramGradingStrings, strings);
    const column: GradingColumn<DiagramAnswer, DiagramDetails> = {
      key: "diagram",
      label: s.diagram,
      cell: ({ answer }) => {
        const counts = countsOf(answer?.scene, s);
        return counts === null ? <Dash /> : <WordChip tone="neutral" text={counts} />;
      },
      expected: () => {
        const counts = countsOf(solution?.reference, s);
        return counts === null ? <Dash /> : <WordChip tone="expected" text={counts} />;
      },
      // By size, then by links: the zero-padded counts sort as numbers.
      sortKey: (answer) =>
        answer === null
          ? ""
          : gradingSortKey(
              `${String(answer.scene.nodes.length).padStart(3, "0")} ${String(answer.scene.links.length).padStart(3, "0")}`,
            ),
    };
    return [column];
  },
};
