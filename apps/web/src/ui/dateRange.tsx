import { ArrowRight, CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { useI18n, useT } from "../i18n";
import { Button, FieldLabel } from "./controls";
import { isoDateTime, weekStartsOn } from "./dates";
import { cx } from "./layers";
import { Popover } from "./popover";

/**
 * A period picked on ONE month calendar: click the first day, then the last,
 * and give each end its time. It is the generic half of the evaluation's
 * "opens / closes" pair; what the two ends mean is the caller's.
 *
 * Commit semantics are those of `DateField`: nothing is written while the
 * teacher moves about the calendar, the changed ends are written together
 * when the card closes (Escape, outside click, Done). A refused write puts
 * the stored values back through the `reset` the caller is handed.
 *
 * The trigger is two buttons, one per end, inside one group: each keeps its
 * own DOM id so a "missing" marker and the focus of the launch check point at
 * the right end, and each opens the card on its own end.
 */

/** A day as `YYYY-MM-DD` in the reader's zone: a plain string, ordered by `<`. */
type Day = string;

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date): Day => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Local noon: a day's anchor, safe from the DST edges of midnight. */
const dateOf = (day: Day): Date => new Date(`${day}T12:00:00`);

export function addDays(day: Day, n: number): Day {
  const d = dateOf(day);
  d.setDate(d.getDate() + n);
  return dayOf(d);
}

/** The same day-of-month `n` months on, clamped to the target month's last day. */
export function addMonths(day: Day, n: number): Day {
  const d = dateOf(day);
  const want = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(want, last));
  return dayOf(d);
}

/**
 * The weeks of the month of `day`, as rows of seven cells, `null` where the
 * row belongs to a neighbouring month. `weekStart`: 0 Sunday, 1 Monday.
 */
export function monthWeeks(day: Day, weekStart: 0 | 1): (Day | null)[][] {
  const first = dateOf(`${day.slice(0, 7)}-01`);
  const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() - weekStart + 7) % 7;
  const cells: (Day | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length }, (_, i) => `${day.slice(0, 7)}-${pad(i + 1)}`),
  ];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

interface Draft {
  startDay: Day | null;
  startTime: string;
  endDay: Day | null;
  endTime: string;
}

const split = (iso: string | null, fallbackTime: string): { day: Day | null; time: string } => {
  if (!iso) return { day: null, time: fallbackTime };
  const d = new Date(iso);
  return { day: dayOf(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
};

/** The instant of a day and a `HH:mm`, in the reader's zone; null while either is missing. */
const instant = (day: Day | null, time: string): string | null => {
  if (!day || !time) return null;
  const d = new Date(`${day}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * What a click on `day` does to the draft. `picking` says which end the
 * click is for; a last day before the first one starts the period over from
 * it, and a new first day drops a last day it passes.
 */
export function pickDay(
  draft: Draft,
  picking: "start" | "end",
  day: Day,
): { draft: Draft; picking: "start" | "end" } {
  if (picking === "end" && draft.startDay && day >= draft.startDay) {
    return { draft: { ...draft, endDay: day }, picking: "start" };
  }
  const endDay = draft.endDay && draft.endDay >= day && picking === "start" ? draft.endDay : null;
  return { draft: { ...draft, startDay: day, endDay }, picking: "end" };
}

export interface RangeEnd {
  /** DOM id of this end's button: the focus target of a missing-field check. */
  id: string;
  label: string;
  value: string | null;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

export interface RangeChange {
  /** Present only when this end changed. */
  start?: string | null;
  end?: string | null;
}

/** The trigger: receives the popover's ARIA state and lays it on both buttons. */
function RangeTrigger({
  label,
  start,
  end,
  disabled,
  onEnter,
  ...aria
}: {
  label: string;
  start: RangeEnd;
  end: RangeEnd;
  disabled: boolean;
  onEnter: (end: "start" | "end") => void;
}) {
  const t = useT();
  const segment = (which: "start" | "end", e: RangeEnd) => (
    <button
      type="button"
      {...aria}
      id={e.id}
      disabled={disabled}
      aria-invalid={e["aria-invalid"]}
      aria-describedby={e["aria-describedby"]}
      onFocus={() => onEnter(which)}
      onPointerDown={() => onEnter(which)}
      className="flex min-w-0 flex-1 flex-col items-start rounded-[inherit] px-3 py-1.5 text-left text-sm text-fg transition-colors hover:bg-surface-2/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="text-xs text-fg-muted">{e.label}</span>
      <span className={cx("tabular-nums", !e.value && "text-fg-faint")}>
        {e.value ? isoDateTime(e.value) : t("ui.range.empty")}
      </span>
    </button>
  );
  const invalid = start["aria-invalid"] || end["aria-invalid"];
  return (
    <div
      role="group"
      aria-label={label}
      className={cx(
        "flex items-stretch rounded-field border bg-surface",
        invalid ? "border-danger" : "border-line-strong",
      )}
    >
      {segment("start", start)}
      <ArrowRight aria-hidden className="size-4 shrink-0 self-center text-fg-faint" />
      {segment("end", end)}
    </div>
  );
}

export function DateRangeField({
  label,
  start,
  end,
  disabled = false,
  onCommit,
  defaultStartTime = "08:00",
  defaultEndTime = "23:59",
}: {
  /** What the period is ("Availability"): the name of the group and the card. */
  label: string;
  start: RangeEnd;
  end: RangeEnd;
  disabled?: boolean;
  /** Writes the changed ends; `reset` is for a refusal, to show the stored values again. */
  onCommit: (change: RangeChange, reset: () => void) => void;
  /** The time a freshly picked first / last day gets. */
  defaultStartTime?: string;
  defaultEndTime?: string;
}) {
  const t = useT();
  const { locale } = useI18n();
  // What the trigger shows: the stored values, and a write in flight until it is refused.
  const [shown, setShown] = useState({ start: start.value, end: end.value });
  useEffect(() => setShown({ start: start.value, end: end.value }), [start.value, end.value]);

  // The draft lives in the card, which is mounted only while it is open; this
  // holds its latest value for the moment the card closes.
  const latest = useRef<Draft | null>(null);
  const entry = useRef<"start" | "end">("start");

  const commit = () => {
    const d = latest.current;
    latest.current = null;
    if (!d) return;
    const nextStart = instant(d.startDay, d.startTime);
    const nextEnd = instant(d.endDay, d.endTime);
    const change: RangeChange = {};
    // A cleared end (the first day moved past it) is not written as a clear.
    if (nextStart && nextStart !== shown.start) change.start = nextStart;
    if (nextEnd && nextEnd !== shown.end) change.end = nextEnd;
    if (change.start === undefined && change.end === undefined) return;
    const before = { ...shown };
    setShown({ start: change.start ?? shown.start, end: change.end ?? shown.end });
    onCommit(change, () => setShown(before));
  };

  const trigger: ReactElement = (
    <RangeTrigger
      label={label}
      start={{ ...start, value: shown.start }}
      end={{ ...end, value: shown.end }}
      disabled={disabled}
      onEnter={(which) => {
        entry.current = which;
      }}
    />
  );

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <Popover
        label={label}
        align="start"
        height={420}
        onOpenChange={(isOpen) => {
          if (!isOpen) commit();
        }}
        trigger={trigger}
        className="w-[19.5rem] max-w-[calc(100vw-1rem)] p-3"
      >
        {(close) => (
          <RangePanel
            shown={shown}
            entry={entry.current}
            latest={latest}
            close={close}
            start={start.label}
            end={end.label}
            locale={locale}
            defaultStartTime={defaultStartTime}
            defaultEndTime={defaultEndTime}
          />
        )}
      </Popover>
    </div>
  );
}

function RangePanel({
  shown,
  entry,
  latest,
  close,
  start,
  end,
  locale,
  defaultStartTime,
  defaultEndTime,
}: {
  shown: { start: string | null; end: string | null };
  /** The end whose button opened the card: the one the first click is for. */
  entry: "start" | "end";
  latest: { current: Draft | null };
  close: () => void;
  start: string;
  end: string;
  locale: "en" | "fr";
  defaultStartTime: string;
  defaultEndTime: string;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(() => {
    const s = split(shown.start, defaultStartTime);
    const e = split(shown.end, defaultEndTime);
    return { startDay: s.day, startTime: s.time, endDay: e.day, endTime: e.time };
  });
  latest.current = draft;
  const [picking, setPicking] = useState<"start" | "end">(entry);
  const [focus, setFocus] = useState<Day>(
    () => (entry === "end" ? draft.endDay : draft.startDay) ?? draft.startDay ?? draft.endDay ?? dayOf(new Date()),
  );
  const grid = useRef<HTMLTableElement>(null);
  const moved = useRef(false);
  const weekStart = weekStartsOn();
  const today = dayOf(new Date());
  const weeks = monthWeeks(focus, weekStart);

  const monthName = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(dateOf(focus));
  const dayName = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    // 2023-01-01 is a Sunday.
    const d = new Date(2023, 0, 1 + ((i + weekStart) % 7), 12);
    return {
      short: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d),
      long: new Intl.DateTimeFormat(locale, { weekday: "long" }).format(d),
    };
  });

  // Keyboard moves land the focus on the new day once it is drawn.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-day="${focus}"]`)?.focus();
  }, [focus]);

  const go = (day: Day) => {
    moved.current = true;
    setFocus(day);
  };
  const pick = (day: Day) => {
    const next = pickDay(
      {
        ...draft,
        // A day picked for the first time takes the default time of its end.
        startTime: draft.startDay ? draft.startTime : defaultStartTime,
        endTime: draft.endDay ? draft.endTime : defaultEndTime,
      },
      picking,
      day,
    );
    setDraft(next.draft);
    setPicking(next.picking);
    setFocus(day);
  };

  const onKeyDown = (e: React.KeyboardEvent, day: Day) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) go(addDays(day, step[e.key]!));
    else if (e.key === "PageUp") go(addMonths(day, e.shiftKey ? -12 : -1));
    else if (e.key === "PageDown") go(addMonths(day, e.shiftKey ? 12 : 1));
    else if (e.key === "Home") go(addDays(day, -((dateOf(day).getDay() - weekStart + 7) % 7)));
    else if (e.key === "End") go(addDays(day, 6 - ((dateOf(day).getDay() - weekStart + 7) % 7)));
    else return;
    e.preventDefault();
  };

  const { startDay, endDay } = draft;
  const timeInput = (which: "start" | "end", name: string) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-fg-muted">
      <span className="truncate">{name}</span>
      <input
        type="time"
        aria-label={t("ui.range.time", { label: name })}
        value={which === "start" ? draft.startTime : draft.endTime}
        onChange={(e) => setDraft({ ...draft, [which === "start" ? "startTime" : "endTime"]: e.target.value })}
        className="h-7 w-full rounded-field border border-line-strong bg-surface px-2 text-sm tabular-nums text-fg focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20"
      />
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" aria-label={t("ui.range.prev")} onClick={() => setFocus(addMonths(focus, -1))}>
          <ChevronLeft />
        </Button>
        <p aria-live="polite" className="flex items-center gap-1.5 text-sm font-medium capitalize text-fg">
          <CalendarRange aria-hidden className="size-4 text-fg-faint" />
          {monthName}
        </p>
        <Button variant="ghost" size="sm" aria-label={t("ui.range.next")} onClick={() => setFocus(addMonths(focus, 1))}>
          <ChevronRight />
        </Button>
      </div>

      <table ref={grid} role="grid" aria-label={monthName} className="w-full table-fixed border-collapse text-center">
        <thead>
          <tr>
            {weekdays.map((w) => (
              <th key={w.long} scope="col" abbr={w.long} className="pb-1 text-xs font-medium capitalize text-fg-muted">
                {w.short.replace(/\.$/, "").slice(0, 3)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, w) => (
            <tr key={w}>
              {week.map((day, i) => {
                if (!day) return <td key={i} />;
                const isStart = day === startDay;
                const isEnd = day === endDay;
                const ranged = !!startDay && !!endDay && startDay !== endDay;
                const band = ranged && day >= startDay && day <= endDay;
                const edge = isStart || isEnd;
                return (
                  <td
                    key={day}
                    role="gridcell"
                    aria-selected={edge || band}
                    className={cx(
                      "p-0",
                      band && "bg-accent-soft",
                      ranged && isStart && "rounded-l-field",
                      ranged && isEnd && "rounded-r-field",
                    )}
                  >
                    <button
                      type="button"
                      data-day={day}
                      tabIndex={day === focus ? 0 : -1}
                      aria-current={day === today ? "date" : undefined}
                      aria-label={[dayName.format(dateOf(day)), isStart ? start : null, isEnd ? end : null]
                        .filter(Boolean)
                        .join(", ")}
                      onClick={() => pick(day)}
                      onKeyDown={(e) => onKeyDown(e, day)}
                      className={cx(
                        "mx-auto flex size-9 items-center justify-center rounded-field text-sm tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                        edge
                          ? "bg-accent font-semibold text-on-fill"
                          : cx("text-fg hover:bg-surface-2", day === today && "font-semibold underline underline-offset-4"),
                      )}
                    >
                      {Number(day.slice(8))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <p role="status" className="text-xs text-fg-muted">
        {t("ui.range.pick", { label: picking === "start" ? start : end })}
      </p>

      <div className="flex gap-3">
        {timeInput("start", start)}
        {timeInput("end", end)}
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={close}>
          {t("common.done")}
        </Button>
      </div>
    </div>
  );
}
