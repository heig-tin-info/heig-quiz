/**
 * The `circuit` column of the grading table (ADR-040): ONE column, what the
 * schematic holds ("3 parts · 4 wires", the parts the student placed — the
 * ports are the box's) beside a chip counting the stimuli it passed, read
 * from the grading's breakdown; its tooltip names the ones that failed. The
 * drawing is too large for a row: it stays in the answer panel. The
 * expected row says the same of the reference circuit.
 *
 * This module is reached from every page through `@quiz/registry/client`,
 * so it imports the library and types only — never the netlist, the grader
 * or zod (see `client.tsx`).
 */
import type { ReactNode } from "react";

import type { GradingColumn, QuestionTypeGrading } from "@quiz/core/client";
import { fmt, gradingSortKey, plural, resolveStrings } from "@quiz/core/client";
import { AnswerChip, breakdownOf, countTone, Dash, runStatus, WordChip } from "@quiz/ui";

import { LIBRARY } from "./library.js";
import type { CircuitAnswer, CircuitDetails, CircuitSolution, CircuitStudent, Schematic } from "./schema.js";
import { GRADING_STRINGS, type CircuitGradingStrings } from "./strings.js";

/** The parts the student placed (the ports are the box's) and the wires; `null` for an empty box. */
function countsOf(schematic: Schematic | undefined): { parts: number; wires: number } | null {
  if (schematic === undefined) return null;
  const parts = schematic.components.filter((c) => !LIBRARY[c.kind].terminal).length;
  const wires = schematic.wires.length;
  return parts === 0 && wires === 0 ? null : { parts, wires };
}

/** "3 parts · 4 wires", or `null` for an empty box. */
function summaryOf(schematic: Schematic | undefined, s: CircuitGradingStrings): string | null {
  const counts = countsOf(schematic);
  if (counts === null) return null;
  return `${plural(s, "parts", counts.parts)} · ${plural(s, "wires", counts.wires)}`;
}

/**
 * How the simulation went, in one chip: its state from `runStatus`
 * (`@quiz/ui`), then — once it ran — the stimuli passed, the failed ones
 * named in the tooltip. Not simulated (`runner: "none"`: graded by hand, or
 * refused first), the netlist's wiring problems are the one thing worth a
 * chip; a teacher's override gets none.
 */
function verdictChip(details: CircuitDetails | null, s: CircuitGradingStrings): ReactNode {
  const status = runStatus(details);
  if (status === "waiting") return <WordChip tone="neutral" text={s.atSimulator} />;
  if (status === "failed") return <WordChip tone="bad" text={s.notSimulated} />;
  const breakdown = breakdownOf(details, "stimuli");
  if (breakdown === null) return null;
  const stimuli = status === "ran" ? breakdown.stimuli : [];
  if (stimuli.length === 0) {
    const issues = breakdown.netlist.issues.length;
    return issues === 0 ? null : <WordChip tone="bad" text={plural(s, "issues", issues)} />;
  }
  const passed = stimuli.filter((st) => st.ok).length;
  const failed = stimuli.filter((st) => !st.ok).map((st) => st.name);
  return (
    <AnswerChip
      tone={countTone(passed, stimuli.length)}
      mono={false}
      title={failed.length === 0 ? undefined : fmt(s.failed, { names: failed.join(", ") })}
    >
      {plural(s, "stimuli", stimuli.length, { passed, total: stimuli.length })}
    </AnswerChip>
  );
}

export const circuitGrading: QuestionTypeGrading<
  CircuitStudent,
  CircuitAnswer,
  CircuitSolution,
  CircuitDetails
> = {
  columns(_student, solution, strings) {
    const s = resolveStrings(GRADING_STRINGS, strings);
    const column: GradingColumn<CircuitAnswer, CircuitDetails> = {
      key: "schematic",
      label: s.schematic,
      cell: ({ answer, details }) => (
        <span className="flex flex-wrap items-center gap-2">
          {verdictChip(details, s)}
          <span className="text-[13px] text-fg-muted">{summaryOf(answer?.schematic, s) ?? <Dash />}</span>
        </span>
      ),
      expected: () => {
        const summary = summaryOf(solution?.reference ?? undefined, s);
        return summary === null ? (
          <Dash />
        ) : (
          <span className="text-[13px] font-medium text-info">{summary}</span>
        );
      },
      // By the counts, padded: ten parts sort after nine, not after one.
      sortKey: (answer) => {
        const counts = countsOf(answer?.schematic);
        const pad = (n: number) => String(n).padStart(4, "0");
        return counts === null ? "" : gradingSortKey(`${pad(counts.parts)} ${pad(counts.wires)}`);
      },
    };
    return [column];
  },
};
