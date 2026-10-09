import { memo } from "react";
import { Clock, DoorOpen, Eye, GraduationCap, Monitor, MonitorCheck, RotateCcw, ShieldAlert, WifiOff } from "lucide-react";

import type { DashboardRow, DashboardView } from "@quiz/contracts";

import { useT } from "../i18n";
import { Badge, ClockCountdown, cx, IconButton, T, VerdictCell } from "../ui";
import { AnswerTip } from "./AnswerTip";
import { IncidentBadge } from "./Incidents";
import { cellState, cellValue, completionOf, ownDeadline } from "./cells";

/** Fixed width of a question column: two glyphs and the icon, and no more. */
export const COL = "w-16 min-w-16";

/**
 * Room for the widest row — three buttons of at most 28 px (`ROW_BUTTON`:
 * the cell height, never under 24 px) and their gaps — held whatever a given
 * row shows, so a student handing in does not shift the grid sideways under
 * the teacher's pointer.
 */
export const ACTIONS = "w-26 min-w-26";
/** The same, with room for a fourth button: "Assign a station", on an exam that accepts the kiosk (ADR-051 §7). */
export const ACTIONS_KIOSK = "w-30 min-w-30";

/**
 * How the row's student sits the exam (ADR-051 §8), beside the name: nothing
 * for the portal — the default, and most of the class — a `SEB` badge, or the
 * station's label behind a monitor; then, on a station, what its attestation
 * says when it is not fine: suspended (writes refused) or not attested
 * (Google cannot check it, nothing blocked).
 */
function AccessBadges({ access, t }: { access: DashboardRow["access"]; t: ReturnType<typeof useT> }) {
  if (access.kind === "portal") return null;
  return (
    <>
      {access.kind === "seb" ? (
        <span title={t("live.access.sebHint")} className="shrink-0">
          <Badge tone="zinc">{t("live.access.seb")}</Badge>
        </span>
      ) : (
        <span title={t("live.access.kioskHint", { label: access.station ?? "—" })} className="min-w-0 shrink">
          <Badge tone="zinc" icon={Monitor} className="max-w-32">
            <span className="truncate">{access.station ?? "—"}</span>
          </Badge>
        </span>
      )}
      {access.alert !== null ? (
        <span
          title={t(access.alert === "suspended" ? "live.access.suspendedHint" : "live.access.unavailableHint")}
          className="shrink-0"
        >
          <Badge tone={access.alert === "suspended" ? "red" : "amber"} icon={ShieldAlert}>
            {t(access.alert === "suspended" ? "live.access.suspended" : "live.access.unavailable")}
          </Badge>
        </span>
      ) : null}
    </>
  );
}

/**
 * The progress column (#227): "75 %", right-aligned. It used to be a meta
 * line under the name, which made every row two lines tall. The fraction
 * "9/12" beside it said the same thing twice, so it lives in the tooltip
 * only, and the column is the width of "100 %".
 */
export const PROGRESS = "w-16 min-w-16";

/**
 * A body cell of the grid. `T.td` without its padding: the row's height is
 * `--row-h`, set to fit the class on one screen, and vertical padding would
 * fight it — the cells centre their content instead. Each cell says its own
 * horizontal padding.
 */
const TD = "align-middle";

/**
 * The row's buttons follow the cells down, but never under 24 px: that is
 * the smallest row, and a smaller target is a missed click.
 */
const ROW_BUTTON = "size-[max(1.5rem,var(--cell-h,1.75rem))]!";

/**
 * What the dot beside the name says — and whether it is worth more than the
 * dot.
 *
 * A student who has HANDED IN is not "offline": their stream closes the
 * moment they submit, and marking twenty finished rows tells the teacher
 * about the browser rather than about the exam. So presence is reported
 * while the attempt is running, "never connected" while there is no attempt
 * at all, and nothing once the attempt is over — the `handed in` / `closed`
 * badge beside the name already carries that.
 *
 * The word is always the dot's accessible name and tooltip. It is no longer
 * printed under the name (#227: that line made every row two tall): offline,
 * the one presence a teacher must act on, adds a `WifiOff` beside the name;
 * "never connected" and "not signed in" mute the name, which is what they
 * mean — this person is not in the exam.
 */
function presenceOf(
  row: DashboardRow,
  t: ReturnType<typeof useT>,
): { tone: string; label: string; warn: boolean } {
  if (row.userId === null) {
    return { tone: "bg-line-strong", label: t("live.row.unclaimed"), warn: false };
  }
  if (row.state === "not_started") {
    return { tone: "bg-line-strong", label: t("live.row.never"), warn: false };
  }
  if (row.state === "submitted" || row.state === "expired") {
    const label = row.state === "submitted" ? t("live.row.submitted") : t("live.row.expired");
    return { tone: "bg-line-strong", label, warn: false };
  }
  return row.online
    ? { tone: "bg-success", label: t("live.row.online"), warn: false }
    : { tone: "bg-warning", label: t("live.row.offline"), warn: true };
}

/**
 * One student's row of the grid: identity, progress, score (once there is
 * one), one cell per question, the row's actions. One line tall, always.
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
  commonDeadline,
  showScore,
  live,
  reopenable,
  paused,
  clock,
  showAnswers,
  showResults,
  onCell,
  onInspect,
  onExtend,
  onClose,
  onReopen,
  onAssign,
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
  /** The header's one clock; the row shows its own only when it differs. */
  commonDeadline: string | null;
  /** Some row has points: the Score column exists (#227). */
  showScore: boolean;
  /** The evaluation is running or paused. */
  live: boolean;
  /** The server's `reopenable`: false with retakes (ADR-025) or a published correction (ADR-050). */
  reopenable: boolean;
  /** The evaluation is paused: the countdown freezes with it (W16). */
  paused: boolean;
  /** Server time, stable; the countdown re-reads it on its own tick. */
  clock: () => number;
  showAnswers: boolean;
  showResults: boolean;
  /** A cell: that one answer (F-DASH-05, issue #353). */
  onCell: (row: DashboardRow, itemId: string) => void;
  /** The row's eye: the whole paper, opened on `inspectItemId` (at its top without one). */
  onInspect: (row: DashboardRow, itemId?: string) => void;
  onExtend: (row: DashboardRow) => void;
  /** With the name the row shows, for the confirmation that asks first. */
  onClose: (row: DashboardRow, name: string) => void;
  onReopen: (row: DashboardRow, name: string) => void;
  /** The exam accepts the kiosk: the supervisor may pair a station for this student (ADR-051 §7). */
  onAssign?: ((row: DashboardRow, name: string) => void) | undefined;
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
    <tr className={cx(T.row, "group h-[var(--row-h,2.25rem)]", active ? "bg-accent-soft" : T.rowHover)}>
      <th scope="row" className={cx(TD, "sticky left-0 z-10 px-3 text-left font-normal", stick)}>
        {/* ONE line, whatever the row carries (#227). The table is
            `min-w-max`, so a cell never squeezes its content: the name is
            CAPPED instead, and truncates past it (the whole name in its
            tooltip), while everything after it keeps its size. A long name
            with three badges loses letters, rather than making the row two
            lines tall or the sticky column wider. */}
        <span className="flex min-w-0 flex-nowrap items-center gap-1.5">
          <span
            className={cx("size-2 shrink-0 rounded-full", presence.tone)}
            title={presence.label}
            aria-label={presence.label}
            role="img"
          />
          <span
            className={cx(
              "min-w-0 max-w-28 truncate font-semibold sm:max-w-40",
              row.state === "not_started" && "text-fg-muted",
            )}
            title={name}
          >
            {name}
          </span>
          {presence.warn ? (
            // The word is the dot's accessible name already; the icon is for
            // the eye, and its tooltip for the pointer.
            <span className="shrink-0 text-warning" title={presence.label}>
              <WifiOff className="size-3.5" aria-hidden />
            </span>
          ) : null}
          <AccessBadges access={row.access} t={t} />
          {/* F-EVAL-15: the row is the LATEST attempt; the
              earlier ones are in the grading panel. */}
          {row.attemptCount > 1 ? (
            <Badge tone="zinc">{t("live.row.attempt", { n: row.attemptCount })}</Badge>
          ) : null}
          {row.timeBonusPercent > 0 ? (
            <Badge tone="accent">{t("live.row.bonus", { n: row.timeBonusPercent })}</Badge>
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
          {/* The integrity journal (ADR-088 §7): neutral, a count, and the
              door to the paper, opened at its top: the Journal section. */}
          <IncidentBadge count={row.incidents} name={name} onOpen={() => onInspect(row)} />
          {/* Where the row stands, pushed to the end of the line so the
              pills line up in one column instead of trailing names of every
              length: handed in or closed once it is over, and while it runs
              its own time left, only when it is not the header's (#227,
              F-DASH-03) — an extension, a bonus, a late start. */}
          {row.state === "submitted" ? (
            <Badge tone="green" className="ml-auto">
              {t("live.row.submitted")}
            </Badge>
          ) : row.state === "expired" ? (
            <Badge tone="zinc" className="ml-auto">
              {t("live.row.expired")}
            </Badge>
          ) : null}
          {running && ownDeadline(row.deadlineAt, commonDeadline) ? (
            <span className="ml-auto shrink-0 pl-1" title={t("live.row.ownDeadline")}>
              {/* Said, not only hovered: the timer's own name is "12:00
                  remaining", and why this row has one is the point. */}
              <span className="sr-only">{t("live.row.ownDeadline")}</span>
              <ClockCountdown
                deadlineAt={Date.parse(row.deadlineAt)}
                clock={clock}
                paused={paused}
                icon={false}
                className="text-[12px]"
              />
            </span>
          ) : null}
        </span>
      </th>
      <td className={cx(TD, PROGRESS, "whitespace-nowrap px-3 text-right tabular-nums")}>
        {row.attemptId === null ? (
          <span className="text-fg-faint">—</span>
        ) : (
          <span
            title={t("live.row.progressLabel", { done: progress.done, total: progress.total })}
          >
            {progress.percent} %
          </span>
        )}
      </td>
      {showScore ? (
        <td className={cx(TD, "px-3 text-right tabular-nums")}>
          {row.points === null ? (
            <span className="text-fg-faint">—</span>
          ) : (
            <span className="font-medium">
              {row.points} / {row.maxPoints}
            </span>
          )}
        </td>
      ) : null}
      {items.map((item, index) => {
        const cell = row.cells.find((c) => c.itemId === item.id);
        const label = `${name} · ${t("live.grid.question", { n: index + 1 })}`;
        return (
          <td key={item.id} className={cx(TD, COL, "px-1 text-center")}>
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
                      row.attemptId === null ? undefined : () => onCell(row, item.id)
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
          TD,
          onAssign ? ACTIONS_KIOSK : ACTIONS,
          "px-1 sm:sticky sm:right-0 sm:z-10 sm:border-l sm:border-line",
          stick,
        )}
      >
        <span className="touch-group flex items-center justify-end gap-0.5">
          {/* First: a student whose laptop just died is the one the
              supervisor is standing beside, with the station's code. */}
          {onAssign && live && !finished && row.userId !== null ? (
            <IconButton
              size="sm"
              className={ROW_BUTTON}
              label={t("live.row.assign")}
              onClick={() => onAssign(row, name)}
            >
              <MonitorCheck />
            </IconButton>
          ) : null}
          {row.attemptId === null ? null : (
            <IconButton
              size="sm"
              className={ROW_BUTTON}
              label={t("live.row.inspect")}
              onClick={() => onInspect(row, inspectItemId)}
            >
              <Eye />
            </IconButton>
          )}
          {running && live ? (
            <IconButton
              size="sm"
              className={ROW_BUTTON}
              label={t("live.row.extend")}
              onClick={() => onExtend(row)}
            >
              <Clock />
            </IconButton>
          ) : null}
          {running ? (
            <IconButton
              size="sm"
              className={ROW_BUTTON}
              danger
              label={t("live.row.close")}
              onClick={() => onClose(row, name)}
            >
              <DoorOpen />
            </IconButton>
          ) : null}
          {finished && live && reopenable ? (
            <IconButton
              size="sm"
              className={ROW_BUTTON}
              danger
              label={t("live.row.reopen")}
              onClick={() => onReopen(row, name)}
            >
              <RotateCcw />
            </IconButton>
          ) : null}
        </span>
      </td>
    </tr>
  );
});
