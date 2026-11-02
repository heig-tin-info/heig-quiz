/**
 * The `logic` answer key of the debrief (ADR-109): the expected expressions,
 * set in KaTeX, under the host's statement. Hidden, a hatched block of one
 * line per output stands in their place, so nothing moves at the reveal.
 * Staff only (`QuestionTypeClient.Key`).
 */
import type { KeyProps } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { KeyFigure, KeyHatch } from "@quiz/ui";

import { expressionLatex, type LogicSolution, type LogicStudent } from "./logicSchema.js";
import { LOGIC_KEY_STRINGS, type LogicKeyStrings } from "./logicStrings.js";

type LogicKeyProps = KeyProps<LogicStudent, LogicSolution> & { strings?: Partial<LogicKeyStrings> };

export function LogicKey({ solution, revealed, density, stats, prompt, rows, strings, renderBlock }: LogicKeyProps) {
  const s = resolveStrings(LOGIC_KEY_STRINGS, strings);
  const outputs = solution?.outputs ?? [];
  const display = outputs
    .map(({ name, expression }) => {
      const latex = expressionLatex(name, expression);
      return latex === null ? `\`${name} = ${expression}\`` : `$$${latex}$$`;
    })
    .join("\n\n");
  return (
    <>
      {prompt}
      {outputs.length === 0 ? null : (
        <KeyFigure density={density} caption={revealed ? s.expressions : s.hidden}>
          {revealed ? renderBlock(display) : <KeyHatch className={outputs.length > 2 ? "h-32" : "h-20"} />}
        </KeyFigure>
      )}
      {stats.distribution.length > 0 ? rows : null}
    </>
  );
}
