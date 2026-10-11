/**
 * The line under a math field: how the parser read what was typed, or why
 * it could not — STACK's validation step (issue #460). The editor shows it
 * under each key, the player under the answer, the review under the stored
 * answer; one component, so the three never drift.
 */
import type { MarkdownRenderer } from "@quiz/core/client";
import type { MathProblem } from "@quiz/domain/math";
import { caption, cx, ErrorText, markdown } from "@quiz/ui";

import { problemText, type ProblemStrings } from "./problems.js";

export function MathEcho({
  reading,
  symbols,
  strings: s,
  renderMarkdown,
}: {
  /** The reading's LaTeX, or the problem; `null` for nothing typed yet. */
  reading: { latex: string } | { problem: MathProblem } | null;
  symbols: readonly string[];
  strings: ProblemStrings;
  renderMarkdown?: MarkdownRenderer | undefined;
}) {
  if (reading === null) return null;
  if ("problem" in reading) return <ErrorText>{problemText(s, reading.problem, symbols)}</ErrorText>;
  return (
    <div className={cx(caption, "flex flex-wrap items-center gap-2")} data-testid="math-echo">
      <span>{s.interpreted}</span>
      <span className="text-fg">{markdown(renderMarkdown, `$${reading.latex}$`)}</span>
    </div>
  );
}
