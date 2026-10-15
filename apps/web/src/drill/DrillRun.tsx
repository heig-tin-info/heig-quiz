/**
 * Today's session, one card at a time (F-DRILL-03, ADR-041 §6), and its end.
 *
 * A card is served (`POST …/serve`: a new seed, the question through
 * `studentView`, invariant 4) and drawn by its type's OWN student player,
 * through the client registry the attempt uses (`QuestionHost`) — the drill
 * has no rendering path of its own. The answer is graded by the server, which
 * rates it and reschedules the card; the page then shows the correctness, the
 * rating, the next review and the key, through the type's own `Review`
 * (`QuestionReviewHost`), with a single primary "Next". The card itself is
 * `PracticeCard`, which a round of targeted revision draws too (ADR-115).
 *
 * The clock is the server's (invariant 5). The page only reports when the
 * question is on screen and when it is not (`POST …/shown`). Those reports
 * can only shorten the time counted (ADR-041 §11) — which is why the hidden
 * one must not be lost: an interval left open is credited up to the idle cap.
 *
 * Under the answer, before the correction, the student may say how sure they
 * are (ADR-085): five options, nothing selected, keys 0 to 4, never required.
 * It is sent with the answer and changes nothing of the rating; after the
 * correction one line says it back, highlighted when the student was sure
 * and wrong.
 *
 * The four decisions:
 *   - Type: the progress line and the question; the verdict is a badge and
 *     one line, the key is the type's own review.
 *   - Color: one accent, the primary button (Check, then Next). The verdict
 *     speaks in the semantic tones, never in accent.
 *   - Space: 16 inside the card, 24 between the card and the action.
 *   - Finish: one card on the canvas, hairlines, no shadow.
 */
import { useCallback, useState } from "react";

import type { DrillCorrectness, DrillDeviceClass, DrillReviewResult, DrillSessionCard } from "@quiz/contracts";

import { useI18n, useT } from "../i18n";
import { drillServeKey } from "../queryKeys";
import { Button, SegmentedBar, useNow } from "../ui";
import { answerCard, reportShown, serveCard } from "./api";
import { dueIn } from "./format";
import { CORRECTNESS, PracticeCard, PracticeProgress, PracticeSummary } from "./PracticeCard";

/** The FSRS rating, 1 Again to 4 Easy, in the student's words. */
const RATING = ["drill.rating.1", "drill.rating.2", "drill.rating.3", "drill.rating.4"] as const;

/** What one card of the session came to: its review, or skipped when it could not be served. */
export type DrillOutcome = DrillReviewResult | "skipped";

export function DrillRun({
  cards,
  device,
  onFinish,
}: {
  /** The session as it was when the student started it: a refetch must not reshuffle it. */
  cards: readonly DrillSessionCard[];
  device: DrillDeviceClass;
  onFinish: (outcomes: DrillOutcome[]) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const now = useNow(60_000);
  const [outcomes, setOutcomes] = useState<DrillOutcome[]>([]);
  const index = outcomes.length;
  const card = cards[index]!;
  // Stable for the card: the reports' effect must not run again on every render.
  const report = useCallback((shown: boolean) => void reportShown(card.id, shown).catch(() => {}), [card.id]);

  const next = (outcome: DrillOutcome) => {
    const all = [...outcomes, outcome];
    if (all.length >= cards.length) onFinish(all);
    else setOutcomes(all);
  };

  return (
    <div className="mx-auto max-w-180 space-y-6">
      <PracticeProgress
        index={index}
        isNew={card.isNew}
        aside={card.courseCode}
        segments={cards.map((c, i) => ({
          id: c.id,
          mark: i < index ? "answered" : "unanswered",
          current: i === index,
        }))}
      />
      <PracticeCard<DrillReviewResult>
        key={card.id}
        serveKey={drillServeKey(card.id)}
        serve={() => serveCard(card.id)}
        answer={(answer, confidence) => answerCard(card.id, answer, device, confidence)}
        report={report}
        line={(result) =>
          t("drill.result.line", {
            rating: t(RATING[result.rating - 1]!),
            when: dueIn(result.dueAt, now, locale),
          })
        }
        finishes={() => index === cards.length - 1}
        onNext={next}
        onSkip={() => next("skipped")}
      />
    </div>
  );
}

/** The end of today's session: how it went, and the way back. */
export function DrillSummary({ outcomes, onHome }: { outcomes: DrillOutcome[]; onHome: () => void }) {
  const t = useT();
  const reviews = outcomes.filter((o) => o !== "skipped");
  const count = (c: DrillCorrectness) => reviews.filter((r) => r.correctness === c).length;
  return (
    <PracticeSummary
      title={t("drill.done.title")}
      body={reviews.length === 1 ? t("drill.done.body.one") : t("drill.done.body", { n: reviews.length })}
      actions={<Button onClick={onHome}>{t("drill.done.home")}</Button>}
    >
      {reviews.length > 0 ? (
        <div className="space-y-2">
          <SegmentedBar
            parts={(Object.keys(CORRECTNESS) as DrillCorrectness[]).map((c) => ({
              tone: CORRECTNESS[c].bar,
              value: count(c),
              label: t(CORRECTNESS[c].label),
            }))}
          />
          <p className="text-[13px] tabular-nums text-fg-muted">
            {t("drill.done.counts", { right: count("right"), partial: count("partial"), wrong: count("wrong") })}
          </p>
        </div>
      ) : null}
    </PracticeSummary>
  );
}
