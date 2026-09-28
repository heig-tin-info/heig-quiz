import { CalendarRange, ChevronDown, ChevronRight, Crosshair, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ActivitySummary } from "@quiz/contracts";

import { evaluationHome, evaluationStateLabel } from "../evaluation/common";
import { useI18n, useT } from "../i18n";
import type { Route } from "../router";
import { Card, cx, EmptyState, IconButton, isoDateTime } from "../ui";
import { bucketOf } from "./model";
import { classroomLabel, MODE_ICON } from "./views";

/**
 * The schedule of the Activities section (#190) as a gantt: one row per
 * classroom and, unfolded, one lane per activity, on a time axis that pans
 * (wheel, drag) and zooms (ctrl/⌘ + wheel, the buttons), with the crosshair
 * re-framing on what is in progress and an ink line for "now".
 *
 * It MIRRORS heig-classroom's `apps/web/src/Timeline.tsx` — same view model
 * (`computeDefault`, `buildTicks`), same gestures, same row heights — with
 * quiz's words (every label through `t()`), quiz's tokens (a bar wears its
 * state's tone, never the accent, which belongs to a primary action), and
 * activities instead of assignments. It is destined for `@heig-platform/ui`
 * (ADR-029): kept in one file, with the domain adapter (`spanOf`) apart from
 * the drawing, so the two copies can be merged at extraction.
 *
 * Hand-rolled with CSS and pointer events, as there: the gantt libraries
 * either bring their own theme or are unmaintained.
 */

const DAY = 86_400_000;
const MIN_SPAN = 3 * DAY;
const MAX_SPAN = 6 * 365 * DAY;
/** The narrowest bar, in % of the track: a one-hour poll is still a target. */
const MIN_BAR = 1.2;

// Row heights, shared by the label column and the track column so the two
// stay pixel-aligned. Keep these in sync with the Tailwind classes below.
const AXIS_H = "h-6"; // 24px
const ROOM_H = "h-8"; // 32px
const LANE_H = "h-9"; // 36px

type View = { from: number; to: number };
type Tick = { t: number; label: boolean; text: string; major: boolean };
type Span = { s: number; d: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * Where an activity sits in time — the one adapter between the domain and
 * the drawing. From its opening (or its actual start) to its closing; an
 * OPEN one without a closing runs up to now, and one without any date at all
 * (an exam in its lobby) sits on now, so whatever is in the room is always
 * on the axis around the "now" line. An ended one without a closing stops at
 * its last change. A draft nobody dated has no place: null.
 */
export function spanOf(a: ActivitySummary, now: number): Span | null {
  const open = bucketOf(a.state) === "open";
  const start = a.opensAt ?? a.startedAt;
  if (start === null && !open) return null;
  const s = start === null ? now : new Date(start).getTime();
  const end =
    a.closesAt !== null
      ? new Date(a.closesAt).getTime()
      : open
        ? now
        : bucketOf(a.state) === "ended"
          ? new Date(a.updatedAt).getTime()
          : s;
  return { s, d: Math.max(s, end) };
}

/** Default window: frame what is in progress (or nearest to now), always keeping now inside. */
function computeDefault(spans: Span[], now: number): View {
  const ongoing = spans.filter(({ s, d }) => s <= now && now <= d);
  const near = spans.filter(({ s, d }) => Math.abs(s - now) < 30 * DAY || Math.abs(d - now) < 30 * DAY);
  const focus = ongoing.length ? ongoing : near;
  let lo = focus.length ? Math.min(...focus.map((x) => x.s)) : now - 21 * DAY;
  let hi = focus.length ? Math.max(...focus.map((x) => x.d)) : now + 21 * DAY;
  lo = Math.min(lo, now);
  hi = Math.max(hi, now);
  const pad = Math.max((hi - lo) * 0.12, 2 * DAY);
  let from = lo - pad;
  let to = hi + pad;
  if (to - from < MIN_SPAN) {
    const c = (from + to) / 2;
    from = c - MIN_SPAN / 2;
    to = c + MIN_SPAN / 2;
  }
  return { from, to };
}

/** Grid ticks whose granularity follows the zoom: days, then months, then years. */
function buildTicks(from: number, to: number, locale: string): Tick[] {
  const month = (d: Date) => d.toLocaleDateString(locale, { month: "short" });
  const spanDays = (to - from) / DAY;
  const ticks: Tick[] = [];
  if (spanDays <= 75) {
    const dense = spanDays <= 16;
    const d = startOfDay(from);
    while (d.getTime() <= to) {
      const t = d.getTime();
      if (t >= from) {
        const firstOfMonth = d.getDate() === 1;
        // A Monday label right next to a "1 Sep" label overlaps it: the
        // month boundary wins over the week boundary on the days around it.
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        const mondayClear = d.getDay() === 1 && d.getDate() >= 3 && d.getDate() <= lastDay - 1;
        const label = dense || mondayClear || firstOfMonth;
        const text = dense && !firstOfMonth ? String(d.getDate()) : `${d.getDate()} ${month(d)}`;
        ticks.push({ t, label, text, major: firstOfMonth });
      }
      d.setDate(d.getDate() + 1);
    }
  } else if (spanDays <= 730) {
    const d = new Date(from);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= to) {
      const t = d.getTime();
      if (t >= from) {
        const jan = d.getMonth() === 0;
        ticks.push({ t, label: true, text: jan ? `${month(d)} ${d.getFullYear()}` : month(d), major: jan });
      }
      d.setMonth(d.getMonth() + 1);
    }
  } else {
    const d = new Date(from);
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= to) {
      const t = d.getTime();
      if (t >= from) ticks.push({ t, label: true, text: String(d.getFullYear()), major: true });
      d.setFullYear(d.getFullYear() + 1);
    }
  }
  return ticks;
}

/**
 * The fill of a bar, by its state's tone (evaluation/common.ts): green in
 * the room, amber waiting or paused, a calm blue for what is planned, a
 * dashed outline for a draft, the recessed surface for what is over.
 */
function barClass(a: ActivitySummary): string {
  if (a.state === "draft") return "border border-dashed border-fg-faint bg-surface text-fg-muted";
  if (a.state === "running") return "bg-success text-on-fill";
  if (bucketOf(a.state) === "open") return "bg-warning text-on-fill";
  if (a.state === "scheduled") return "bg-info-soft text-info ring-1 ring-inset ring-info";
  return "bg-surface-3 text-fg-muted";
}

/** The dot beside a lane's name: the bar's colour, at full strength for the pale ones. */
function dotClass(a: ActivitySummary): string {
  if (a.state === "draft") return "border border-dashed border-fg-faint";
  if (a.state === "scheduled") return "bg-info";
  if (bucketOf(a.state) === "ended") return "bg-line-strong";
  return barClass(a).split(" ")[0]!;
}

interface Room {
  key: string;
  label: string;
  lanes: { row: ActivitySummary; span: Span }[];
}

export function ActivityTimeline({
  rows,
  navigate,
  now,
}: {
  rows: ActivitySummary[];
  navigate: (r: Route) => void;
  now: number;
}) {
  const t = useT();
  const { locale } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);

  // One row per classroom (the anonymous polls together), in the order the
  // rows arrive, lanes by start.
  const rooms: Room[] = [];
  let undated = 0;
  for (const row of rows) {
    const span = spanOf(row, now);
    if (span === null) {
      undated += 1;
      continue;
    }
    const key = row.classroom?.id ?? "none";
    let room = rooms.find((r) => r.key === key);
    if (!room) rooms.push((room = { key, label: classroomLabel(row, t), lanes: [] }));
    room.lanes.push({ row, span });
  }
  for (const room of rooms) room.lanes.sort((a, b) => a.span.s - b.span.s);
  const spans = rooms.flatMap((r) => r.lanes.map((l) => l.span));

  const [view, setView] = useState<View>(() => computeDefault(spans, now));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState(false);

  // Wheel: pan by default, ctrl/⌘ to zoom under the cursor. Registered
  // natively so it can preventDefault (React's onWheel is passive).
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      if (e.ctrlKey || e.metaKey) {
        const frac = (e.clientX - rect.left) / rect.width;
        setView((v) => {
          const span = v.to - v.from;
          const next = clamp(span * Math.exp(e.deltaY * 0.002), MIN_SPAN, MAX_SPAN);
          const anchor = v.from + frac * span;
          const from = anchor - frac * next;
          return { from, to: from + next };
        });
      } else {
        const primary = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView((v) => {
          const shift = (primary * (v.to - v.from)) / rect.width;
          return { from: v.from + shift, to: v.to + shift };
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [rooms.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps -- attach once the track exists

  if (rooms.length === 0) {
    return (
      <Card>
        <EmptyState icon={CalendarRange} title={t("activities.timeline.empty.title")}>
          {t("activities.timeline.empty.body")}
        </EmptyState>
      </Card>
    );
  }

  const span = view.to - view.from;
  const pct = (x: number) => ((x - view.from) / span) * 100;
  const ticks = buildTicks(view.from, view.to, locale);
  const nowVisible = now >= view.from && now <= view.to;

  const zoomBy = (factor: number) =>
    setView((v) => {
      const s = v.to - v.from;
      const c = (v.from + v.to) / 2;
      const next = clamp(s * factor, MIN_SPAN, MAX_SPAN);
      return { from: c - next / 2, to: c + next / 2 };
    });

  // Drag to pan, unless the gesture starts on a bar (a click opens it).
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = trackRef.current!.getBoundingClientRect();
    if (rect.width === 0) return;
    const start = { x: e.clientX, from: view.from, to: view.to, w: rect.width };
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const shift = (-(ev.clientX - start.x) * (start.to - start.from)) / start.w;
      setView({ from: start.from + shift, to: start.to + shift });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleRoom = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** What a bar says to a screen reader and on hover: the title, the state, the span. */
  const barName = (row: ActivitySummary, s: Span) =>
    t("activities.timeline.bar", {
      title: row.title,
      state: evaluationStateLabel(row.state, t),
      from: isoDateTime(new Date(s.s).toISOString()),
      to: isoDateTime(new Date(s.d).toISOString()),
    });

  const bar = (row: ActivitySummary, s: Span, compact: boolean) => {
    const l = pct(s.s);
    const r = pct(s.d);
    if (r <= 0 || l >= 100) return null; // fully outside the window
    // A bar too short to see is drawn at the minimum width, grown from the
    // end that means something: an open one ENDS on the now line (it runs up
    // to now), anything else STARTS at its opening.
    const natural = Math.min(r, 100) - Math.max(l, 0);
    const width = Math.max(natural, MIN_BAR);
    const left =
      natural >= MIN_BAR ? Math.max(l, 0) : bucketOf(row.state) === "open" ? Math.max(r - width, 0) : Math.max(l, 0);
    const ongoing = s.s <= now && now <= s.d && bucketOf(row.state) === "open";
    const name = barName(row, s);
    return (
      <button
        key={row.id}
        type="button"
        onClick={() => navigate(evaluationHome(row))}
        // Out of the Tab order: the lane's label before it is the keyboard's
        // way in, and is there whatever the visible window.
        tabIndex={-1}
        title={name}
        aria-label={name}
        className={cx(
          "absolute h-6 truncate rounded-full px-2.5 text-left text-xs font-medium leading-6",
          compact ? "top-1" : "top-1.5",
          dragging ? "" : "transition-[filter] hover:brightness-95",
          ongoing && "ring-2 ring-success/30",
          barClass(row),
        )}
        style={{ left: `${left}%`, width: `${width}%` }}
      >
        {/* Under ~6 % the name is two clipped letters: the label column carries it. */}
        {width > 6 ? row.title : null}
      </button>
    );
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-1">
        <p className="mr-auto text-[13px] text-fg-muted">{t("activities.timeline.hint")}</p>
        <IconButton label={t("activities.timeline.zoomOut")} onClick={() => zoomBy(1.6)}>
          <ZoomOut />
        </IconButton>
        <IconButton label={t("activities.timeline.zoomIn")} onClick={() => zoomBy(1 / 1.6)}>
          <ZoomIn />
        </IconButton>
        <IconButton
          label={t("activities.timeline.focus")}
          onClick={() => setView(computeDefault(spans, now))}
        >
          <Crosshair />
        </IconButton>
      </div>

      <div className="overflow-x-auto">
        <div className="flex min-w-180 gap-2">
          {/* Label column */}
          <div className="w-56 shrink-0">
            <div className={AXIS_H} />
            {rooms.map((room) => {
              const folded = collapsed.has(room.key);
              return (
                <div key={room.key}>
                  <button
                    type="button"
                    onClick={() => toggleRoom(room.key)}
                    aria-expanded={!folded}
                    className={`flex ${ROOM_H} w-full items-center gap-1 truncate rounded-field pr-1 text-left text-sm font-semibold hover:text-fg-muted`}
                  >
                    {folded ? (
                      <ChevronRight className="size-3.5 shrink-0 text-fg-faint" />
                    ) : (
                      <ChevronDown className="size-3.5 shrink-0 text-fg-faint" />
                    )}
                    <span className="truncate" title={room.label}>
                      {room.label}
                    </span>
                    <span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-fg-faint">
                      {room.lanes.length}
                    </span>
                  </button>
                  {folded
                    ? null
                    : room.lanes.map(({ row }) => {
                        const Icon = MODE_ICON[row.mode];
                        return (
                          // A button, so every lane is reachable from the
                          // keyboard, its bar in the window or not.
                          <button
                            key={row.id}
                            type="button"
                            onClick={() => navigate(evaluationHome(row))}
                            className={`flex ${LANE_H} w-full items-center gap-1.5 truncate rounded-field pl-5 pr-1 text-left text-xs text-fg-muted hover:text-fg`}
                            title={row.title}
                          >
                            <span className={cx("inline-block size-2 shrink-0 rounded-full", dotClass(row))} />
                            <Icon aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
                            <span className="truncate">{row.title}</span>
                          </button>
                        );
                      })}
                </div>
              );
            })}
          </div>

          {/* Track column */}
          <div
            ref={trackRef}
            onPointerDown={onPointerDown}
            className={cx(
              "relative min-w-0 flex-1 touch-none select-none",
              dragging ? "cursor-grabbing" : "cursor-grab",
            )}
          >
            <div className={`relative ${AXIS_H} text-[10px] font-medium uppercase tracking-wider text-fg-faint`}>
              {ticks.map((tick) =>
                tick.label ? (
                  <span
                    key={tick.t}
                    className={cx(
                      "absolute top-1 -translate-x-1/2 whitespace-nowrap",
                      tick.major && "font-bold text-fg-muted",
                    )}
                    style={{ left: `${pct(tick.t)}%` }}
                  >
                    {tick.text}
                  </span>
                ) : null,
              )}
            </div>

            {/* Gridlines and the now marker, behind the lanes. Ink, not a
                colour: among coloured bars a coloured hairline reads as one
                more bar (DESIGN.md › Color, `fg`). */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 top-6">
              {ticks.map((tick) => (
                <span
                  key={tick.t}
                  className={cx("absolute inset-y-0 w-px", tick.major ? "bg-line-strong" : "bg-line")}
                  style={{ left: `${pct(tick.t)}%` }}
                />
              ))}
              {nowVisible ? (
                <div data-testid="timeline-now" className="absolute inset-y-0 w-px bg-fg" style={{ left: `${pct(now)}%` }} />
              ) : null}
            </div>

            {rooms.map((room) =>
              collapsed.has(room.key) ? (
                // Folded: the overview on a single track.
                <div key={room.key} className={`relative ${ROOM_H}`}>
                  {room.lanes.map(({ row, span: s }) => bar(row, s, true))}
                </div>
              ) : (
                <div key={room.key}>
                  <div className={ROOM_H} />
                  {room.lanes.map(({ row, span: s }) => (
                    <div key={row.id} className={`relative ${LANE_H}`}>
                      {bar(row, s, false)}
                    </div>
                  ))}
                </div>
              ),
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-fg-muted">
        {(
          [
            ["bg-success", "activities.timeline.legend.live"],
            ["bg-warning", "activities.timeline.legend.waiting"],
            ["bg-info-soft ring-1 ring-inset ring-info", "activities.timeline.legend.scheduled"],
            ["border border-dashed border-fg-faint", "activities.timeline.legend.draft"],
            ["bg-surface-3", "activities.timeline.legend.ended"],
          ] as const
        ).map(([cls, key]) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span className={cx("inline-block h-2.5 w-4 rounded-full", cls)} /> {t(key)}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-px bg-fg" /> {t("activities.timeline.legend.now")}
        </span>
        {undated > 0 ? (
          <span className="ml-auto">
            {t(undated === 1 ? "activities.timeline.undated.one" : "activities.timeline.undated", { n: undated })}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
