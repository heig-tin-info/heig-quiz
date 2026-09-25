import { Clock, DoorOpen, Eye, GraduationCap, RotateCcw, WifiOff } from "lucide-react";

import type { DashboardRow, EvaluationState } from "@quiz/contracts";

import { useT } from "../i18n";
import type { GridState } from "../realtime/grid";
import { Badge, Countdown, cx, IconButton, T, VerdictCell } from "../ui";
import { AnswerTip } from "./AnswerTip";
import { cellState, cellValue, completionOf } from "./cells";

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
 * Every cell is a plain `VerdictCell`; none of them fetches anything by
 * itself. The whole grid is a pure function of the state `useDashboard`
 * walks forward — the one exception being the tooltip of a cell (#94), which
 * reads the student's paper only once a teacher has hovered or focused it.
 */

/** Fixed width of a question column: two glyphs and the icon, and no more. */
const COL = "w-16 min-w-16";

/**
 * Room for the widest row — three 28 px buttons and their gaps — held
 * whatever a given row shows, so a student handing in does not shift the
 * grid sideways under the teacher's pointer.
 */
const ACTIONS = "w-26 min-w-26";

/**
 * The dot and the word under the name — but only when they mean something.
 *
 * A student who has HANDED IN is not "offline": their stream closes the
 * moment they submit, and printing the word beside twenty finished rows tells
 * the teacher about the browser rather than about the exam. So presence is
 * reported while the attempt is running, "never connected" while there is no
 * attempt at all, and nothing once the attempt is over — the `handed in` /
 * `closed` badge beside the name already carries that.
 */
function presenceOf(
  row: DashboardRow,
  t: ReturnType<typeof useT>,
): { tone: string; label: string; line: boolean; warn: boolean } {
  if (row.userId === null) {
    return { tone: "bg-line-strong", label: t("live.row.unclaimed"), line: true, warn: false };
  }
  if (row.state === "not_started") {
    return { tone: "bg-line-strong", label: t("live.row.never"), line: true, warn: false };
  }
  if (row.state === "submitted" || row.state === "expired") {
    const label = row.state === "submitted" ? t("live.row.submitted") : t("live.row.expired");
    return { tone: "bg-line-strong", label, line: false, warn: false };
  }
  return row.online
    ? { tone: "bg-success", label: t("live.row.online"), line: false, warn: false }
    : { tone: "bg-warning", label: t("live.row.offline"), line: true, warn: true };
}

export function StudentGrid({
  state,
  now,
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
  /** Server time in epoch ms, ticked once a second by the page. */
  now: number;
  /** The evaluation is paused: every row's countdown freezes with it (W16). */
  paused: boolean;
  /** The name or the anonymous number of one row; the toggle lives above. */
  nameOf: (row: DashboardRow) => string;
  showAnswers: boolean;
  showResults: boolean;
  selected: { attemptId: string; itemId: string } | null;
  onInspect: (row: DashboardRow, itemId: string) => void;
  onExtend: (row: DashboardRow) => void;
  onClose: (row: DashboardRow) => void;
  onReopen: (row: DashboardRow) => void;
}) {
  const t = useT();
  const { view } = state;
  const totals = new Map(view.totals.map((x) => [x.itemId, x]));
  const percent = (v: number) => `${Math.round(v * 100)} %`;
  const studentCount = view.rows.filter((r) => !r.staff).length;

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
  //     finished one only.
  const evaluationState: EvaluationState = view.evaluation.state;
  const live = evaluationState === "running" || evaluationState === "paused";

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
            <th scope="col" className={cx(T.th, "w-20 min-w-20 text-right")}>
              {t("live.grid.score")}
            </th>
            <th scope="col" className={cx(T.th, "hidden w-20 min-w-20 text-right sm:table-cell")}>
              {t("live.grid.time")}
            </th>
            {view.items.map((item, index) => (
              <th key={item.id} scope="col" className={cx(T.th, COL, "text-center")}>
                <span className="block font-mono text-[11px] font-semibold text-fg">
                  Q{index + 1}
                </span>
                <span className="block truncate text-[10px] text-fg-faint">{item.type}</span>
              </th>
            ))}
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
        <tbody>
          {view.rows.map((row) => {
            const name = nameOf(row);
            const active = selected?.attemptId === row.attemptId;
            const presence = presenceOf(row, t);
            const progress = completionOf(row);
            const running = row.state === "in_progress";
            const finished = row.state === "submitted" || row.state === "expired";
            // The sticky cells must be OPAQUE: questions scroll under them.
            // The row's tints are translucent (`surface-2/70` on hover, and
            // `accent-soft` in dark mode), so they are painted here as a
            // layer over the card's surface (`.sticky-tint`, style.css) —
            // the exact colour of the row, with nothing showing through.
            const stick = cx(
              "sticky-tint",
              active
                ? "[--tint:var(--accent-soft)]"
                : "group-hover:[--tint:color-mix(in_srgb,var(--surface-2)_70%,transparent)]",
            );
            return (
              <tr
                key={row.seatId}
                className={cx(T.row, "group", active ? "bg-accent-soft" : T.rowHover)}
              >
                <th scope="row" className={cx(T.td, "sticky left-0 z-10 text-left font-normal", stick)}>
                  <span className="flex items-start gap-2">
                    <span
                      className={cx("mt-1.5 size-2 shrink-0 rounded-full", presence.tone)}
                      title={presence.label}
                      aria-label={presence.label}
                      role="img"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cx(
                            "truncate font-semibold",
                            row.state === "not_started" && "text-fg-muted",
                          )}
                        >
                          {name}
                        </span>
                        {row.state === "submitted" ? (
                          <Badge tone="green">{t("live.row.submitted")}</Badge>
                        ) : row.state === "expired" ? (
                          <Badge tone="zinc">{t("live.row.expired")}</Badge>
                        ) : null}
                        {row.timeBonusPercent > 0 ? (
                          <Badge tone="accent">
                            {t("live.row.bonus", { n: row.timeBonusPercent })}
                          </Badge>
                        ) : null}
                        {/* A teacher walking their own quiz (ADR-018). The
                            same badge the roster table uses, so "staff" means
                            one thing everywhere. The row counts in none of
                            the totals under the grid. */}
                        {row.staff ? (
                          <Badge tone="zinc" icon={GraduationCap}>
                            {t("roster.status.staff")}
                          </Badge>
                        ) : null}
                      </span>
                      {/* ONE meta line under the name, and it carries what
                          changes from row to row: how far this student has
                          got, plus a presence word only when presence is not
                          the norm — "connected" under twenty-four names is
                          twenty-four words carrying no information. */}
                      <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-fg-faint">
                        {row.attemptId === null ? null : (
                          <span
                            className="tabular-nums"
                            title={t("live.row.progressLabel", {
                              done: progress.done,
                              total: progress.total,
                            })}
                          >
                            {t("live.row.progress", {
                              done: progress.done,
                              total: progress.total,
                              percent: progress.percent,
                            })}
                          </span>
                        )}
                        {presence.line ? (
                          <span className="flex items-center gap-1">
                            {presence.warn ? (
                              <WifiOff className="size-3 text-warning" aria-hidden />
                            ) : null}
                            {presence.label}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </span>
                </th>
                <td className={cx(T.td, "text-right tabular-nums")}>
                  {row.points === null ? (
                    <span className="text-fg-faint">—</span>
                  ) : (
                    <span className="font-medium">
                      {row.points} / {row.maxPoints}
                    </span>
                  )}
                </td>
                <td className={cx(T.td, "hidden text-right tabular-nums sm:table-cell")}>
                  {row.deadlineAt === null || !running ? (
                    <span className="text-fg-faint">—</span>
                  ) : (
                    <Countdown
                      deadlineAt={Date.parse(row.deadlineAt)}
                      now={now}
                      paused={paused}
                      icon={false}
                      className="text-[13px]"
                    />
                  )}
                </td>
                {view.items.map((item, index) => {
                  const cell = row.cells.find((c) => c.itemId === item.id);
                  const label = `${name} · ${t("live.grid.question", { n: index + 1 })}`;
                  return (
                    <td key={item.id} className={cx(T.td, COL, "px-1 text-center")}>
                      {cell === undefined ? (
                        <span className="text-fg-faint">—</span>
                      ) : (
                        // The complete answer on hover or focus (#94), read
                        // on demand: only while the answers are shown, and
                        // only on a cell that has one. The wrapper is there
                        // EITHER WAY, so the button — and the keyboard focus
                        // on it — survives the first answer arriving.
                        <AnswerTip
                          evaluationId={view.evaluation.id}
                          attemptId={row.attemptId}
                          itemId={item.id}
                          fallback={cell.summary ?? ""}
                          revision={cell.revision}
                          enabled={showAnswers && !!cell.summary && row.attemptId !== null}
                        >
                          {(describedBy) => (
                            <VerdictCell
                              state={cellState(cell, showResults)}
                              value={cellValue(cell, showAnswers)}
                              label={label}
                              describedBy={describedBy}
                              onClick={
                                row.attemptId === null ? undefined : () => onInspect(row, item.id)
                              }
                            />
                          )}
                        </AnswerTip>
                      )}
                    </td>
                  );
                })}
                <td
                  className={cx(
                    T.td,
                    ACTIONS,
                    "px-1 sm:sticky sm:right-0 sm:z-10 sm:border-l sm:border-line",
                    stick,
                  )}
                >
                  <span className="flex items-center justify-end gap-0.5">
                    {row.attemptId === null ? null : (
                      <IconButton
                        size="sm"
                        label={t("live.row.inspect")}
                        onClick={() => onInspect(row, selected?.itemId ?? view.items[0]?.id ?? "")}
                      >
                        <Eye />
                      </IconButton>
                    )}
                    {running && live ? (
                      <IconButton
                        size="sm"
                        label={t("live.row.extend")}
                        onClick={() => onExtend(row)}
                      >
                        <Clock />
                      </IconButton>
                    ) : null}
                    {running ? (
                      <IconButton
                        size="sm"
                        danger
                        label={t("live.row.close")}
                        onClick={() => onClose(row)}
                      >
                        <DoorOpen />
                      </IconButton>
                    ) : null}
                    {finished && live ? (
                      <IconButton
                        size="sm"
                        danger
                        label={t("live.row.reopen")}
                        onClick={() => onReopen(row)}
                      >
                        <RotateCcw />
                      </IconButton>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
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
            <td className={cx(T.td, "text-right text-fg-faint")}>—</td>
            <td className={cx(T.td, "hidden text-right text-fg-faint sm:table-cell")}>—</td>
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
                        ? t("live.grid.successRateLive", { rate: percent(total.successRate) })
                        : t("live.grid.successRate", { rate: percent(total.successRate) })}
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
