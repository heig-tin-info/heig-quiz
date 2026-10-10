import { ArrowRight, CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import { useI18n, useT } from "../i18n";
import { Button } from "./controls";
import { fromLocalInput, isoDateTime, toLocalInput, weekStartsOn } from "./dates";
import { cx } from "./layers";
import { Popover } from "./popover";
import { TextInput } from "@quiz/ui";

/**
 * A period picked on ONE month calendar: click the first day, then the last,
 * and give each end its time. It is the generic half of the evaluation's
 * "opens / closes" pair; what the two ends mean is the caller's.
 *
 * Commit semantics are those of `DateField`: nothing is written while the
 * teacher moves about the calendar, the changed ends are written together
 * when the card closes (Escape, outside click, Done). A refused write puts
 * the stored values back through the `reset` the caller is handed. A draft
 * that is not a whole period (an end missing) is never written: closing the
 * card then discards it, and the trigger keeps showing the stored values —
 * what is shown is what is sent. "Changed" is judged in the reader's minutes,
 * as `DateField` does, so opening and closing the card writes nothing.
 *
 * The trigger is two buttons, one per end, inside one group: each keeps its
 * own DOM id so a "missing" marker and the focus of the launch check point at
 * the right end, and each opens the card on its own end.
 */

/** The time a freshly picked first / last day gets: the evaluation's convention (open in the morning, close at the day's end). */
const DEFAULT_START_TIME = "08:00";
const DEFAULT_END_TIME = "23:59";

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

/** The day and the `HH:mm` of an instant, in the reader's minutes (`toLocalInput`). */
const parts = (iso: string | null, fallbackTime: string): { day: Day | null; time: string } => {
  const local = toLocalInput(iso);
  return { day: local.slice(0, 10) || null, time: local.slice(11) || fallbackTime };
};

/** The `datetime-local` value of a draft end; "" while the day or the time is missing. */
const localOf = (day: Day | null, time: string): string => (day && time ? `${day}T${time}` : "");

/** A draft is a whole period when both ends have a day and a time. */
const complete = (d: Draft): boolean => !!localOf(d.startDay, d.startTime) && !!localOf(d.endDay, d.endTime);

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
  labelId,
  start,
  end,
  disabled,
  onEnter,
  ...aria
}: {
  labelId: string;
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
      aria-labelledby={labelId}
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

/**
 * The period picker. Keyed by its caller on the stored values, so a write
 * from elsewhere replaces what it shows (like `DateField`).
 */
export function DateRangeField({
  label,
  start,
  end,
  disabled = false,
  onCommit,
}: {
  /** What the period is ("Availability"): the name of the group and the card. */
  label: string;
  start: RangeEnd;
  end: RangeEnd;
  disabled?: boolean;
  /** Writes the changed ends; `reset` is for a refusal, to show the stored values again. */
  onCommit: (change: RangeChange, reset: () => void) => void;
}) {
  const labelId = useId();
  // What the trigger shows: the stored values, and a write in flight until it is refused.
  const [shown, setShown] = useState({ start: start.value, end: end.value });
  // The draft lives in the card, which is mounted only while it is open; this
  // holds its latest value for the moment the card closes.
  const latest = useRef<Draft | null>(null);
  const entry = useRef<"start" | "end">("start");

  const commit = () => {
    const d = latest.current;
    latest.current = null;
    // An unfinished period is discarded whole, never half written.
    if (!d || !complete(d)) return;
    const startLocal = localOf(d.startDay, d.startTime);
    const endLocal = localOf(d.endDay, d.endTime);
    const change: RangeChange = {};
    if (startLocal !== toLocalInput(shown.start)) change.start = fromLocalInput(startLocal);
    if (endLocal !== toLocalInput(shown.end)) change.end = fromLocalInput(endLocal);
    if (change.start === undefined && change.end === undefined) return;
    const before = { ...shown };
    setShown({ start: change.start ?? shown.start, end: change.end ?? shown.end });
    onCommit(change, () => setShown(before));
  };

  const trigger: ReactElement = (
    <RangeTrigger
      labelId={labelId}
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
      <span id={labelId} className="text-[13px] font-medium text-fg">
        {label}
      </span>
      <Popover
        label={label}
        align="start"
        height={420}
        disabled={disabled}
        onOpenChange={(isOpen) => {
          if (!isOpen) commit();
        }}
        trigger={trigger}
        className="w-[19.5rem] max-w-[calc(100vw-1rem)] p-3"
      >
        {(close, { keyboard }) => (
          <RangePanel
            shown={shown}
            entry={entry.current}
            keyboard={keyboard}
            latest={latest}
            close={close}
            start={start.label}
            end={end.label}
          />
        )}
      </Popover>
    </div>
  );
}

function RangePanel({
  shown,
  entry,
  keyboard,
  latest,
  close,
  start,
  end,
}: {
  shown: { start: string | null; end: string | null };
  /** The end whose button opened the card: the one the first click is for. */
  entry: "start" | "end";
  /** Opened from the keyboard: the focus goes to the day at once. */
  keyboard: boolean;
  latest: { current: Draft | null };
  close: () => void;
  start: string;
  end: string;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => {
    const s = parts(shown.start, DEFAULT_START_TIME);
    const e = parts(shown.end, DEFAULT_END_TIME);
    return { startDay: s.day, startTime: s.time, endDay: e.day, endTime: e.time };
  });
  latest.current = draft;
  const [picking, setPicking] = useState<"start" | "end">(entry);
  const [focus, setFocus] = useState<Day>(
    () => (entry === "end" ? draft.endDay : draft.startDay) ?? draft.startDay ?? draft.endDay ?? dayOf(new Date()),
  );
  const grid = useRef<HTMLTableElement>(null);
  // Set while a keyboard move is waiting for its day to be drawn.
  const moved = useRef(keyboard);
  const weekStart = weekStartsOn();
  const today = dayOf(new Date());
  const weeks = monthWeeks(focus, weekStart);

  const { dayName, weekdays } = useMemo(() => {
    const short = new Intl.DateTimeFormat(locale, { weekday: "short" });
    const long = new Intl.DateTimeFormat(locale, { weekday: "long" });
    return {
      dayName: new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      weekdays: Array.from({ length: 7 }, (_, i) => {
        // 2023-01-01 is a Sunday.
        const d = new Date(2023, 0, 1 + ((i + weekStart) % 7), 12);
        return { short: short.format(d).replace(/\.$/, "").slice(0, 3), long: long.format(d) };
      }),
    };
  }, [locale, weekStart]);
  const monthName = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(dateOf(focus));

  // Keyboard moves, and a keyboard opening, land the focus on the day once it is drawn.
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
    const next = pickDay(draft, picking, day);
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
      <TextInput
        type="time"
        aria-label={t("ui.range.time", { label: name })}
        value={which === "start" ? draft.startTime : draft.endTime}
        onChange={(e) => setDraft({ ...draft, [which === "start" ? "startTime" : "endTime"]: e.target.value })}
         size="sm" className="w-full tabular-nums"
      />
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" aria-label={t("ui.range.prev")} onClick={() => setFocus(addMonths(focus, -1))}>
          <ChevronLeft />
        </Button>
        <p className="flex items-center gap-1.5 text-sm font-medium capitalize text-fg">
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
                {w.short}
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
        <Button size="sm" variant="secondary" disabled={!complete(draft)} onClick={close}>
          {t("common.done")}
        </Button>
      </div>
    </div>
  );
}
