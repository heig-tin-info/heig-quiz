import type { ByQuestion } from "@quiz/contracts";
import { displayedRate } from "@quiz/domain";

import { useI18n, useT } from "../i18n";
import { BarLegend, percent, Stat, StackedBars, type BarPart, type BarTone } from "../ui";
import { Summary } from "./Summary";

/** The four outcomes of a question, in the correction's tones (`CorrectionQuestion`'s head). */
const OUTCOMES = [
  ["correct", "success"],
  ["partial", "partial"],
  ["wrong", "danger"],
  ["blank", "warning"],
] as const satisfies readonly (readonly [keyof ByQuestion["outcomes"], BarTone])[];

/** The anchor of a question's card in the Questions tab, which a bar scrolls to. */
export const questionAnchor = (itemId: string) => `question-${itemId}`;

/**
 * The head of the Questions tab, as the Students tab has one: how the class
 * fared on each question — one column per question, cut into correct,
 * partial, wrong and no answer — beside four figures: the mean success, the
 * hardest and the best-answered question, and the share of blanks. A column
 * scrolls to its question's card.
 */
export function QuestionSummary({ questions }: { questions: ByQuestion[] }) {
  const t = useT();
  const { locale } = useI18n();
  const rate = (r: number) => percent(displayedRate(r), locale);

  const rated = questions.filter((q) => q.successRate !== null);
  const mean = rated.length === 0 ? null : rated.reduce((s, q) => s + q.successRate!, 0) / rated.length;
  const byRate = [...rated].sort((a, b) => a.successRate! - b.successRate!);
  const hardest = byRate[0];
  // One rated question is not both the hardest and the best answered.
  const easiest = byRate.length < 2 ? undefined : byRate.at(-1);
  const sum = (key: keyof ByQuestion["outcomes"]) => questions.reduce((s, q) => s + q.outcomes[key], 0);
  const blank = sum("blank");
  const answers = blank + sum("correct") + sum("partial") + sum("wrong");

  const label = (key: (typeof OUTCOMES)[number][0]) => t(`correction.outcome.${key}`);
  const extreme = (title: string, q: ByQuestion | undefined) => (
    <Stat
      label={title}
      value={q ? t("results.qstat.q", { n: q.item.position + 1 }) : "—"}
      aside={q ? rate(q.successRate!) : undefined}
      hint={q ? <span className="block truncate">{q.item.internalName}</span> : undefined}
    />
  );

  return (
    <Summary
      title={t("results.questions.title")}
      chart={
        <div className="space-y-3">
          <StackedBars
            className="h-40 lg:h-56"
            caption={t("results.questions.title")}
            labelHeader={t("results.questions.col")}
            onSelect={(id) =>
              document.getElementById(questionAnchor(id))?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            bars={questions.map((q) => ({
              key: q.item.id,
              // `position` is 0-based on the wire.
              label: t("correction.question", { n: q.item.position + 1 }),
              tick: String(q.item.position + 1),
              parts: OUTCOMES.map(
                ([key, tone]): BarPart => ({ tone, value: q.outcomes[key], label: label(key) }),
              ),
            }))}
          />
          <BarLegend parts={OUTCOMES.map(([key, tone]) => ({ tone, label: label(key) }))} />
        </div>
      }
      stats={
        <>
          <Stat
            label={t("results.qstat.mean")}
            value={mean === null ? "—" : rate(mean)}
            aside={t("results.qstat.questions", { n: questions.length })}
          />
          {extreme(t("results.qstat.hardest"), hardest)}
          {extreme(t("results.qstat.easiest"), easiest)}
          <Stat
            label={t("results.qstat.blank")}
            value={answers === 0 ? "—" : rate(blank / answers)}
            aside={`${blank} / ${answers}`}
          />
        </>
      }
    />
  );
}
