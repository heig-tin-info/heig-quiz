/**
 * Each student's drill in a classroom, one row each (ADR-041 §8, #317
 * slice 4): who practises (questions seen, sessions, reviews of the last 30
 * days, last activity) and who progresses (the recall rate on repeated
 * reviews over 30 days, with its trend against the 30 days before). An
 * opt-out is a badge with its date on the name (§13, item 5), visible at
 * every width. A row opens the student's weekly progression.
 */
import type { DrillStudentActivity } from "@quiz/contracts";
import { drillRecallRate, drillRecallTrend, type DrillTrend } from "@quiz/domain";
import { MoveRight, TrendingDown, TrendingUp } from "lucide-react";

import { useI18n, useT } from "../i18n";
import {
  Badge,
  type Column,
  cx,
  Dash,
  isoDateParts,
  percent,
  RelativeTime,
  T,
  TableHead,
  Tip,
  useSortableTable,
} from "../ui";

type SortKey = "name" | "recall" | "sessions" | "questionsSeen" | "reviews30" | "lastReviewAt";

export const studentName = (row: DrillStudentActivity) => `${row.prenom} ${row.nom}`;

const TREND_ICON = { up: TrendingUp, down: TrendingDown, flat: MoveRight } as const;
const TREND_TONE = { up: "text-success", down: "text-warning", flat: "text-fg-faint" } as const;

/** The small arrow beside a recall rate; its words are in the accessible name. */
export function TrendMark({ trend }: { trend: DrillTrend | null }) {
  const t = useT();
  if (trend === null) return null;
  const Icon = TREND_ICON[trend];
  const label = t(`drill.trend.${trend}`);
  return (
    <Tip label={label}>
      <span className={cx("inline-flex", TREND_TONE[trend])}>
        <Icon aria-hidden className="size-3.5" />
        <span className="sr-only">{label}</span>
      </span>
    </Tip>
  );
}

/** "Opted out on 2026-09-12": the opt-out and its date, never a colour alone. */
function OptedOutBadge({ at }: { at: string }) {
  const t = useT();
  return <Badge tone="zinc">{t("drill.optedOut", { date: isoDateParts(at).date })}</Badge>;
}

export function DrillActivityTable({
  rows,
  onOpen,
}: {
  rows: DrillStudentActivity[];
  onOpen: (row: DrillStudentActivity) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { sorted, sort, toggle } = useSortableTable<DrillStudentActivity, SortKey>(
    rows,
    (r, k) => {
      switch (k) {
        case "name":
          return `${r.nom} ${r.prenom}`;
        case "recall":
          // No rate sorts below every rate, 0 % included.
          return drillRecallRate(r.recall.last30) ?? -1;
        case "reviews30":
          return r.reviews.last30;
        case "lastReviewAt":
          return r.lastReviewAt ?? "";
        default:
          return r[k];
      }
    },
    { key: "name", dir: 1 },
    (x, y) =>
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, { sensitivity: "base" }),
  );
  const columns: Column<SortKey>[] = [
    { key: "name", label: t("drill.col.student") },
    { key: "recall", label: t("drill.col.recall"), right: true },
    { key: "sessions", label: t("drill.col.sessions"), right: true, className: T.colHigh },
    { key: "questionsSeen", label: t("drill.col.questions"), right: true, className: T.colMid },
    { key: "reviews30", label: t("drill.col.reviews30"), right: true, className: T.colLow },
    { key: "lastReviewAt", label: t("drill.col.last"), className: T.colHigh },
  ];

  return (
    /* The name and the recall rate are the row; the sessions and the last
       activity leave last, the counts first. */
    <div className={cx(T.container, "overflow-x-auto")}>
      <table className={T.table}>
        <TableHead columns={columns} sort={sort} onToggle={toggle} />
        <tbody>
          {sorted.map((r) => {
            const rate = drillRecallRate(r.recall.last30);
            return (
              <tr key={r.enrollmentId} className={cx(T.row, T.rowHover, "cursor-pointer")} onClick={() => onOpen(r)}>
                <td className={T.td}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button
                      type="button"
                      className="text-left font-semibold hover:underline"
                      aria-label={t("drill.open", { name: studentName(r) })}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(r);
                      }}
                    >
                      {r.nom} <span className="font-normal">{r.prenom}</span>
                    </button>
                    {r.optedOutAt ? <OptedOutBadge at={r.optedOutAt} /> : null}
                  </div>
                </td>
                <td className={cx(T.td, "text-right tabular-nums")}>
                  <span className="inline-flex items-center justify-end gap-1.5">
                    <TrendMark trend={drillRecallTrend(r.recall.last30, r.recall.previous30)} />
                    {rate === null ? <Dash /> : percent(rate, locale)}
                  </span>
                </td>
                <td className={cx(T.td, "text-right tabular-nums", T.colHigh)}>{r.sessions || "—"}</td>
                <td className={cx(T.td, "text-right tabular-nums", T.colMid)}>{r.questionsSeen || "—"}</td>
                <td className={cx(T.td, "text-right tabular-nums", T.colLow)}>{r.reviews.last30 || "—"}</td>
                <td className={cx(T.td, "whitespace-nowrap text-fg-muted", T.colHigh)}>
                  {r.lastReviewAt ? <RelativeTime iso={r.lastReviewAt} /> : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
