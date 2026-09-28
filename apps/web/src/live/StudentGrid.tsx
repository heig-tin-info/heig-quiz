import { Flag } from "lucide-react";

import type { DashboardRow, EvaluationState } from "@quiz/contracts";
import { displayedRate } from "@quiz/domain";

import { useT } from "../i18n";
import type { GridState } from "../realtime/grid";
import { cx, T } from "../ui";
import { ACTIONS, COL, GridRow, PROGRESS } from "./GridRow";

/**
 * The grid of F-DASH-01: students down, questions across.
 *
 * It breaks the "at most seven columns" rule of the design system on purpose,
 * and pays for it the way a matrix has to: the identity column is STICKY and
 * only the question columns scroll, so the teacher never loses track of whose
 * row they are reading at 30 x 12. Each question column is a fixed 64 px, so
 * the scroll distance is predictable and the header never reflows while cells
 * change under it.
 *
 * The row's actions used to be an overflow `Menu` INSIDE the sticky identity
 * column, on the argument that an action you have to scroll sideways to reach
 * is an action you do not take while twenty-four people are waiting. Two
 * things settle it the other way now. The actions are STICKY TOO, at the
 * right edge, so they are never the thing that scrolled off; and they are
 * four single-purpose buttons whose availability is the answer to a question
 * the teacher is already asking — "can I still give this one five minutes?"
 * A menu hid that answer behind a click and showed four items of which two
 * were disabled. Buttons that are simply NOT THERE when the server would
 * refuse them say more, and the column keeps a fixed width so a row losing a
 * button does not make the grid jump.
 *
 * They stop being sticky UNDER `sm`, and that is not a detail: a 390 px
 * screen has 348 px of table, the pinned identity column takes 176 of them
 * and a second pinned column would leave 68 px — one question. Two sticky
 * ends on a phone is not a matrix, it is a pair of columns with a slot
 * between them. So on a phone the actions sit at the end of the row, where
 * scrolling right through the questions lands anyway.
 *
 * The grid is made to fit ONE screen (#227), because a teacher who has to
 * scroll to see the second half of the class does not see it. So every row
 * is a single line — the progress has its own narrow column, presence is a
 * dot and an icon beside the name, never a word under it — and its height is
 * `--row-h`, computed by the dashboard from the space the viewport leaves
 * (`useRowDensity`). The time left is the header's one big clock; a row
 * shows its own only when its deadline is not the common one.
 *
 * Every cell is a plain `VerdictCell`; none of them fetches anything by
 * itself. The whole grid is a pure function of the state `useDashboard`
 * walks forward — the one exception being the tooltip of a cell (#94), which
 * reads the student's paper only once a teacher has hovered or focused it.
 */

export function StudentGrid({
  state,
  clock,
  paused,
  nameOf,
  showAnswers,
  showResults,
  selected,
  onInspect,
  onExtend,
  onClose,
  onReopen,
}: {
  state: GridState;
  /**
   * Server time, as a stable function: the countdown of a row with its own
   * deadline re-reads it on its own tick, so the grid itself does not
   * re-render every second.
   */
  clock: () => number;
  /** The evaluation is paused: every row's countdown freezes with it (W16). */
  paused: boolean;
  /** The name or the anonymous number of one row; the toggle lives above. */
  nameOf: (row: DashboardRow) => string;
  showAnswers: boolean;
  showResults: boolean;
  selected: { attemptId: string; itemId: string } | null;
  onInspect: (row: DashboardRow, itemId: string) => void;
  onExtend: (row: DashboardRow) => void;
  /** With the name the row shows, for the confirmation that asks first. */
  onClose: (row: DashboardRow, name: string) => void;
  onReopen: (row: DashboardRow, name: string) => void;
}) {
  const t = useT();
  const { view } = state;
  const totals = new Map(view.totals.map((x) => [x.itemId, x]));
  const percent = (v: number) => `${Math.round(v * 100)} %`;
  const studentCount = view.rows.filter((r) => !r.staff).length;
  // Issue #89: how many students flagged each question for review. The CLASS
  // only, like every total of this grid — a teacher's own test walk flags
  // nothing about the paper's clarity. A question many students flag may be
  // unclear, which is the one thing this count is for.
  const flaggedBy = new Map(
    view.items.map((item) => [
      item.id,
      view.rows.filter(
        (r) => !r.staff && r.cells.some((c) => c.itemId === item.id && c.flagged),
      ).length,
    ]),
  );

  // Mirrors of the server's own rules, so no button is offered that the API
  // would refuse (`live/attempt.ts`, `live/control.ts`):
  //   - `closeAttempt` moves any attempt that is `in_progress`, whatever the
  //     state of the evaluation — a row left open in a finished evaluation
  //     must stay closable (#95);
  //   - `extendTime` is refused once the evaluation is `closed` or `released`,
  //     and is offered here only while it is running or paused;
  //   - `reopenAttempt` only while the evaluation is running or paused, the
  //     only states in which a reopened student can write anything, and it
  //     returns an `in_progress` attempt untouched, so it is offered for a
  //     finished one only — and never on an exercise with retakes, where the
  //     student starts a new attempt instead (ADR-025).
  const evaluationState: EvaluationState = view.evaluation.state;
  const live = evaluationState === "running" || evaluationState === "paused";
  // #227: the Score column follows the data. Until a grading exists — or the
  // "Results" switch asks for the provisional one — every row's points are
  // null, and a column of thirty dashes is width taken from the questions.
  const showScore = view.rows.some((r) => r.points !== null);

  return (
    // `relative`, and not only `overflow-x-auto`: the accessible names inside
    // the cells are `sr-only`, which is `position: absolute`. Without a
    // positioned ancestor here their containing block is the page, so they
    // escape the scroll container and stretch the DOCUMENT to the width of
    // the grid — a page that scrolls sideways on a phone, which is exactly
    // what the sticky column exists to avoid.
    <div className="relative overflow-x-auto">
      <table className={cx(T.table, "min-w-max")} aria-label={t("live.grid.label")}>
        <thead className={T.head}>
          <tr>
            <th
              scope="col"
              // Narrower on a phone so at least two question columns are
              // visible beside it; the mockup's 390 note.
              className={cx(
                T.th,
                "sticky left-0 z-10 w-44 min-w-44 bg-surface text-left sm:w-60 sm:min-w-60",
              )}
            >
              {t("live.grid.student")}
            </th>
            <th scope="col" className={cx(T.th, PROGRESS, "text-right")}>
              {t("live.grid.progress")}
            </th>
            {showScore ? (
              <th scope="col" className={cx(T.th, "w-20 min-w-20 text-right")}>
                {t("live.grid.score")}
              </th>
            ) : null}
            {view.items.map((item, index) => {
              const flagged = flaggedBy.get(item.id) ?? 0;
              return (
                // ONE line, like Student and Actions beside it (#227): the
                // type is in the tooltip, and the class's flags ride on the
                // same line as the number — a flag and a count fit in 64 px.
                <th
                  key={item.id}
                  scope="col"
                  title={item.type}
                  // 4 px sides, like the cells under it: "Q10", a flag and
                  // "12" need 56 of the 64 px.
                  className={cx(T.th, COL, "px-1! text-center")}
                >
                  <span className="inline-flex items-center justify-center gap-1 whitespace-nowrap">
                    <span className="font-mono text-[11px] font-semibold text-fg">Q{index + 1}</span>
                    {/* The legend under the grid names the flag. */}
                    {flagged > 0 ? (
                      <span
                        className="inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums text-warning"
                        aria-hidden
                      >
                        <Flag className="size-2.5 fill-current" />
                        {flagged}
                      </span>
                    ) : null}
                  </span>
                  {flagged > 0 ? (
                    <span className="sr-only">
                      {flagged === 1
                        ? t("live.grid.flaggedLabelOne")
                        : t("live.grid.flaggedLabel", { n: flagged })}
                    </span>
                  ) : null}
                </th>
              );
            })}
            <th
              scope="col"
              className={cx(
                T.th,
                ACTIONS,
                "bg-surface text-right sm:sticky sm:right-0 sm:z-10 sm:border-l sm:border-line",
              )}
            >
              {t("live.grid.actions")}
            </th>
          </tr>
        </thead>
        {/* The rows are `--row-h` tall, set by the dashboard to fit the
            class on one screen (#227; 36 px when nobody sets it), and a cell
            is that minus 3 px of air above and below. */}
        <tbody className="[--cell-h:calc(var(--row-h,2.25rem)-0.375rem)]">
          {view.rows.map((row) => (
            <GridRow
              key={row.seatId}
              row={row}
              items={view.items}
              name={nameOf(row)}
              active={selected?.attemptId === row.attemptId}
              inspectItemId={selected?.itemId ?? view.items[0]?.id ?? ""}
              evaluationId={view.evaluation.id}
              closesAt={view.evaluation.closesAt}
              showScore={showScore}
              live={live}
              retakes={view.evaluation.retakes}
              paused={paused}
              clock={clock}
              showAnswers={showAnswers}
              showResults={showResults}
              onInspect={onInspect}
              onExtend={onExtend}
              onClose={onClose}
              onReopen={onReopen}
            />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-surface-2/60">
            <th
              scope="row"
              className={cx(T.td, "sticky left-0 z-10 bg-surface-2 text-left font-semibold")}
            >
              {t("live.grid.class")}{" "}
              <span className="font-normal text-fg-muted">
                · {t(studentCount === 1 ? "live.grid.students.one" : "live.grid.students", {
                  n: studentCount,
                })}
              </span>
            </th>
            <td className={cx(T.td, PROGRESS, "text-right text-fg-faint")}>—</td>
            {showScore ? <td className={cx(T.td, "text-right text-fg-faint")}>—</td> : null}
            {view.items.map((item) => {
              const total = totals.get(item.id);
              return (
                <td key={item.id} className={cx(T.td, COL, "px-1 text-center")}>
                  <span className="block text-[13px] font-semibold tabular-nums">
                    {total ? percent(total.completion) : "—"}
                  </span>
                  {/* The success rate, and what KIND of rate it is. With the
                      "Results" switch on, the server grades the answers it
                      already holds (ADR-020), so this reads the live rate and
                      says so; with it off, and before the grading pass has
                      run, there is nothing to read yet. */}
                  <span className="block text-[10px] text-fg-faint">
                    {total?.successRate == null
                      ? showResults
                        ? t("live.grid.noneGradable")
                        : t("live.grid.afterClose")
                      : total.provisional
                        ? t("live.grid.successRateLive", { rate: percent(displayedRate(total.successRate)) })
                        : t("live.grid.successRate", { rate: percent(displayedRate(total.successRate)) })}
                  </span>
                </td>
              );
            })}
            <td
              className={cx(
                T.td,
                ACTIONS,
                "bg-surface-2 sm:sticky sm:right-0 sm:z-10 sm:border-l sm:border-line",
              )}
            />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
