import katex from "katex";

import { escapeHtml } from "@quiz/docrender/highlight";
import { forbiddenMacroDefinition, KATEX_LIMITS } from "@quiz/docrender/katex";

/*
 * One formula as HTML, the same way wherever the web app draws one: the
 * student view (`render.ts`), the editor's formula atoms (`tiptap.ts`) and
 * the formula dialog's preview. A formula is someone else's text — a
 * co-author's, a student's essay on the grader's screen — so it renders
 * under `KATEX_LIMITS`, and a macro definition never reaches KaTeX at all
 * (audit L15, `@quiz/docrender/katex`).
 */

/** Why a formula was not drawn, in the reader's language (`useFormulaLabels`). */
export interface FormulaLabels {
  /** It defines a macro (`\def`, `\newcommand`…). */
  macro: string;
  /** It nests deeper than the call stack goes. */
  tooDeep: string;
}

/**
 * KaTeX's HTML for `tex`, or — for a formula KaTeX must not see or could not
 * finish — what KaTeX itself shows for one it cannot parse: the source in the
 * error colour, the reason as its title. A parse error takes that path
 * inside KaTeX (`throwOnError: false`); a stack overflow does not (only
 * `ParseError` is caught there), and would otherwise take the whole page down.
 */
export function formulaHtml(tex: string, display: boolean, labels: FormulaLabels): string {
  if (forbiddenMacroDefinition(tex) !== null) return refused(tex, labels.macro);
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      output: "htmlAndMathml",
      ...KATEX_LIMITS,
    });
  } catch (e) {
    // Anything else KaTeX did not foresee: its source, no reason to give.
    return refused(tex, e instanceof RangeError ? labels.tooDeep : null);
  }
}

function refused(tex: string, reason: string | null): string {
  const title = reason === null ? "" : ` title="${escapeHtml(reason)}"`;
  return `<span class="katex-error"${title} style="color:var(--danger)">${escapeHtml(tex)}</span>`;
}
