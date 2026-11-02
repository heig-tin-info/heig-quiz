/**
 * The `logic` column of the grading table (ADR-044): ONE column, the rows the
 * circuit got right as a chip, beside what the schematic holds ("4 gates ·
 * 9 wires"). The drawing stays in the answer panel; the expected row has no
 * circuit to count, so it says nothing.
 *
 * Reached from every page through `@quiz/registry/client`: it imports the
 * schema's predicates and types only, never the netlist nor the simulator.
 */
import type { GradingColumn, QuestionTypeGrading } from "@quiz/core/client";
import { fmt, gradingSortKey, plural, resolveStrings } from "@quiz/core/client";
import { AnswerChip, breakdownOf, countTone, Dash } from "@quiz/ui";

import { isGateKind, type LogicAnswer, type LogicDetails, type LogicSolution, type LogicStudent } from "./logicSchema.js";
import { LOGIC_GRADING_STRINGS } from "./logicStrings.js";

export const logicGrading: QuestionTypeGrading<LogicStudent, LogicAnswer, LogicSolution, LogicDetails> = {
  columns(_student, _solution, strings) {
    const s = resolveStrings(LOGIC_GRADING_STRINGS, strings);
    const gatesOf = (answer: LogicAnswer | null): number =>
      answer?.schematic.components.filter((c) => isGateKind(c.kind)).length ?? 0;
    const column: GradingColumn<LogicAnswer, LogicDetails> = {
      key: "schematic",
      label: s.schematic,
      cell: ({ answer, details }) => {
        const breakdown = breakdownOf(details, "outputs");
        const ran = breakdown !== null && breakdown.reason === undefined;
        const wires = answer?.schematic.wires.length ?? 0;
        const gates = gatesOf(answer);
        return (
          <span className="flex flex-wrap items-center gap-2">
            {ran ? (
              <AnswerChip tone={countTone(breakdown.right, breakdown.total)} mono={false}>
                {fmt(s.rows, { right: breakdown.right, total: breakdown.total })}
              </AnswerChip>
            ) : null}
            <span className="text-[13px] text-fg-muted">
              {gates === 0 && wires === 0 ? <Dash /> : `${plural(s, "gates", gates)} · ${plural(s, "wires", wires)}`}
            </span>
          </span>
        );
      },
      expected: () => <Dash />,
      sortKey: (answer) => gradingSortKey(String(gatesOf(answer)).padStart(4, "0")),
    };
    return [column];
  },
};
