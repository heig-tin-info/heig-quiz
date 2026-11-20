/**
 * The agreement figures of a grading (ADR-139 §15), as quiet readings for
 * the staff: counts with their total, never a bare percentage, and nothing
 * where the server sends `null`. The grading panel's question bar and the
 * results' Questions tab draw them; the projection and every student
 * surface never do.
 */
import { MessageSquareWarning, Sparkles } from "lucide-react";

import type { AiAgreement, ContestationTally, GradingFigures } from "@quiz/contracts";
import { formatPoints, GRADING_SOURCES } from "@quiz/domain";
import { LLM_CONFIDENCES } from "@quiz/core/llm";

import { useT, type TFunction } from "../i18n";
import { Badge, Stat, Tip } from "../ui";
import { confidenceLabelShort, sourceLabel } from "./labels";

/** The mean difference of the changed proposals, then the count for each confidence the model stated. */
function agreementDetail(t: TFunction, agreement: AiAgreement): string[] {
  const levels = LLM_CONFIDENCES.flatMap((level) => {
    const tally = agreement.byConfidence[level];
    return tally ? [`${confidenceLabelShort(t, level)} ${tally.unchanged}/${tally.compared}`] : [];
  })
    // The strongest first, as the filter lists them.
    .reverse();
  return [
    ...(agreement.meanAbsDelta === null
      ? []
      : [t("figures.agreement.delta", { points: t("grading.points", { n: formatPoints(agreement.meanAbsDelta) }) })]),
    t("figures.confidence", { list: levels.join(", ") }),
  ];
}

/** Where the contestations stand, then per source of the contested grading those filed and accepted. */
function contestationDetail(t: TFunction, tally: ContestationTally): string[] {
  const sources = GRADING_SOURCES.filter((source) => tally.bySource[source].filed > 0).map((source) =>
    t("figures.contested.source", { source: sourceLabel(t, source), ...tally.bySource[source] }),
  );
  return [
    t("figures.contested.verdicts", { open: tally.open, accepted: tally.accepted, refused: tally.refused }),
    ...(sources.length === 0 ? [] : [t("figures.contested.sources", { list: sources.join(", ") })]),
  ];
}

/** "AI: 12 of 15 unchanged", its detail in the tooltip; nothing when nothing was compared. */
export function AgreementBadge({ agreement }: { agreement: AiAgreement | null | undefined }) {
  const t = useT();
  if (!agreement) return null;
  return (
    <Tip label={agreementDetail(t, agreement).join(" · ")}>
      <Badge tone="zinc" icon={Sparkles}>
        {t("figures.agreement.badge", { unchanged: agreement.unchanged, compared: agreement.compared })}
      </Badge>
    </Tip>
  );
}

/** "3 contested", its detail in the tooltip when given; nothing at 0. The question bar's open ones, the results' filed ones. */
export function ContestedBadge({ n, tip }: { n: number; tip?: string | undefined }) {
  const t = useT();
  if (n === 0) return null;
  return (
    <Tip label={tip}>
      <Badge tone="zinc" icon={MessageSquareWarning}>
        {n === 1 ? t("grading.steps.contested.one") : t("grading.steps.contested", { n })}
      </Badge>
    </Tip>
  );
}

/** A question's contestations on the results: the count, over how many graded answers and the detail in the tooltip. */
export function ContestationsBadge({ tally }: { tally: ContestationTally | null }) {
  const t = useT();
  if (!tally) return null;
  const tip = [t("figures.contested.share", { filed: tally.filed, graded: tally.graded }), ...contestationDetail(t, tally)];
  return <ContestedBadge n={tally.filed} tip={tip.join(" · ")} />;
}

/** The detail lines of a figure, under its value. */
const Lines = ({ lines }: { lines: string[] }) => (
  <>
    {lines.map((line) => (
      <span key={line} className="block">
        {line}
      </span>
    ))}
  </>
);

/**
 * The whole evaluation's figures, two `Stat`s under the Questions tab's
 * summary: the count, its total beside the label, the detail under it.
 * Nothing when both are `null`; one alone takes the row's first half.
 */
export function GradingFiguresStats({ figures }: { figures: GradingFigures }) {
  const t = useT();
  const { agreement, contestations } = figures;
  if (!agreement && !contestations) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {agreement ? (
        <Stat
          label={t("figures.agreement.label")}
          icon={Sparkles}
          value={agreement.unchanged}
          aside={t("figures.agreement.of", { compared: agreement.compared })}
          hint={<Lines lines={agreementDetail(t, agreement)} />}
        />
      ) : null}
      {contestations ? (
        <Stat
          label={t("figures.contested.label")}
          icon={MessageSquareWarning}
          value={contestations.filed}
          aside={t("figures.contested.of", { graded: contestations.graded })}
          hint={<Lines lines={contestationDetail(t, contestations)} />}
        />
      ) : null}
    </div>
  );
}
