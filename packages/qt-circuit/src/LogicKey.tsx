/**
 * The `logic` answer key of the debrief (ADR-109): the expected expressions,
 * set in KaTeX, the reference circuit read-only, or the test vectors as a
 * table, under the host's statement.
 * Hidden, a hatched block stands in their place, so nothing moves at the
 * reveal.
 * Staff only (`QuestionTypeClient.Key`).
 */
import type { KeyProps } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { KeyFigure, KeyHatch } from "@quiz/ui";

import { logicLibrary, SchematicView, type CanvasStrings } from "./canvas/index.js";
import { expressionLatex, vectorsMarkdown, type LogicSolution, type LogicStudent } from "./logicSchema.js";
import { LOGIC_KEY_STRINGS, type LogicKeyStrings } from "./logicStrings.js";

type LogicKeyProps = KeyProps<LogicStudent, LogicSolution> & {
  strings?: Partial<LogicKeyStrings>;
  canvasStrings?: Partial<CanvasStrings> | undefined;
};

export function LogicKey({ student, solution, revealed, density, stats, prompt, rows, strings, canvasStrings, renderBlock }: LogicKeyProps) {
  const s = resolveStrings(LOGIC_KEY_STRINGS, strings);
  const reference = solution?.reference;
  if (reference !== undefined) {
    return (
      <>
        {prompt}
        <KeyFigure density={density} caption={revealed ? s.reference : s.referenceHidden}>
          {revealed ? (
            <SchematicView
              schematic={reference}
              library={logicLibrary(student.symbols)}
              {...(canvasStrings === undefined ? {} : { strings: canvasStrings })}
            />
          ) : (
            <KeyHatch className="h-48" />
          )}
        </KeyFigure>
        {stats.distribution.length > 0 ? rows : null}
      </>
    );
  }
  const outputs = solution?.outputs ?? [];
  const vectors = solution?.vectors;
  const display =
    vectors !== undefined
      ? vectorsMarkdown(vectors, student)
      : outputs
          .map(({ name, expression }) => {
            const latex = expressionLatex(name, expression);
            return latex === null ? `\`${name} = ${expression}\`` : `$$${latex}$$`;
          })
          .join("\n\n");
  const caption = vectors !== undefined ? (revealed ? s.vectors : s.vectorsHidden) : revealed ? s.expressions : s.hidden;
  return (
    <>
      {prompt}
      {display === "" ? null : (
        <KeyFigure density={density} caption={caption}>
          {revealed ? renderBlock(display) : <KeyHatch className={vectors !== undefined || outputs.length > 2 ? "h-32" : "h-20"} />}
        </KeyFigure>
      )}
      {stats.distribution.length > 0 ? rows : null}
    </>
  );
}
