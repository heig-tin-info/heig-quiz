import type { ResultRow, ResultRowState } from "@quiz/contracts";

import { formatDuration, useT, type Dict, type TFunction } from "../i18n";
import { Badge, cx, SortHeader, T, useSortableTable, type Tone } from "../ui";

type Key = "name" | "email" | "points" | "grade" | "duration" | "state";

const STATE_KEYS: Record<ResultRowState, keyof Dict> = {
  absent: "results.state.absent",
  not_started: "results.state.not_started",
  in_progress: "results.state.in_progress",
  submitted: "results.state.submitted",
  expired: "results.state.expired",
};

const STATE_TONES: Record<ResultRowState, Tone> = {
  absent: "red",
  not_started: "zinc",
  in_progress: "amber",
  submitted: "green",
  expired: "amber",
};

export const stateLabel = (t: TFunction, s: ResultRowState) => t(STATE_KEYS[s]);

/**
 * One student per row (F-RES-02), absent students included: they are a 1.0
 * that belongs in the export and in the statistics, and a table that hides
 * them is not the class.
 *
 * Six columns, under the seven DESIGN.md allows. The name is the identity
 * column and carries the weight; the numbers are tabular and right-aligned;
 * the state is a badge and never a colour alone.
 */
export function GradeTable({ rows }: { rows: ResultRow[] }) {
  const t = useT();
  const { sorted, sort, toggle } = useSortableTable<ResultRow, Key>(
    rows,
    (row, key) =>
      key === "name"
        ? `${row.lastName} ${row.firstName}`
        : key === "email"
          ? row.email
          : key === "points"
            ? row.points
            : key === "grade"
              ? row.grade
              : key === "duration"
                ? (row.durationS ?? -1)
                : stateLabel(t, row.state),
    { key: "name", dir: 1 },
  );

  return (
    <div className={cx(T.container, "overflow-x-auto rounded-card border border-line bg-surface")}>
      <table className={T.table}>
        <thead className={T.head}>
          <tr>
            <SortHeader k="name" sort={sort} onToggle={toggle}>
              {t("results.col.student")}
            </SortHeader>
            {/* The e-mail is the column the table can do without: hiding it
                brings the grade back on screen without a sideways scroll. It
                goes last of the two, after the duration — a grade sheet is
                read by name, and the duration is the figure a teacher looks
                at once. Both measure the TABLE's width, not the phone's:
                this table also lives inside a tab beside a histogram. */}
            <SortHeader k="email" sort={sort} onToggle={toggle} className={T.colHigh}>
              {t("results.col.email")}
            </SortHeader>
            <SortHeader k="points" sort={sort} onToggle={toggle} right>
              {t("results.col.points")}
            </SortHeader>
            <SortHeader k="grade" sort={sort} onToggle={toggle} right>
              {t("results.col.grade")}
            </SortHeader>
            <SortHeader k="duration" sort={sort} onToggle={toggle} right className={T.colLow}>
              {t("results.col.duration")}
            </SortHeader>
            <SortHeader k="state" sort={sort} onToggle={toggle}>
              {t("results.col.state")}
            </SortHeader>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.userId} className={T.row}>
              <td className={cx(T.td, "font-semibold")}>{row.displayName}</td>
              <td className={cx(T.td, "text-fg-muted", T.colHigh)}>{row.email}</td>
              <td className={cx(T.td, "text-right tabular-nums")}>
                {Math.round(row.points * 100) / 100}
              </td>
              <td className={cx(T.td, "text-right font-semibold tabular-nums")}>
                {row.grade.toFixed(1)}
              </td>
              <td className={cx(T.td, "text-right tabular-nums text-fg-muted", T.colLow)}>
                {row.durationS === null ? "—" : formatDuration(row.durationS * 1000, t)}
              </td>
              <td className={T.td}>
                <Badge tone={STATE_TONES[row.state]}>{stateLabel(t, row.state)}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
