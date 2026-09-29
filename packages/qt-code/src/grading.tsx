/**
 * The `code` column of the grading table (ADR-044): ONE wide column, the
 * program the student wrote in a box as wide as the column, clamped to five
 * lines (`ClampedCode`, `@quiz/ui`), beside a chip that says how its run
 * went — the cases passed out of all of them, read from the grading's
 * breakdown, never judged here. The expected row holds the reference
 * solution in the same box, in `info`.
 *
 * What is shown of a program is what the student WROTE: the editable
 * regions, one after the other, a blank line standing for the locked code
 * between two of them — the template is the same on every row and would
 * only push the differences below the fold. The panel shows the rest.
 */
import type { ReactNode } from "react";

import type { GradingColumn, QuestionTypeGrading } from "@quiz/core/client";
import { gradingSortKey, plural, resolveStrings } from "@quiz/core/client";
import { breakdownOf, ClampedCode, countTone, Dash, runStatus, WordChip } from "@quiz/ui";

import { referencePieces } from "./reference.js";
import type { CodeAnswer, CodeDetails, CodeSolution, CodeStudent } from "./schema.js";
import { GRADING_STRINGS, type CodeGradingStrings } from "./strings.js";

/**
 * Regions as one text: each without its blank lines around, non-empty ones
 * only, a blank line between two, the common indentation removed — a region
 * sits inside a function body, and four columns of nothing are four columns
 * of a narrow cell lost.
 */
export function programText(regions: readonly string[]): string {
  const lines = regions
    .filter((region) => region.trim() !== "")
    .map((region) => region.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, ""))
    .join("\n\n")
    .split("\n");
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(Math.min(common, l.length))).join("\n");
}

/** The reference solution as the same text: its `@@next` pieces are its regions. */
export const referenceText = (reference: string): string => programText(referencePieces(reference));

/** What a program column reads of a grading's breakdown, `code`'s or `codeimage`'s. */
type RunDetails = { compile?: { ok: boolean } | null | undefined };

/**
 * THE program column, `code`'s and `codeimage`'s (ADR-021): the program in
 * the clamped box, and before it a fixed 96 px lead — so the programs of
 * every row start at one line — saying how its run went. The words of the
 * run's state are this column's (`runStatus`, `@quiz/ui`): "runner…" while
 * a verdict may still come, "Not run", "Does not compile"; nothing on a
 * teacher's override. Only a run that went through asks the type for its
 * `lead` (the tests passed, the picture drawn). `expectedLead` is what the
 * key's row shows before the reference solution (the target picture).
 */
export function programColumn<TAnswer extends { regions: string[] }, TDetails extends RunDetails>({
  s,
  label,
  lead,
  expectedLead = null,
  solution,
}: {
  s: CodeGradingStrings;
  label: string;
  lead: (details: TDetails) => ReactNode;
  expectedLead?: ReactNode;
  solution: { referenceSolution: string } | null;
}): GradingColumn<TAnswer, TDetails> {
  const box = (code: string, tone: "neutral" | "expected") => (
    <ClampedCode
      code={code}
      tone={tone}
      more={(n) => plural(s, "more", n)}
      expand={s.expand}
      collapse={s.collapse}
    />
  );
  const row = (first: ReactNode, program: ReactNode) => (
    <div className="flex w-full min-w-0 items-start gap-3">
      <div className="flex w-24 shrink-0 justify-start pt-1">{first}</div>
      {program}
    </div>
  );
  const leadOf = (details: TDetails | null): ReactNode => {
    switch (runStatus(details)) {
      case "waiting":
        return <WordChip tone="neutral" text={s.atRunner} />;
      case "failed":
        return <WordChip tone="bad" text={s.runFailed} />;
      case "ran":
        return details?.compile?.ok === false ? (
          <WordChip tone="bad" text={s.compileFailed} />
        ) : (
          lead(details!)
        );
      default:
        return null;
    }
  };
  return {
    key: "program",
    label,
    cell: ({ answer, details }) => row(leadOf(details), box(programText(answer?.regions ?? []), "neutral")),
    expected: () =>
      row(expectedLead, solution === null ? <Dash /> : box(referenceText(solution.referenceSolution), "expected")),
    sortKey: (answer) => gradingSortKey(programText(answer?.regions ?? [])),
  };
}

export const codeGrading: QuestionTypeGrading<CodeStudent, CodeAnswer, CodeSolution, CodeDetails> = {
  columns(_student, solution, strings) {
    const s = resolveStrings(GRADING_STRINGS, strings);
    return [
      programColumn<CodeAnswer, CodeDetails>({
        s,
        label: s.program,
        solution,
        lead: (details) => {
          const cases = breakdownOf(details, "cases")?.cases ?? [];
          // A run without cases (a program only compiled) counts nothing.
          if (cases.length === 0) return null;
          const passed = cases.filter((c) => c.ok).length;
          return (
            <WordChip
              tone={countTone(passed, cases.length)}
              text={plural(s, "tests", cases.length, { passed, total: cases.length })}
            />
          );
        },
      }),
    ];
  },
};
