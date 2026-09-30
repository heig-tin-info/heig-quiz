import { Check } from "lucide-react";

import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { cx } from "../ui";
import type { PollRow } from "./pollTally";

/**
 * The distribution of an ended mcq poll as one large donut, beside its legend
 * (the Space key on the projection, or the chart button in its header).
 *
 * The bars say which choice won; the donut says how the room SPLIT, which is
 * what a teacher points at to open the discussion. It is offered only once
 * the vote is over: a room that watches a pie grow while it votes follows the
 * biggest slice, exactly as it would follow the longest bar.
 *
 * Colour (DESIGN.md, "Projection"): each choice takes its categorical slot
 * `--chart-N` in the order the choices are served, never by rank, so a choice
 * keeps its colour whatever the counts do. Past eight choices the rest share
 * the neutral `fg-faint`. Colour is never alone: a 2 px surface gap parts the
 * slices, each slice carries its letter, and the legend spells out every
 * share. That matters here more than on a bar chart, because a choice nobody
 * picked draws no slice, so any two slots can end up side by side.
 *
 * Revealed, the slices outside the key fade and the key's legend line gains
 * the tick and the word, as on the bars: nobody is marked wrong.
 */

const SIZE = 200;
const THICKNESS = 44;
const RADIUS = (SIZE - THICKNESS) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** The surface gap between two slices, along the ring (viewBox units). */
const GAP = 1.5;
/** How many categorical slots `style.css` defines. */
const SLOTS = 8;
/** Below this share a slice is too thin to carry its letter. */
const LETTER_FROM = 0.05;

function colorOf(position: number): string {
  return position < SLOTS ? `var(--chart-${position + 1})` : "var(--fg-faint)";
}

export function PollDonut({ rows, revealed }: { rows: PollRow[]; revealed: boolean }) {
  const t = useT();
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const drawn = rows
    .map((row, position) => ({ row, position }))
    .filter(({ row }) => row.count > 0);
  const gap = drawn.length > 1 ? GAP : 0;
  let start = 0;
  const slices = drawn.map(({ row, position }) => {
    const share = row.count / total;
    const length = share * CIRCUMFERENCE;
    const slice = { row, position, share, start, length };
    start += length;
    return slice;
  });

  return (
    <div className="flex items-center justify-center gap-[clamp(28px,5vw,96px)] max-lg:flex-col">
      <div className="relative size-[clamp(240px,42vh,520px)] shrink-0">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-full -rotate-90" aria-hidden>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={THICKNESS}
            className="stroke-surface-2"
          />
          {slices.map(({ row, position, start: from, length }) => {
            const visible = Math.max(length - gap, 0.75);
            return (
              <circle
                key={row.key}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth={THICKNESS}
                strokeDasharray={`${visible} ${CIRCUMFERENCE - visible}`}
                strokeDashoffset={-from}
                className="transition-opacity duration-200"
                style={{ stroke: colorOf(position), opacity: revealed && !row.correct ? 0.25 : 1 }}
              />
            );
          })}
        </svg>
        {/* The letters sit on their slices, upright: an HTML layer over the
            ring rather than SVG text, so the type is the projection's. */}
        {slices
          .filter(({ share, row }) => share >= LETTER_FROM && row.letter !== null)
          .map(({ row, start: from, length }) => {
            // Twelve o'clock, clockwise, as the ring is drawn.
            const angle = ((from + length / 2) / CIRCUMFERENCE) * 2 * Math.PI - Math.PI / 2;
            const x = 50 + (RADIUS / SIZE) * 100 * Math.cos(angle);
            const y = 50 + (RADIUS / SIZE) * 100 * Math.sin(angle);
            return (
              <span
                key={row.key}
                aria-hidden
                className={cx(
                  "absolute inline-flex size-[clamp(26px,2.6vw,40px)] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-surface text-[clamp(13px,1.3vw,19px)] font-semibold transition-opacity duration-200",
                  revealed && !row.correct ? "text-fg-faint" : "text-fg",
                )}
                style={{ left: `${x}%`, top: `${y}%` }}
              >
                {row.letter}
              </span>
            );
          })}
        <span className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
          <span className="font-mono text-[clamp(36px,4.6vw,72px)] font-bold leading-none tracking-[-0.02em] tabular-nums">
            {total}
          </span>
          <span className="mt-1 text-[clamp(13px,1.2vw,17px)] text-fg-muted">
            {t(total === 1 ? "poll.donut.total.one" : "poll.donut.total")}
          </span>
        </span>
      </div>

      {/* The legend is as wide as its longest label, up to half the wall:
          its labels are beamer-sized, so a cap in `ch` of the list's own
          (page-sized) font broke "Benevolent Dictator For Life" over three
          lines beside an empty half-screen. Never stretched either, or short
          labels would leave their percentages stranded at the far edge. */}
      <ul
        className="flex min-w-0 max-w-[clamp(320px,50vw,1000px)] list-none flex-col gap-[clamp(8px,1.4vh,18px)] p-0"
        aria-label={t("poll.donut")}
      >
        {rows.map((row, position) => {
          const right = revealed && row.correct;
          const faded = revealed && !row.correct;
          return (
            <li key={row.key} className="flex items-center gap-[clamp(10px,1.2vw,18px)]">
              <span
                aria-hidden
                className={cx(
                  "size-[clamp(14px,1.3vw,20px)] shrink-0 rounded-sm transition-opacity duration-200",
                  faded && "opacity-25",
                )}
                style={{ backgroundColor: colorOf(position) }}
              />
              {row.letter === null ? null : (
                <span
                  className={cx(
                    "w-[1.4em] shrink-0 text-[clamp(16px,1.7vw,24px)] font-semibold",
                    faded ? "text-fg-faint" : "text-fg-muted",
                  )}
                >
                  {row.letter}
                </span>
              )}
              <span
                className={cx(
                  "min-w-0 flex-1 text-[clamp(17px,1.9vw,30px)] font-medium tracking-[-0.02em]",
                  right && "text-success [&_code]:text-inherit",
                  faded && "text-fg-faint [&_code]:text-inherit",
                )}
              >
                <MarkdownView source={row.label} inline />
                {right ? (
                  <Check className="ml-2 inline size-[0.9em] align-[-0.1em]" aria-label={t("poll.correctAnswer")} />
                ) : null}
              </span>
              <span
                className={cx(
                  "min-w-[4ch] shrink-0 text-right font-mono text-[clamp(18px,2vw,32px)] font-bold tabular-nums",
                  right && "text-success",
                  faded && "text-fg-faint",
                )}
              >
                {t("poll.percent", { n: row.percent })}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
