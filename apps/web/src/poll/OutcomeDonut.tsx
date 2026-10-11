import type { PollOutcome } from "@quiz/contracts";

import { useT, type TFunction as T } from "../i18n";
import { RingChart, Tip } from "../ui";

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

/** The swatch of the legend, the same token as the segment. */
export const OUTCOME_FILLS = {
  correct: "bg-success",
  incorrect: "bg-warning",
  abstention: "bg-fg-faint/50",
} as const;

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
  // The ring is the generic one (`ui/ring.tsx`): the parts keep this order, the correct share is the hole.
  return (
    <RingChart
      sentence={text}
      hole={outcome.correct.percent}
      parts={[
        { value: outcome.correct.rate, tone: "success", label: "" },
        { value: outcome.incorrect.rate, tone: "warning", label: "" },
        { value: outcome.abstention?.rate ?? 0, tone: "faint", label: "" },
      ]}
    />
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
