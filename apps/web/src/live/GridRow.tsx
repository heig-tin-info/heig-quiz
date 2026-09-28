import { memo } from "react";
import { Clock, DoorOpen, Eye, GraduationCap, RotateCcw, WifiOff } from "lucide-react";

import type { DashboardRow, DashboardView } from "@quiz/contracts";

import { useT } from "../i18n";
import { Badge, cx, IconButton, T, VerdictCell } from "../ui";
import { AnswerTip } from "./AnswerTip";
import { cellState, cellValue, completionOf } from "./cells";
import { ClockCountdown } from "./ClockCountdown";

/** Fixed width of a question column: two glyphs and the icon, and no more. */
export const COL = "w-16 min-w-16";

/**
 * Room for the widest row — three 28 px buttons and their gaps — held
 * whatever a given row shows, so a student handing in does not shift the
 * grid sideways under the teacher's pointer.
 */
export const ACTIONS = "w-26 min-w-26";

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

/**
 * One student's row of the grid: identity, score, time left, one cell per
 * question, the row's actions.
 *
 * Memoised, and fed only values and stable callbacks, because a grid is
 * thirty rows of twelve cells and the stream changes one row at a time: an
 * answer arriving re-renders ITS row, and the clock re-renders the row's
 * countdown alone — never the three hundred and sixty cells around it.
 */
export const GridRow = memo(function GridRow({
  row,
  items,
  name,
  active,
  inspectItemId,
  evaluationId,
  live,
  retakes,
  paused,
  clock,
  showAnswers,
  showResults,
  onInspect,
  onExtend,
  onClose,
  onReopen,
}: {
  row: DashboardRow;
  items: DashboardView["items"];
  /** The name or the anonymous number of the row. */
  name: string;
  /** The row whose cell is open in the inspection modal. */
  active: boolean;
  /** The question the row's inspect button opens on. */
  inspectItemId: string;
  evaluationId: string;
  /** The evaluation is running or paused. */
  live: boolean;
  /** An exercise with retakes: a finished row is retaken, never reopened. */
  retakes: boolean;
  /** The evaluation is paused: the countdown freezes with it (W16). */
  paused: boolean;
  /** Server time, stable; the countdown re-reads it on its own tick. */
  clock: () => number;
  showAnswers: boolean;
  showResults: boolean;
  onInspect: (row: DashboardRow, itemId: string) => void;
  onExtend: (row: DashboardRow) => void;
  onClose: (row: DashboardRow) => void;
  onReopen: (row: DashboardRow) => void;
}) {
  const t = useT();
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
    <tr className={cx(T.row, "group", active ? "bg-accent-soft" : T.rowHover)}>
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
              {/* F-EVAL-15: the row is the LATEST attempt; the
                  earlier ones are in the grading panel. */}
              {row.attemptCount > 1 ? (
                <Badge tone="zinc">{t("live.row.attempt", { n: row.attemptCount })}</Badge>
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
          <ClockCountdown
            deadlineAt={Date.parse(row.deadlineAt)}
            clock={clock}
            paused={paused}
            icon={false}
            className="text-[13px]"
          />
        )}
      </td>
      {items.map((item, index) => {
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
                evaluationId={evaluationId}
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
                    flagged={cell.flagged}
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
              onClick={() => onInspect(row, inspectItemId)}
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
          {finished && live && !retakes ? (
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
});
