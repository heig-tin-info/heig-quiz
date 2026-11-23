import {
  Check,
  CircleAlert,
  CircleCheck,
  Clock,
  Flag,
  Hourglass,
  Loader2,
  Lock,
  Minus,
  Pause,
  Square,
  WifiOff,
  X,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { prefersReducedMotion } from "@quiz/ui";

import type { AnswerMark } from "@quiz/domain";

import { useT, type TFunction } from "../i18n";
import { pad2 } from "./dates";
import { cx, useNow, type IconType } from "./layers";
import { rovingIndex } from "./menu";
import { useScrollFade } from "./page";

// --- Live primitives (PLAN-MVP §6.4) ---
//
// The five shapes the live path needs: the countdown of the player, the ring
// of the lobby, the progress segments of the zen bar, the verdict cell of the
// dashboard grid and the save state that sits next to the countdown. They
// share three rules. Time is tabular, always, or the last digit dances.
// Nothing is carried by colour alone (N-A11Y): every state also has an icon
// or a shape of its own, and a word, visible or in the accessible name. And none of them owns a
// clock: the caller passes `now` — or, to `ClockCountdown`, the clock to
// tick on — because on the live path that time is the SERVER's
// (`useServerClock`), never the browser's.

/**
 * The time left on a countdown, in three ranges:
 *  - under an hour, "12:47": tabular digits are applied by the component, the
 *    zero-padding is here so a second never shifts the layout;
 *  - from one hour to under 48, "47 h 03 min 17 s";
 *  - from 48 hours on, "6 d 20 h" ("6 j 20 h"): an exercise open for a week
 *    is read in days, and the seconds of it mean nothing.
 * The units go through `t` (the `dur.*` keys, like `formatSpan` in `i18n`), with
 * non-breaking spaces so the label never breaks across two lines.
 * Past the deadline it is "0:00", never a negative: the server closes the
 * attempt, and a client counting into the red would be inventing a rule.
 */
export function formatRemaining(ms: number, t: TFunction): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours < 1) return `${minutes}:${pad2(seconds)}`;
  const text =
    hours < 48
      ? t("dur.hourMinSec", { h: hours, m: pad2(minutes), s: pad2(seconds) })
      : t("dur.dayHour", { d: Math.floor(hours / 24), h: hours % 24 });
  return text.replace(/ /g, "\u00a0");
}

/** Under a minute everything is urgent, whatever the evaluation's own threshold. */
const COUNTDOWN_DANGER_S = 60;

type CountdownPhase = "normal" | "warning" | "danger" | "over";

/** Which of the four phases `remaining` ms falls in, given the warn threshold. */
export function countdownPhase(remainingMs: number, warnUnderS: number): CountdownPhase {
  if (remainingMs <= 0) return "over";
  const s = remainingMs / 1000;
  if (s <= COUNTDOWN_DANGER_S) return "danger";
  if (s <= warnUnderS) return "warning";
  return "normal";
}

const COUNTDOWN_TONE: Record<CountdownPhase, string> = {
  normal: "text-fg",
  warning: "text-warning",
  danger: "text-danger",
  over: "text-danger",
};

/**
 * Time left on a deadline the SERVER owns. `now` is passed in (from
 * `useServerClock`) rather than read here: two countdowns on one screen must
 * agree, and a component that calls `Date.now()` on its own would drift from
 * the attempt it belongs to.
 *
 * It turns `warning` under `warnUnderS` and `danger` under a minute, and it
 * says so out loud: the colour change is invisible to a screen reader and to
 * a third of the men in a lecture hall, so the phase is announced once, when
 * it is crossed, through a polite live region. Once, not every tick — a timer
 * that speaks every second is a timer nobody can work next to.
 *
 * `paused` freezes it. A paused evaluation is not consuming its window, so a
 * display that keeps falling is telling a room full of students something
 * false (W16); it holds the time it was paused at and says "paused" beside
 * it, because a frozen number and a slow one look the same for a second.
 */
export function Countdown({
  deadlineAt,
  now,
  warnUnderS = 300,
  paused = false,
  icon = true,
  className = "",
}: {
  /** Epoch ms, the server's. */
  deadlineAt: number;
  /** Epoch ms on the server's clock, ticked by the caller. */
  now: number;
  /** Seconds under which the countdown turns `warning`. */
  warnUnderS?: number;
  /** The evaluation is paused: freeze the digits and say so. */
  paused?: boolean;
  icon?: boolean;
  className?: string;
}) {
  const t = useT();
  // The last tick seen while running. Written during render on purpose: it is
  // a cache of a prop, not state — `paused` flipping must freeze the number
  // that is on screen in that very commit, not one tick later.
  const lastRunning = useRef(now);
  if (!paused) lastRunning.current = now;
  const remaining = deadlineAt - (paused ? lastRunning.current : now);
  const label = formatRemaining(remaining, t);
  const phase = paused ? "normal" : countdownPhase(remaining, warnUnderS);
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    if (phase === "normal") {
      setAnnounced("");
      return;
    }
    setAnnounced(
      phase === "over" ? t("countdown.over") : t("countdown.announce", { time: label }),
    );
    // `label` on purpose out of the deps: the announcement is made when the
    // phase is CROSSED, with the time it was crossed at, and not again at the
    // next tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, t]);
  return (
    <>
      <span
        role="timer"
        aria-label={
          paused
            ? t("countdown.remainingPaused", { time: label })
            : phase === "over"
              ? t("countdown.over")
              : t("countdown.remaining", { time: label })
        }
        className={cx(
          "inline-flex items-center gap-1.5 text-[15px] font-medium tabular-nums",
          paused ? "text-fg-muted" : COUNTDOWN_TONE[phase],
          className,
        )}
      >
        {icon ? (paused ? <Pause className="size-4" aria-hidden /> : <Clock className="size-4" aria-hidden />) : null}
        <span>{label}</span>
        {/* The word rides with the icon: both belong to the full
            presentation. A dense countdown (`icon={false}`, one per row of
            the live grid) would otherwise print "paused" twenty-four times
            under a badge that already says it once. The accessible name
            carries it in every variant. */}
        {paused && icon ? (
          <span aria-hidden className="text-[13px] font-normal">
            {t("countdown.paused")}
          </span>
        ) : null}
      </span>
      <span className="sr-only" aria-live="polite">
        {announced}
      </span>
    </>
  );
}

/**
 * A `Countdown` that ticks by itself, once a second, on the clock it is
 * given — the SERVER's on the live path (`useServerClock().now`), so every
 * countdown of a screen reads one time and the deadline stays the server's
 * (invariant 5).
 *
 * The tick lives here, in the leaf, and nowhere above it: the player and the
 * live dashboard hand down a stable `clock` function rather than a `now` that
 * changes every second, so a tick re-renders the digits and not the question
 * editor or the thirty-by-twelve grid around them. All of them share the one
 * timer of `useNow`, so two countdowns on a screen never disagree.
 */
export const ClockCountdown = memo(function ClockCountdown({
  clock,
  ...countdown
}: Omit<ComponentProps<typeof Countdown>, "now"> & {
  /** The time to count against; must be stable, it is re-read every tick. */
  clock: () => number;
}) {
  const now = useNow(1_000, clock);
  return <Countdown {...countdown} now={now} />;
});

/**
 * Progress ring: the lobby's "present / enrolled" and the dashboard's
 * completion. `fg` and not the accent — on the waiting screen it is the only
 * living element, and a red disc would read as an alarm on a page whose whole
 * message is "there is nothing to do".
 *
 * The label is the accessible name of the whole figure; `children` is what is
 * drawn in the middle (a big number and a caption) and is hidden from the
 * reader, which would otherwise hear "18 present of 24 18 24".
 */
export function Ring({
  value,
  max,
  size = 208,
  thickness = 10,
  label,
  children,
  className = "",
}: {
  value: number;
  max: number;
  size?: number;
  thickness?: number;
  /** Accessible name; the ring is a figure, so it needs one. */
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(1, Math.max(0, value / safeMax));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div
      className={cx("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          className="stroke-surface-3"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          className="stroke-fg transition-[stroke-dasharray] duration-200 ease-out-emphasized"
        />
      </svg>
      {children ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the student has done with a question (issue #89): holding an answer,
 * left blank on purpose ("I won't answer"), or nothing yet. Where the student
 * IS, whether the question is flagged for review and whether it is closed are
 * separate facts of the {@link Segment}, not further marks: a question can be
 * answered AND flagged AND the current one.
 */
export type SegmentMark = AnswerMark;

/**
 * Each mark is a SHAPE before it is a tint, so the three read apart in grey,
 * to a colour-blind student and on a washed-out projector: a hollow circle
 * (nothing yet), a solid one carrying a check (answered), a dashed one on a
 * recessed fill carrying a dash (won't answer). The hollow one draws in
 * `fg-faint` and not `line-strong`: its outline is a graphic object and needs
 * 3:1 against the canvas, which `line-strong` does not reach in dark mode.
 */
const SEGMENT_DOT: Record<SegmentMark, string> = {
  unanswered: "border-fg-faint bg-surface",
  answered: "border-fg bg-fg text-surface",
  skipped: "border-dashed border-fg-muted bg-surface-3 text-fg-muted",
};

const SEGMENT_GLYPH: Record<SegmentMark, IconType | null> = {
  unanswered: null,
  answered: Check,
  skipped: Minus,
};

const SEGMENT_LABEL: Record<
  SegmentMark,
  "segments.unanswered" | "segments.answered" | "segments.skipped"
> = {
  unanswered: "segments.unanswered",
  answered: "segments.answered",
  skipped: "segments.skipped",
};

export interface Segment {
  /** Stable key, and what the caller gets back from `onSelect`. */
  id: string;
  mark: SegmentMark;
  /** Where the student is: the accent ring and the bold accent number. */
  current?: boolean;
  /** Flagged for review by the student (issue #89): a flag over the number. */
  flagged?: boolean;
  /** The flag's words when it means something else ("flagged for review" otherwise). */
  flagLabel?: string | undefined;
  /** Closed by the navigation (validated in `forward_only`, behind a checkpoint). */
  locked?: boolean;
  /**
   * Not a question: the text before the question that follows it (ADR-084).
   * A smaller dot with no number and no mark of its own, named by `title`
   * (the text's first heading; "Text" when it has none). Its `mark` is
   * ignored; the connector reads it as the question after it, so the path
   * runs through it.
   */
  passage?: { title: string | null };
  /**
   * Inside a section (ADR-143): the standing list sets the entry slightly
   * in, under the section's text; the strip draws nothing more.
   */
  indent?: boolean;
}

/**
 * Each entry's question number: a question's own, counted over the questions
 * only, and for a passage the number of the question it precedes. A passage
 * never takes a number.
 */
function questionNumbers(segments: readonly Segment[]): number[] {
  let n = 0;
  return segments.map((segment) => (segment.passage ? n + 1 : ++n));
}

/**
 * The connector of the standing list from entry `segment` down to `next`,
 * drawn from the row of `segment`: straight down when both stand at the same
 * indent; into a section (ADR-143), down from the text's dot and in to the
 * first question's; out of one, from the last question's dot out and down
 * to the next text's. A row's dot is centred 18 px from its left edge (8 px
 * of padding, then half the 20 px circle), and an indented row stands
 * {@link LIST_INDENT} px further in.
 */
function listLink(segment: Segment, next: Segment, thick: boolean): { className: string; style: CSSProperties } {
  const tone = thick ? "border-fg" : "border-line-strong";
  const stroke = thick ? 2 : 1;
  const axis = 18 - stroke / 2;
  const from = dotRadius(segment, true);
  const to = dotRadius(next, true);
  if ((segment.indent ?? false) === (next.indent ?? false)) {
    // Centred under the circle, less half the stroke.
    return {
      className: thick ? "left-[17px] w-0.5 bg-fg" : "left-[17.5px] w-px bg-line-strong",
      style: linkSpan(segment, next, true, "y"),
    };
  }
  if (next.indent) {
    // Down from this dot's bottom to the next row's middle, then in to its circle's edge.
    return {
      className: cx("rounded-bl-[6px] border-b border-l", tone),
      style: {
        left: axis,
        top: `calc(50% + ${from}px)`,
        height: `calc(100% - ${from}px + ${stroke / 2}px)`,
        width: LIST_INDENT + 18 - to - axis,
        borderLeftWidth: stroke,
        borderBottomWidth: stroke,
      },
    };
  }
  // Out from this circle's edge to the next row's axis, then down to its dot's top.
  const outer = axis - LIST_INDENT;
  return {
    className: cx("rounded-tl-[6px] border-l border-t", tone),
    style: {
      left: outer,
      top: `calc(50% - ${stroke / 2}px)`,
      height: `calc(100% - ${to}px + ${stroke / 2}px)`,
      width: 18 - from - outer,
      borderLeftWidth: stroke,
      borderTopWidth: stroke,
    },
  };
}

/** How far the standing list sets an entry of a section in (ADR-143), in px. */
const LIST_INDENT = 16;

function ListLink({ segment, next, thick }: { segment: Segment; next: Segment; thick: boolean }) {
  const { className, style } = listLink(segment, next, thick);
  return <span className={cx("absolute", className)} style={style} data-part="link" aria-hidden />;
}

/** Half the width of an entry's dot, for the connectors that start and end at its edge. */
const dotRadius = (segment: Segment, roomy: boolean): number =>
  segment.passage ? (roomy ? 5 : 3) : roomy ? 10 : 5;

/**
 * Under this width a question gets a plain 10 px dot instead of the 20 px
 * circle with its glyph: the circle needs a stretch of connector on each side
 * to read as a step of a path rather than a row of beads.
 */
const ROOMY_SEGMENT = 28;

/**
 * Under this width a dot and its two stretches of connector no longer fit:
 * the strip stops compressing and scrolls instead (issue #223), each question
 * back in a full {@link ROOMY_SEGMENT} slot.
 */
const MIN_SEGMENT = 14;

/**
 * How often a number is shown, from the strip's measured width. `1` is "every
 * one of them"; `5` is the compressed mode. (Under {@link MIN_SEGMENT} the
 * strip scrolls instead, and shows them all.) A width of 0 is "not
 * measured yet" (first paint, or a test with no layout) and shows everything:
 * the strip must never come up thinned out on a screen that had the room.
 */
function segmentLabelStep(width: number, count: number): 1 | 5 {
  if (width <= 0 || count <= 1) return 1;
  return width / count >= 22 ? 1 : 5;
}

/** What a passage is called in the list: its title, or "Text". */
const passageTitle = (t: TFunction, passage: { title: string | null }): string =>
  passage.title ?? t("segments.text");

/**
 * The accessible name of an entry of the paper: a question's number and every
 * fact of it, in words; a passage's title and its facts, as a question's.
 * `n` is the entry's {@link questionNumbers} value.
 */
function segmentName(t: TFunction, segment: Segment, n: number): string {
  const current = segment.current ? [t("segments.current")] : [];
  if (segment.passage) {
    // "Closed" agrees with the text (masculine in French), not the question.
    return [
      passageTitle(t, segment.passage),
      ...(segment.locked ? [t("segments.passageLocked")] : []),
      ...current,
    ].join(", ");
  }
  const facts = [
    t(SEGMENT_LABEL[segment.mark]),
    ...(segment.flagged ? [segment.flagLabel ?? t("segments.flagged")] : []),
    ...(segment.locked ? [t("segments.locked")] : []),
    ...current,
  ];
  return t("segments.item", { n, state: facts.join(", ") });
}

/**
 * A connector from an entry's dot to the next one's, edge to edge: its start
 * and length along the axis (`left`/`width` in the strip, `top`/`height` in
 * the list), from the two dots' sizes.
 */
function linkSpan(segment: Segment, next: Segment, roomy: boolean, axis: "x" | "y"): CSSProperties {
  const from = dotRadius(segment, roomy);
  const to = dotRadius(next, roomy);
  const start = `calc(50% + ${from}px)`;
  const length = `calc(100% - ${from + to}px)`;
  return axis === "x" ? { left: start, width: length } : { top: start, height: length };
}

/**
 * One question's circle, the same in the strip and in the list: its mark as
 * a shape, the accent ring where the student is, faded when closed. Not
 * `roomy`, it drops to a plain dot with no glyph.
 *
 * A passage (ADR-084) is a dot half the size, hollow, in the box of a
 * question's circle so the row stays on one line: no mark, since reading a
 * text is not recorded; the accent and its halo where the student is.
 */
function SegmentDot({ segment, roomy }: { segment: Segment; roomy: boolean }) {
  if (segment.passage) {
    return (
      <span className={cx("flex shrink-0 items-center justify-center", roomy ? "size-5" : "size-2.5")}>
        <span
          className={cx(
            "rounded-full border-fg-faint bg-surface transition-colors duration-150",
            roomy ? "size-2.5 border-2" : "size-1.5 border",
            segment.locked && !segment.current && "opacity-45",
            segment.current && "border-accent! bg-accent! ring-3 ring-accent-soft",
          )}
        />
      </span>
    );
  }
  const Glyph = roomy ? SEGMENT_GLYPH[segment.mark] : null;
  return (
    <span
      className={cx(
        "flex shrink-0 items-center justify-center rounded-full transition-colors duration-150",
        roomy ? "size-5 border-2" : "size-2.5 border-[1.5px]",
        SEGMENT_DOT[segment.mark],
        segment.locked && !segment.current && "opacity-45",
        segment.current && "border-accent! ring-accent-soft",
        segment.current && (roomy ? "ring-4" : "ring-3 bg-accent!"),
      )}
    >
      {Glyph ? <Glyph className="size-2.5 stroke-3" aria-hidden /> : null}
      {roomy && segment.current && segment.mark === "unanswered" ? (
        <span className="size-2 rounded-full bg-accent" aria-hidden />
      ) : null}
    </span>
  );
}

/**
 * Roving focus over the buttons of a question list, from a keydown on it. A
 * standing list is a grid of one column (`columns`): ↑/↓ move a row, and
 * ←/→ still step through it like the strip.
 */
function rove(e: React.KeyboardEvent, list: HTMLElement | null, current: number, columns?: number) {
  const buttons = Array.from(list?.querySelectorAll("button") ?? []);
  const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = rovingIndex(e.key, from === -1 ? current : from, buttons.length, columns);
  if (next === null) return;
  e.preventDefault();
  buttons[next]?.focus();
}

/**
 * Whether the entry at `i` is a question already dealt with (answered or
 * declined). A passage has no mark of its own: it reads as the question it
 * comes before, so the path runs through it.
 */
function dealtWith(segments: readonly Segment[], i: number): boolean {
  let at = i;
  while (segments[at]?.passage) at += 1;
  const segment = segments[at];
  return segment !== undefined && segment.mark !== "unanswered";
}

/** The stretch from entry `i` to the next one is drawn solid when both are dealt with. */
function covered(segments: readonly Segment[], i: number): boolean {
  return i + 1 < segments.length && dealtWith(segments, i) && dealtWith(segments, i + 1);
}

/**
 * A stepper in the zen player, one circle per question (issues #89 and
 * #219): what the
 * student did with it (a {@link SegmentMark}), whether they flagged it for
 * review, whether it is closed, and where they are. "Opened and left" is not
 * a state of its own: for the reader it is the same decision as "never
 * opened" — there is something left to do there.
 *
 * Roving tabindex like `Tabs`: twenty questions must not be twenty stops on
 * the way to the answer field. Arrows move with wrap, Home and End jump, and
 * the accessible name of each circle carries its state in words — the shape
 * and the tone are the same information for everyone else.
 *
 * The circles are joined by a hairline, and the stretch between two
 * questions already dealt with (answered or declined) is drawn solid: the
 * path covered, and the holes left in it, read at a glance.
 *
 * It spans the WHOLE width it is given and the questions share it equally
 * (`flex-1 basis-0`, no cap): three questions spread over the question
 * column, not a stub at its left edge — the strip is a map of the paper, and
 * a map that covers a tenth of the page maps nothing.
 *
 * Every question carries its number, so the student can aim at "question 7"
 * without counting. When there are enough questions for the numbers to stop
 * fitting, the strip first COMPRESSES rather than wraps: the circles shrink
 * to dots, the numbers thin out to anchors. The rule, from the measured
 * width of the strip (`segmentLabelStep`):
 *
 *   - a segment at least 22 px wide holds two digits and its breathing room:
 *     every number is shown (up to ~30 questions over the player's 760 px);
 *   - at least 14 px: the first, the last, the current and every 5th;
 *   - under that (40 questions on a phone), the strip SCROLLS: every question
 *     is back in a full 28 px slot with its number, the student swipes it,
 *     and it brings the current question to the middle whenever it changes.
 *
 * A multiple that lands within two slots of the last one is dropped, so "30"
 * and "32" never collide. Nothing is lost for a screen reader: the number and
 * the state live in each bar's accessible name, which never thins out.
 *
 * A passage (ADR-084, {@link Segment.passage}) takes a slot before its
 * question, with a smaller dot and no number: the questions keep theirs.
 */
export function ProgressSegments({
  segments,
  onSelect,
  label,
  className = "",
}: {
  segments: Segment[];
  /** Absent = the strip is a read-only indicator (navigation is locked). */
  onSelect?: (id: string, index: number) => void;
  /** Accessible name of the strip, e.g. "Progress: question 4 of 8". */
  label: string;
  className?: string;
}) {
  const t = useT();
  const strip = useRef<HTMLElement>(null);
  const current = Math.max(0, segments.findIndex((s) => s.current === true));
  // The strip's own width, not the viewport's: it sits in a 760 px column on
  // a laptop and in a 358 px one on a phone, and only its own width says how
  // much room a number has.
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const numbers = questionNumbers(segments);
  const count = segments.filter((s) => s.passage === undefined).length;
  const per = width / segments.length;
  const scrolls = width > 0 && per < MIN_SEGMENT;
  const step = scrolls ? 1 : segmentLabelStep(width, segments.length);
  // The glyph inside a circle (the check, the dash) needs room around it;
  // compressed, the circles drop to dots and the SHAPE — solid, hollow,
  // dashed — is what is left to tell the marks apart.
  const roomy = width === 0 || scrolls || per >= ROOMY_SEGMENT;
  // Scrolling, the current question is kept in the middle of the strip, and
  // back there after a rotation. The strip scrolls itself, never the page
  // (which `scrollIntoView` would). The first centring is a jump: a strip
  // sliding from question 1 on every load would be noise.
  const centred = useRef(false);
  useEffect(() => {
    const el = strip.current;
    const button = el?.querySelectorAll("button")[current];
    if (!scrolls || !el || !button) return;
    el.scrollTo?.({
      left: button.offsetLeft - (el.clientWidth - button.offsetWidth) / 2,
      behavior: prefersReducedMotion() || !centred.current ? "auto" : "smooth",
    });
    centred.current = true;
  }, [scrolls, current, width]);
  const fade = useScrollFade(strip, scrolls ? `${segments.length}` : "");

  return (
    <nav
      ref={strip}
      aria-label={label}
      onKeyDown={(e) => rove(e, strip.current, current)}
      style={fade}
      className={cx(
        "relative flex w-full items-start",
        // The padding keeps the global focus ring (2 px + 2 px offset) inside
        // the scroller, which clips both axes; it counts in `clientWidth`,
        // so the measured width, and the mode, stay the same. The negative
        // margin gives the row its height back. `overflow-y-hidden`: no
        // vertical scrollbar on hosts that draw them.
        scrolls && "-my-1 overflow-x-auto overflow-y-hidden overscroll-x-contain p-1 [scrollbar-width:thin]",
        className,
      )}
    >
      {segments.map((segment, i) => {
        const n = numbers[i]!;
        const name = segmentName(t, segment, n);
        // A passage takes a slot of the strip but never a number.
        const numbered =
          segment.passage === undefined &&
          (step === 1 ||
            n === 1 ||
            n === count ||
            segment.current === true ||
            (n % step === 0 && count - n >= 2));
        const next = segments[i + 1];
        return (
          <button
            key={segment.id}
            type="button"
            disabled={!onSelect}
            tabIndex={i === current ? 0 : -1}
            aria-label={name}
            title={name}
            aria-current={segment.current ? "true" : undefined}
            onClick={() => onSelect?.(segment.id, i)}
            className={cx(
              "relative flex flex-col items-center rounded-full px-0 py-1.5 disabled:cursor-default",
              scrolls ? "w-7 flex-none" : "min-w-0 flex-1 basis-0",
            )}
          >
            <SegmentDot segment={segment} roomy={roomy} />
            {/* From this circle's edge to the next one's — never under a
                circle, which a faded (closed) one would let show through.
                The hairline may miss 3:1 in dark mode: it repeats what the
                circles say and carries nothing of its own. */}
            {next ? (
              <span
                className={cx(
                  "absolute -translate-y-1/2",
                  roomy ? "top-4" : "top-2.75",
                  covered(segments, i) ? "h-0.5 bg-fg" : "h-px bg-line-strong",
                )}
                style={linkSpan(segment, next, roomy, "x")}
                data-part="link"
                aria-hidden
              />
            ) : null}
            {/* The row keeps its height whether or not it holds a number, so
                the circles stay on one line. The number overflows its own slot
                when compressed — its neighbours are empty, so there is room.
                The flag is never thinned out: it is the one mark the student
                set to find the question again. */}
            <span
              className={cx(
                "mt-1 flex h-2.75 items-center justify-center gap-0.5 overflow-visible whitespace-nowrap text-[11px] leading-none tabular-nums",
                segment.current ? "font-semibold text-accent" : "font-medium text-fg-faint",
              )}
              aria-hidden
            >
              {numbered ? n : null}
              {segment.flagged ? (
                <Flag className="size-2.5 shrink-0 fill-current text-warning" aria-hidden />
              ) : null}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * The same question list as {@link ProgressSegments}, standing: one row per
 * question down the side column of the zen player on a wide screen, where
 * the room is beside the question rather than above it. The circles, their
 * four facts, the connector and the accessible names are the strip's; what
 * the row adds is room for "Question 7" in words, so nothing thins out and
 * nothing compresses. A long paper scrolls inside the list — it is given a
 * bounded height by its column — and keeps the current question in view.
 *
 * Roving tabindex like the strip, ↑/↓ added. A passage (ADR-084) is a row of
 * its own above its question: the small dot and the text's title.
 */
export function ProgressList({
  segments,
  onSelect,
  label,
  className = "",
}: {
  segments: Segment[];
  onSelect: (id: string) => void;
  label: string;
  className?: string;
}) {
  const t = useT();
  const list = useRef<HTMLElement>(null);
  const current = Math.max(0, segments.findIndex((s) => s.current === true));
  // The list scrolls itself, never the page (which `scrollIntoView` would).
  useEffect(() => {
    const el = list.current;
    const button = el?.querySelectorAll("button")[current];
    if (!el || !button) return;
    if (button.offsetTop < el.scrollTop) el.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > el.scrollTop + el.clientHeight)
      el.scrollTop = button.offsetTop + button.offsetHeight - el.clientHeight;
  }, [current]);
  const fade = useScrollFade(list, `${segments.length}`);
  const numbers = questionNumbers(segments);
  return (
    <nav
      ref={list}
      aria-label={label}
      onKeyDown={(e) => rove(e, list.current, current, 1)}
      style={fade}
      // The padding keeps the focus ring and the current circle's halo
      // inside the scroller, which clips them.
      className={cx("relative flex flex-col overflow-y-auto overscroll-contain p-1", className)}
    >
      {segments.map((segment, i) => {
        const n = numbers[i]!;
        const name = segmentName(t, segment, n);
        const next = segments[i + 1];
        return (
          <button
            key={segment.id}
            type="button"
            tabIndex={i === current ? 0 : -1}
            aria-label={name}
            title={name}
            aria-current={segment.current ? "true" : undefined}
            onClick={() => onSelect(segment.id)}
            style={segment.indent ? { marginLeft: LIST_INDENT } : undefined}
            className={cx(
              "relative flex items-center gap-2.5 rounded-field px-2 py-1.5 text-left text-[13px] leading-5",
              !segment.current && "hover:bg-surface-2",
            )}
          >
            <SegmentDot segment={segment} roomy />
            {/* From this circle's bottom edge to the next one's top: the
                path down the paper, drawn like the strip's — with an elbow
                into and out of a section's indent. */}
            {next ? <ListLink segment={segment} next={next} thick={covered(segments, i)} /> : null}
            {/* A passage reads one step quieter than a question: its title,
                at the caption size, never a number. */}
            <span
              className={cx(
                "min-w-0 flex-1 truncate",
                segment.passage ? "text-[12px]" : "tabular-nums",
                segment.current ? "font-semibold text-accent" : "text-fg-muted",
                segment.locked && !segment.current && "opacity-45",
              )}
              aria-hidden
            >
              {segment.passage
                ? passageTitle(t, segment.passage)
                : t("player.question", { n })}
            </span>
            {segment.flagged ? (
              <Flag className="size-3.5 shrink-0 fill-current text-warning" aria-hidden />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

export type VerdictState =
  | "blank"
  | "inProgress"
  | "answered"
  | "skipped"
  | "done"
  | "correct"
  | "partial"
  | "wrong"
  | "pending";

type VerdictKey =
  | "verdict.blank"
  | "verdict.inProgress"
  | "verdict.answered"
  | "live.verdict.skipped"
  | "live.verdict.done"
  | "verdict.correct"
  | "verdict.partial"
  | "verdict.wrong"
  | "verdict.pending";

/**
 * The PROGRESS half of the scale (`inProgress`, `answered`, `done`) is blue
 * and the VERDICT half (`correct`, `partial`, `wrong`) keeps the semantic
 * green / amber / red, so a teacher scanning a grid never mistakes "they
 * wrote something" for "it is right".
 *
 * The progress states are SHAPES, not pictograms (#227). A pencil or an
 * ellipsis in a 64 px cell said nothing the tint did not, and thirty rows of
 * them were noise on a projector. So: a faint hollow square glyph for a
 * question never opened (`blank`), an empty outlined box for one opened and
 * left empty (`inProgress`), the box filled `info-mid` once it holds an
 * answer (`answered`), and filled `info` once validated (`done`). The
 * `answered` blue is a real blue, not a tint: `info-soft` vanished on a
 * projector, and in dark mode against the surface. Empty
 * versus filled is a difference of shape, which survives grey and a washed
 * out projector (N-A11Y, nothing by colour alone); `answered` versus `done`
 * would be two blues and nothing else, which is why `done` keeps its check.
 * The two strengths are the progression itself: a column darkening downward
 * is a class moving through the quiz, readable at squinting distance.
 *
 * `done` is the VALIDATED question of the locking navigations ("Validate and
 * continue", a crossed checkpoint). It and `skipped` — "I won't answer this
 * question" (issue #89) — are the states the grading list cannot show, which
 * is why their words live with the live dictionary and not with the shared
 * `verdict.*` ones. `skipped` is not blue: it is not progress through the
 * answer, it is a decision to leave it, so it wears the neutral recessed
 * fill with a DASHED edge and a dash — the student's own list draws it the
 * same way.
 *
 * The three verdicts are ONE ramp, red to green through amber, by the share
 * of the points the answer earned (`rate`, #1069): a 40 % answer and a 90 %
 * one were the same amber pie, and the pie said nothing about the share.
 * Without a `rate`, each verdict sits at its own end (`ramp`): the full
 * green, the middle, the full red. Never by hue alone: the tint deepens with
 * the share (`.score-ramp`), so the steps read in grey; full marks keep their
 * check, zero its cross, and a partial answer draws its share as a bar along
 * the bottom of the cell — a shape, which also tells it from the plain
 * `answered` box beside it. The share is said in the accessible name.
 *
 * `icon: null` is a cell whose shape says it all; `glyph` marks the one state
 * (`blank`) whose icon is a small mark rather than a full-size pictogram.
 */
const VERDICTS: Record<
  VerdictState,
  { icon: IconType | null; tint: string; key: VerdictKey; glyph?: boolean; ramp?: number; bar?: boolean }
> = {
  blank: { icon: Square, tint: "text-line-strong", key: "verdict.blank", glyph: true },
  inProgress: {
    icon: null,
    tint: "border border-line-strong text-fg-muted",
    key: "verdict.inProgress",
  },
  answered: { icon: null, tint: "bg-info-mid text-on-info-mid", key: "verdict.answered" },
  skipped: {
    icon: Minus,
    tint: "border border-dashed border-fg-faint bg-surface-2 text-fg-muted",
    key: "live.verdict.skipped",
  },
  done: { icon: CircleCheck, tint: "bg-info text-on-fill", key: "live.verdict.done" },
  correct: { icon: Check, tint: "score-ramp", key: "verdict.correct", ramp: 1 },
  partial: { icon: null, tint: "score-ramp", key: "verdict.partial", ramp: 0.5, bar: true },
  wrong: { icon: X, tint: "score-ramp", key: "verdict.wrong", ramp: 0 },
  pending: { icon: Hourglass, tint: "bg-surface-2 text-fg-faint", key: "verdict.pending" },
};

/**
 * Every state a cell can wear, in the order a cell goes through them: the
 * progress states, pale to filled, then the verdicts the "Results" switch
 * puts in their place — the order of {@link VERDICTS}.
 */
export const VERDICT_STATES = Object.keys(VERDICTS) as readonly VerdictState[];

/** The dictionary key of a state's word, the one its cell is named by. */
export const verdictKey = (state: VerdictState): VerdictKey => VERDICTS[state].key;

/**
 * One cell of the live grid and of the grading list. Shape, icon
 * and tint together, never the tint alone: a dashboard projected on a lecture
 * hall wall loses half its saturation, and one teacher in twelve cannot tell
 * the green from the amber at all. The word is in the accessible name, and
 * `value` — the student's answer in one glyph, "B", "NULL", "3/3" — sits next
 * to the icon (or alone in the shape) for everyone else.
 *
 * Its height is `--cell-h`, 28 px when nobody sets it: the live grid sets it
 * from the row height it computed to fit the class on one screen (#227), and
 * every other caller simply gets the default.
 */
export function VerdictCell({
  state,
  value,
  rate,
  onClick,
  label,
  describedBy,
  className = "",
}: {
  state: VerdictState;
  /** The answer in a glyph or two; `—` and the like belong in the caller. */
  value?: ReactNode;
  /**
   * A verdict's share of the points, 0 to 1: its place on the red-to-green
   * ramp, said as a percentage in the accessible name. Ignored by the
   * progress states; without it a verdict sits at its own end of the ramp.
   */
  rate?: number | undefined;
  onClick?: () => void;
  /** Overrides the accessible name (to add the student and the question). */
  label?: string;
  /** Id of a tooltip that describes the cell while it is shown (`aria-describedby`). */
  describedBy?: string;
  className?: string;
}) {
  const t = useT();
  const { icon: Icon, tint, key, glyph, ramp, bar } = VERDICTS[state];
  const share = ramp === undefined ? undefined : (rate ?? ramp);
  const name = `${label ?? t(key)}${ramp !== undefined && rate !== undefined ? ` · ${Math.round(rate * 100)} %` : ""}`;
  const style =
    share === undefined ? undefined : ({ "--rate": `${Math.round(share * 100)}%` } as CSSProperties);
  // The answer carries no colour of its own: it INHERITS the state's ink,
  // which is the only way it stays legible on every tint. `text-fg` on the
  // filled `done` blue measured 2.9:1, under half of what a teacher three
  // rows back needs; on the state's own ink every pair is 4.7:1 or better.
  const content = (
    <>
      {Icon ? <Icon className={cx("shrink-0", glyph ? "size-2.5" : "size-3.5")} aria-hidden /> : null}
      {value != null && value !== "" ? (
        <span className="max-w-11.5 truncate text-xs font-medium">{value}</span>
      ) : null}
      {bar && share !== undefined ? (
        // The share as a length, in the cell's own ink over a faint track.
        <span className="absolute inset-x-1.5 bottom-0.5 h-0.5 rounded-full bg-current/25" aria-hidden>
          <span
            data-part="share"
            className="block h-full rounded-full bg-current"
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        </span>
      ) : null}
    </>
  );
  // `relative`: the share bar and the `sr-only` name are positioned inside it.
  const chrome = cx(
    "relative inline-flex h-[var(--cell-h,1.75rem)] w-full items-center justify-center gap-1 rounded-[7px] px-1",
    tint,
    className,
  );
  if (!onClick) {
    return (
      <span className={chrome} style={style} title={name}>
        {content}
        <span className="sr-only">{name}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name}
      aria-describedby={describedBy}
      style={style}
      className={cx(chrome, "transition-opacity hover:opacity-80")}
    >
      {content}
    </button>
  );
}

/**
 * `unsaved`: the question on screen holds an edit it will not send, because
 * the server would refuse it (`PlayerProps.onUnsent`, issue #267). What was
 * sent before it is saved; what is on screen is not.
 */
export type SyncState = "saved" | "saving" | "unsaved" | "offline" | "closed";

type SyncKey = `sync.${SyncState}`;

const SYNC: Record<SyncState, { icon: IconType; tone: string; key: SyncKey; spin?: boolean }> = {
  saved: { icon: Check, tone: "text-fg-muted [&_svg]:text-success", key: "sync.saved" },
  saving: { icon: Loader2, tone: "text-fg-muted [&_svg]:text-fg-faint", key: "sync.saving", spin: true },
  unsaved: { icon: CircleAlert, tone: "text-warning", key: "sync.unsaved" },
  offline: { icon: WifiOff, tone: "text-warning", key: "sync.offline" },
  closed: { icon: Lock, tone: "text-fg-faint", key: "sync.closed" },
};

/**
 * Whether the student's work is safe, in the zen player's bar. Icon AND
 * word, and the word is what survives: "hors ligne" in amber next to a
 * countdown in red is two reds to anyone who cannot separate them. The word
 * hides under `sm` where the bar has no room, and the accessible name keeps
 * it. A polite live region, because this one genuinely must be heard when it
 * changes — it is the answer to "did that save?".
 */
export function SyncBadge({ state, className = "" }: { state: SyncState; className?: string }) {
  const t = useT();
  const { icon: Icon, tone, key, spin } = SYNC[state];
  const word = t(key);
  return (
    <span
      role="status"
      aria-live="polite"
      className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]", tone, className)}
    >
      <Icon className={cx("size-3.5 shrink-0", spin && "animate-spin")} aria-hidden />
      <span className="hidden sm:inline">{word}</span>
      <span className="sr-only sm:hidden">{word}</span>
    </span>
  );
}
