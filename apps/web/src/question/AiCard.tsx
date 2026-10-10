import { CircleCheck, CircleX, PenLine, ScanSearch, Sparkles, Undo2, WandSparkles, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { NewConceptName, QuestionDetail, QuestionReview } from "@quiz/contracts";

import { AppLink } from "../AppLink";
import { SuggestConcepts } from "../concepts/SuggestConcepts";
import { useT } from "../i18n";
import { useLlmAvailability } from "../llmAvailability";
import { FindingRow } from "../pool/ReviewTab";
import type { Navigate } from "../router";
import { Button, Card, cx, RelativeTime, SectionHeading, textLink } from "../ui";
import type { Wand } from "./generate";
import { useReviewNow } from "./reviewNow";

/**
 * The LLM actions of a question, in one card of the editor's aside, above
 * "Properties" (ADR-082): "Generate answers" (ADR-059) with its Undo, and
 * "Review now" (ADR-060) with the review of the latest published version,
 * read-only — Fix and Ignore stay in the pool's "LLM review" tab — and
 * "Suggest concepts" (ADR-081 sixth addendum §6, ADR-082 §5), which any type
 * and any state of the question has.
 *
 * Absent, not disabled, when no action applies: no model or a reader. Every button is
 * `secondary`: Publish stays the screen's one primary action.
 */
export function AiCard({
  data,
  wand,
  readOnly,
  navigate,
  draftConfig,
  onCreateConcept,
}: {
  data: QuestionDetail;
  wand: Wand;
  readOnly: boolean;
  navigate: Navigate;
  /** The editor's draft config, saved or not: what Suggest concepts reads. */
  draftConfig: unknown;
  /** A new concept the model suggested: the editor opens the picker's create form with it. */
  onCreateConcept: (name: NewConceptName) => void;
}) {
  const t = useT();
  const review = useReviewNow(data, readOnly);
  const suggest = useLlmAvailability().data?.available === true && !readOnly;
  if (!wand.enabled && !review && !suggest) return null;

  return (
    <Card className="space-y-4 p-4">
      <SectionHeading icon={Sparkles} title={t("question.ai")} />

      {wand.enabled ? (
        <div className="space-y-2">
          {wand.ready ? (
            <>
              <Button variant="secondary" className="w-full" loading={wand.pending} onClick={wand.run}>
                {wand.pending ? null : <WandSparkles />} {t("question.generate")}
              </Button>
              <p className="text-xs text-fg-muted">{t("question.generate.hint")}</p>
            </>
          ) : (
            // Why there is no button yet: the model completes a question, it never invents one.
            <Line icon={PenLine} tone="text-fg-faint">
              {t("question.ai.needsStatement")}
            </Line>
          )}
          {wand.undo ? (
            <div role="status" className="space-y-1 rounded-field bg-surface-2 p-3 text-[13px]">
              <p className="flex items-center gap-1.5 font-semibold">
                <WandSparkles className="size-4 shrink-0 text-fg-muted" aria-hidden />
                {t("question.generate.done.title")}
              </p>
              <p className="text-fg-muted">{t("question.generate.done.body")}</p>
              {wand.incomplete ? (
                <p className="text-fg-muted">{t(`question.generate.incomplete.${wand.incomplete}`)}</p>
              ) : null}
              <Button variant="ghost" size="sm" onClick={wand.undo}>
                <Undo2 /> {t("question.generate.undo")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {review ? (
        <div className={cx("space-y-3", wand.enabled && "border-t border-line pt-4")}>
          {review.review ? (
            <ReviewOutcome review={review.review} poolId={data.meta.poolId} navigate={navigate} />
          ) : null}
          <Button variant="secondary" className="w-full" loading={review.pending} onClick={review.run}>
            {review.pending ? null : <ScanSearch />} {t("review.now")}
          </Button>
        </div>
      ) : null}

      {suggest ? (
        <div className={cx(wand.enabled || review ? "border-t border-line pt-4" : "")}>
          <SuggestConcepts meta={data.meta} config={draftConfig} onCreate={onCreateConcept} />
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The review of the latest published version, as the pool's pill reads it
 * (`reviewPill`, ADR-060 §3): one line when clean or ignored, one line when
 * the call failed — "Review now" is the retry —, the findings listed
 * otherwise, with the way to the tab where they are fixed.
 */
function ReviewOutcome({
  review,
  poolId,
  navigate,
}: {
  review: QuestionReview;
  poolId: string;
  navigate: Navigate;
}) {
  const t = useT();
  const n = review.versionNumber;
  if (review.state === "clean" || review.state === "ignored") {
    return (
      <Line icon={CircleCheck} tone="text-success">
        {t("question.ai.review.clean", { n })}
      </Line>
    );
  }
  if (review.state === "failed") {
    return (
      <Line icon={CircleX} tone="text-danger">
        {t("question.ai.review.failed", { n })}
      </Line>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-fg-muted">
        <span className="font-medium text-fg">{t("question.ai.review.findings", { n })}</span>
        {" · "}
        <RelativeTime iso={review.reviewedAt} />
      </p>
      <ul className="space-y-2">
        {review.findings.map((finding, index) => (
          <FindingRow key={index} finding={finding} />
        ))}
      </ul>
      <AppLink
        route={{ view: "pool", id: poolId, tab: "review" }}
        navigate={navigate}
        className={cx("inline-block text-[13px] text-fg-muted underline", textLink)}
      >
        {t("question.ai.review.open")}
      </AppLink>
    </div>
  );
}

/** One muted line of the card, behind its icon. */
function Line({ icon: Icon, tone, children }: { icon: LucideIcon; tone: string; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-[13px] text-fg-muted">
      <Icon className={cx("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
      {children}
    </p>
  );
}
