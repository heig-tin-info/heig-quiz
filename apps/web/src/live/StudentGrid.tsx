import { Clock, DoorOpen, Eye, RotateCcw, WifiOff } from "lucide-react";

import type { DashboardRow } from "@quiz/contracts";

import { useT } from "../i18n";
import type { GridState } from "../realtime/grid";
import { Badge, Countdown, cx, Menu, T, VerdictCell } from "../ui";
import { cellState, cellValue } from "./cells";

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
 * The row's overflow menu sits INSIDE the sticky column rather than at the
 * end of the row: an action you have to scroll sideways to reach is an action
 * you do not take while twenty-four people are waiting.
 *
 * Every cell is a plain `VerdictCell`; none of them fetches anything. The
 * whole grid is a pure function of the state `useDashboard` walks forward.
 */

/** Fixed width of a question column: two glyphs and the icon, and no more. */
const COL = "w-16 min-w-16";

function presenceDot(row: DashboardRow, t: ReturnType<typeof useT>) {
  const label = row.online
    ? t("live.row.online")
    : row.lastSeenAt === null
      ? t("live.row.never")
      : t("live.row.offline");
  return (
    <span
      className={cx(
        "mt-1.5 size-2 shrink-0 rounded-full",
        row.online ? "bg-success" : row.lastSeenAt === null ? "bg-line-strong" : "bg-warning",
      )}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

export function StudentGrid({
  state,
  now,
  paused,
  showNames,
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
  showNames: boolean;
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
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => {
            const name = showNames ? row.displayName : row.pseudonym;
            const active = selected?.attemptId === row.attemptId;
            return (
              <tr
                key={row.userId}
                className={cx(T.row, "group", active ? "bg-accent-soft" : T.rowHover)}
              >
                <th
                  scope="row"
                  className={cx(
                    T.td,
                    "sticky left-0 z-10 text-left font-normal",
                    active ? "bg-accent-soft" : "bg-surface group-hover:bg-surface-2/70",
                  )}
                >
                  <span className="flex items-start gap-2">
                    {presenceDot(row, t)}
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
                      </span>
                      {/* Only what is NOT the norm gets a second line: with
                          twenty-four rows, "connected" under every name is
                          twenty-four words carrying no information. */}
                      {row.online && row.state !== "not_started" ? null : (
                        <span className="flex items-center gap-1 text-[11px] text-fg-faint">
                          {!row.online && row.lastSeenAt !== null ? (
                            <WifiOff className="size-3 text-warning" aria-hidden />
                          ) : null}
                          {row.state === "not_started"
                            ? t("live.row.never")
                            : t("live.row.offline")}
                        </span>
                      )}
                    </span>
                    <Menu
                      label={t("live.row.actions", { name })}
                      items={[
                        {
                          label: t("live.row.inspect"),
                          icon: Eye,
                          disabled: row.attemptId === null,
                          onSelect: () =>
                            onInspect(row, selected?.itemId ?? view.items[0]?.id ?? ""),
                        },
                        {
                          label: t("live.row.extend"),
                          icon: Clock,
                          disabled: row.attemptId === null,
                          onSelect: () => onExtend(row),
                        },
                        {
                          label: t("live.row.close"),
                          icon: DoorOpen,
                          disabled: row.state !== "in_progress",
                          onSelect: () => onClose(row),
                        },
                        {
                          label: t("live.row.reopen"),
                          icon: RotateCcw,
                          separator: true,
                          disabled: row.attemptId === null || row.state === "in_progress",
                          onSelect: () => onReopen(row),
                        },
                      ]}
                    />
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
                  {row.deadlineAt === null || row.state !== "in_progress" ? (
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
                        <VerdictCell
                          state={cellState(cell, showResults)}
                          value={cellValue(cell, showAnswers)}
                          label={label}
                          onClick={
                            row.attemptId === null ? undefined : () => onInspect(row, item.id)
                          }
                        />
                      )}
                    </td>
                  );
                })}
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
                · {t("live.grid.students", { n: view.rows.length })}
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
                  <span className="block text-[10px] text-fg-faint">
                    {total?.successRate == null
                      ? t("live.grid.afterClose")
                      : t("live.grid.successRate", { rate: percent(total.successRate) })}
                  </span>
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
