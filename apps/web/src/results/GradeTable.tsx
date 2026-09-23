import { GraduationCap } from "lucide-react";

import type { ResultRow, ResultRowState } from "@quiz/contracts";
import { formatGrade, formatPoints } from "@quiz/domain";

import { formatDuration, useT, type Dict, type TFunction } from "../i18n";
import { Badge, cx, T, TableHead, useSortableTable, type Column, type Tone } from "../ui";

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

const resultStateLabel = (t: TFunction, s: ResultRowState) => t(STATE_KEYS[s]);

/**
 * One student per row (F-RES-02), absent students included: they are a 1.0
 * that belongs in the export and in the statistics, and a table that hides
 * them is not the class. A teacher's own test walk is a row too, badged
 * `staff`, and it is in none of the two (ADR-018).
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
                : resultStateLabel(t, row.state),
    { key: "name", dir: 1 },
  );

  const columns: Column<Key>[] = [
    { key: "name", label: t("results.col.student") },
    /* The e-mail is the column the table can do without: hiding it brings
       the grade back on screen without a sideways scroll. It goes last of
       the two, after the duration — a grade sheet is read by name, and the
       duration is the figure a teacher looks at once. Both measure the
       TABLE's width, not the phone's: this table also lives inside a tab
       beside a histogram. */
    { key: "email", label: t("results.col.email"), className: T.colHigh },
    { key: "points", label: t("results.col.points"), right: true },
    { key: "grade", label: t("results.col.grade"), right: true },
    { key: "duration", label: t("results.col.duration"), right: true, className: T.colLow },
    { key: "state", label: t("results.col.state") },
  ];

  return (
    <div className={cx(T.container, "overflow-x-auto rounded-card border border-line bg-surface")}>
      <table className={T.table}>
        <TableHead columns={columns} sort={sort} onToggle={toggle} />
        <tbody>
          {sorted.map((row) => (
            <tr key={row.userId} className={T.row}>
              <td className={cx(T.td, "font-semibold")}>
                <span className="inline-flex items-center gap-1.5">
                  {row.displayName}
                  {/* A teacher's own test walk (ADR-018): listed, badged, and
                      in neither the statistics above nor the CSV. */}
                  {row.staff ? (
                    <Badge tone="zinc" icon={GraduationCap}>
                      {t("roster.status.staff")}
                    </Badge>
                  ) : null}
                </span>
              </td>
              <td className={cx(T.td, "text-fg-muted", T.colHigh)}>{row.email}</td>
              <td className={cx(T.td, "text-right tabular-nums")}>
                {formatPoints(row.points)}
              </td>
              <td className={cx(T.td, "text-right font-semibold tabular-nums")}>
                {formatGrade(row.grade)}
              </td>
              <td className={cx(T.td, "text-right tabular-nums text-fg-muted", T.colLow)}>
                {row.durationS === null ? "—" : formatDuration(row.durationS * 1000, t)}
              </td>
              <td className={T.td}>
                <Badge tone={STATE_TONES[row.state]}>{resultStateLabel(t, row.state)}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
