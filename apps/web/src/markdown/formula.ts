import katex from "katex";

import { escapeHtml } from "@quiz/docrender/highlight";
import { type FormulaBudget, KATEX_LIMITS, refusedBeforeKatex } from "@quiz/docrender/katex";

/*
 * One formula as HTML, the same way wherever the web app draws one: the
 * student view (`render.ts`), the editor's formula atoms (`tiptap.ts`) and
 * the formula dialog's preview. A formula is someone else's text — a
 * co-author's, a student's essay on the grader's screen — so it renders
 * under `KATEX_LIMITS`, a macro definition, an internal command or a source
 * past `FORMULA_SOURCE_MAX` never reaches KaTeX at all, and what KaTeX
 * returns is inserted only as far as the body's `FormulaBudget` admits it
 * (audit L15, `@quiz/docrender/katex`).
 */

/** Why a formula was not drawn, in the reader's language (`useFormulaLabels`). */
export interface FormulaLabels {
  /** It defines a macro (`\def`, `\newcommand`…) or calls an internal one (`\df@tag`). */
  macro: string;
  /** It nests deeper than the call stack goes. */
  tooDeep: string;
  /** Its source or its HTML is too large, alone or with the body's other formulas. */
  tooLarge: string;
}

/**
 * KaTeX's HTML for `tex`, or — for a formula KaTeX must not see, could not
 * finish or made too large — what KaTeX itself shows for one it cannot
 * parse: the source in the error colour, the reason as its title. A parse
 * error takes that path inside KaTeX (`throwOnError: false`); a stack
 * overflow does not (only `ParseError` is caught there), and would otherwise
 * take the whole page down. `budget` is the body's: one per rendered
 * markdown, a fresh one for a formula drawn on its own.
 */
export function formulaHtml(
  tex: string,
  display: boolean,
  labels: FormulaLabels,
  budget: FormulaBudget,
): string {
  const before = refusedBeforeKatex(tex);
  if (before !== null) return refused(tex, before === "command" ? labels.macro : labels.tooLarge);
  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      output: "htmlAndMathml",
      ...KATEX_LIMITS,
    });
  } catch (e) {
    // Anything else KaTeX did not foresee: its source, no reason to give.
    return refused(tex, e instanceof RangeError ? labels.tooDeep : null);
  }
  return budget.admit(html) ? html : refused(tex, labels.tooLarge);
}

function refused(tex: string, reason: string | null): string {
  const title = reason === null ? "" : ` title="${escapeHtml(reason)}"`;
  return `<span class="katex-error"${title} style="color:var(--danger)">${escapeHtml(tex)}</span>`;
}
