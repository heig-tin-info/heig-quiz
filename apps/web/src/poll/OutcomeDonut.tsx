import type { PollOutcome } from "@quiz/contracts";

import { useT, type TFunction as T } from "../i18n";
import { Tip } from "../ui";

/**
 * How a question fared over its last runs, beside its row in the launcher's
 * "Recent polls" (issue #161). The numbers are the server's (`pollOutcome` of
 * `@quiz/domain`); this only draws them.
 *
 * - A question with a key is a small donut: correct, incorrect and — when
 *   every averaged run had a roster — no answer, clockwise from twelve
 *   o'clock in that fixed order, with the correct share printed in the hole.
 * - An opinion poll has nothing to be right about: "n answers", no donut.
 * - Nothing has finished yet: nothing.
 *
 * Colour (DESIGN.md, "Poll outcome donut"): correct wears `success`,
 * incorrect `warning` — not `danger`: green against red collapses for a
 * red-green reader (ΔE 4 in dark), and a poll marks nobody wrong — and no
 * answer is `fg-faint` at half strength, an absence rather than a category.
 * Colour is never alone: 2 px gaps part the segments, the hole prints the
 * correct share, and the hover/focus bubble and the accessible name spell
 * every share out in words.
 */

const SIZE = 36;
const THICKNESS = 5;
const RADIUS = (SIZE - THICKNESS) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** The surface gap between two segments, along the ring. */
const GAP = 2;

function runsLabel(t: T, runs: number): string {
  return runs === 1 ? t("poll.outcome.runsOne") : t("poll.outcome.runs", { n: runs });
}

/** Every share in words: the bubble, and the donut's accessible name. */
export function outcomeText(t: T, outcome: PollOutcome): string | null {
  if (outcome.kind === "none") return null;
  if (outcome.kind === "opinion") {
    return `${t("poll.outcome.opinion")} · ${runsLabel(t, outcome.runs)}`;
  }
  const parts = [
    t("poll.outcome.correct", { p: outcome.correct.percent }),
    t("poll.outcome.incorrect", { p: outcome.incorrect.percent }),
  ];
  if (outcome.abstention) parts.push(t("poll.outcome.abstention", { p: outcome.abstention.percent }));
  return `${parts.join(" · ")} (${runsLabel(t, outcome.runs)})`;
}

/** The three segment classes, in the fixed clockwise order. */
export const OUTCOME_STROKES = {
  correct: "stroke-success",
  incorrect: "stroke-warning",
  abstention: "stroke-fg-faint/50",
} as const;

/** The swatch of the legend, the same token as the segment. */
export const OUTCOME_FILLS = {
  correct: "bg-success",
  incorrect: "bg-warning",
  abstention: "bg-fg-faint/50",
} as const;

function Donut({ outcome }: { outcome: Extract<PollOutcome, { kind: "keyed" }> }) {
  const segments = (
    [
      ["correct", outcome.correct.rate],
      ["incorrect", outcome.incorrect.rate],
      ["abstention", outcome.abstention?.rate ?? 0],
    ] as const
  ).filter(([, rate]) => rate > 0);
  const gap = segments.length > 1 ? GAP : 0;
  let start = 0;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90" aria-hidden>
      {segments.map(([part, rate]) => {
        const length = rate * CIRCUMFERENCE;
        const drawn = Math.max(length - gap, 0.75);
        const offset = -start;
        start += length;
        return (
          <circle
            key={part}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={THICKNESS}
            strokeDasharray={`${drawn} ${CIRCUMFERENCE - drawn}`}
            strokeDashoffset={offset}
            className={OUTCOME_STROKES[part]}
          />
        );
      })}
    </svg>
  );
}

export function OutcomeBadge({ outcome }: { outcome: PollOutcome }) {
  const t = useT();
  const text = outcomeText(t, outcome);
  if (outcome.kind === "none" || text === null) return null;
  if (outcome.kind === "opinion") {
    const answers =
      outcome.answers === 0
        ? t("poll.outcome.answersNone")
        : outcome.answers === 1
          ? t("poll.outcome.answersOne")
          : t("poll.outcome.answers", { n: outcome.answers });
    const detail = outcome.runs > 1 ? `${text} · ${t("poll.outcome.perRun")}` : text;
    return (
      <Tip label={detail}>
        <span
          tabIndex={0}
          aria-label={`${answers}. ${detail}`}
          className="whitespace-nowrap rounded-sm text-xs tabular-nums text-fg-muted"
        >
          {answers}
        </span>
      </Tip>
    );
  }
  return (
    <Tip label={text}>
      <span
        role="img"
        tabIndex={0}
        aria-label={text}
        className="relative grid shrink-0 place-items-center rounded-full"
        style={{ width: SIZE, height: SIZE }}
      >
        <Donut outcome={outcome} />
        <span className="absolute text-[10px] font-semibold tabular-nums text-fg" aria-hidden>
          {outcome.correct.percent}
        </span>
      </span>
    </Tip>
  );
}

/** One line above the list naming the three colours, when a donut is shown. */
export function OutcomeLegend({ abstention }: { abstention: boolean }) {
  const t = useT();
  const items = [
    ["correct", t("poll.outcome.correctWord")],
    ["incorrect", t("poll.outcome.incorrectWord")],
    ...(abstention ? ([["abstention", t("poll.outcome.abstentionWord")]] as const) : []),
  ] as const;
  return (
    <p className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-fg-muted">
      <span>{t("poll.outcome.legend")}</span>
      {items.map(([part, word]) => (
        <span key={part} className="inline-flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${OUTCOME_FILLS[part]}`} aria-hidden />
          {word}
        </span>
      ))}
    </p>
  );
}
