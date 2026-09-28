import { BarChart3, CheckCheck } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { useT } from "../i18n";
import type { Route } from "../router";
import { Button, Card, EmptyState, PageError, PageHeader } from "../ui";
import { BatchBar, type BatchScope } from "./BatchBar";
import { entryKey } from "./EntryList";
import { GradingFilters } from "./GradingFilters";
import { GradingHeader } from "./GradingHeader";
import { GradingWorkspace } from "./GradingWorkspace";
import { ListSkeleton } from "./ListSkeleton";
import { ORDER_WORDS } from "./labels";
import { OverrideSheet } from "./OverrideSheet";
import { RegradeSheet } from "./RegradeSheet";
import { StepBadges } from "./StepBadges";
import { useAnswerAnchor } from "./useAnswerAnchor";
import { useGradingActions } from "./useGradingActions";
import { useGradingKeys } from "./useGradingKeys";
import { useGradingSession } from "./useGradingSession";
import { ANY } from "./useGradingTraversal";

/**
 * The grading panel (F-GRADE-03 to 06).
 *
 * The whole screen is one traversal: a path of steps at the top — walked with
 * the chevrons or jumped through with the step picker (#107) — and under it
 * the answers of the current step as master and detail (#102): a compact
 * list on the side, and ONE answer at a fixed place beside it, swapped in
 * place by Previous / Next, a click in the list or the arrow keys. On a wide
 * screen that area has the height of the window, whatever the answer holds,
 * so going to the next answer changes neither the page's height nor its
 * scroll: nothing moves under the teacher's eyes. The traversal runs BY
 * QUESTION by default — grading the same question across thirty students is
 * the only way to grade it consistently — and by student on demand.
 *
 * Names are hidden until the teacher asks (F-GRADE-03, decision D20), and
 * the server is what hides them: `?anonymous=0` is a different request, not
 * a client-side unmasking of something already downloaded.
 *
 * One accent action: the batch validation. Everything else — validate one,
 * adjust, re-grade, run the pass — is secondary or lives in the detail.
 * The step's badges sit in the step header and re-grading is on each answer
 * (#108), so the side column holds the answer list alone.
 *
 * Its state and what it reads are `useGradingSession` (over
 * `useGradingTraversal`), what it does is `useGradingActions`, its keyboard
 * is `useGradingKeys` and the answer's fixed place `useAnswerAnchor`; its
 * filter row is `GradingFilters`, the step's badges `StepBadges` and the
 * list and the answer `GradingWorkspace`. This component composes them.
 */
export function GradingPanel({
  evaluationId,
  navigate,
}: {
  evaluationId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const session = useGradingSession(evaluationId);
  const { view, setView, evaluation, itemsById, steps, step, entries, counts, progress, current } =
    session;
  const { order, source, confidence } = view;
  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  /** The item whose re-grade sheet is open (#108: from any answer, either order). */
  const [regradeId, setRegradeId] = useState<string | null>(null);

  /** The step's question, by question. */
  const currentItem = order === "question" && step ? itemsById.get(step.key) : undefined;
  const { validate, run, openResults } = useGradingActions({
    evaluationId,
    navigate,
    // The question a palette "re-grade" means: the step's, else the open answer's.
    regradeTarget: currentItem ?? (current ? itemsById.get(current.entry.itemId) : undefined),
    onRegrade: setRegradeId,
  });

  useGradingKeys({
    entries,
    selected: session.selected,
    onSelect: session.select,
    onValidate: validate.mutate,
    onOverride: setOverrideKey,
  });

  const { stickyRef, answersRef, stickyHeight } = useAnswerAnchor(session.selected, steps.length);

  if (evaluation.isLoading) return <ListSkeleton />;
  if (evaluation.isError) {
    return (
      <PageError
        title={t("grading.loadFailed")}
        error={evaluation.error}
        onRetry={() => void evaluation.refetch()}
        retrying={evaluation.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  const words = ORDER_WORDS[order];
  /*
   * The screen's single accent action. Running the pass is it only while
   * NOTHING has been graded — that is the one moment the page has nothing
   * else to offer. As soon as there are proposals, validating them is the
   * work and "Run grading" steps down to a secondary: a stray unsettled cell
   * must not take the accent away from the thing the teacher came to do.
   */
  const runPrimary =
    progress.data !== undefined && progress.data.total > 0 && progress.data.done === 0;
  const scope: BatchScope = {
    ...(currentItem ? { itemId: currentItem.id } : {}),
    ...(source === ANY ? {} : { source }),
    ...(confidence === ANY ? {} : { confidence }),
  };
  const overrideEntry = entries.find((e) => entryKey(e) === overrideKey) ?? null;
  const regradeItem = regradeId ? itemsById.get(regradeId) : undefined;

  return (
    <div
      className="space-y-6"
      style={{ "--grading-sticky": `${stickyHeight}px` } as CSSProperties}
    >
      <PageHeader
        eyebrow={evaluation.data?.evaluation.title ?? ""}
        title={t("grading.title")}
        help="grading"
        description={t("grading.subtitle")}
        actions={
          <Button variant="secondary" onClick={openResults}>
            <BarChart3 /> {t("grading.openResults")}
          </Button>
        }
      />

      {steps.length === 0 ? (
        <Card>
          <EmptyState icon={CheckCheck} title={t("grading.empty.noAttempt.title")}>
            {t("grading.empty.noAttempt.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          {/* The step header sticks to the top from `lg`, on a strip of canvas
              that hides what scrolls under it; its height, measured, is where
              the list column and the detail's own header stick below it. */}
          <div
            ref={stickyRef}
            className="lg:sticky lg:top-0 lg:z-20 lg:-mt-4 lg:bg-canvas lg:pb-3 lg:pt-4"
          >
            <GradingHeader
              order={order}
              steps={steps}
              index={session.index}
              onPrev={session.prevStep}
              onNext={session.nextStep}
              onJump={session.jumpTo}
              prevLabel={t(words.prev)}
              nextLabel={t(words.next)}
              title={t(words.position, { n: session.index + 1, total: steps.length })}
              // By student the counter names who it counts (#119); by question
              // the badges beside it and the answer's header name the question.
              subject={order === "student" ? step?.label : undefined}
              counts={counts}
              progress={progress.data}
              onRun={() => run.mutate()}
              running={run.isPending}
              runPrimary={runPrimary}
              badges={
                <StepBadges
                  order={order}
                  stateFilter={view.stateFilter}
                  item={currentItem}
                  queue={session.queue.data}
                  total={counts.total}
                  itemsById={itemsById}
                />
              }
            />
          </div>

          <GradingFilters
            order={order}
            onOrder={session.setOrder}
            stateFilter={view.stateFilter}
            onStateFilter={(v) => setView({ stateFilter: v })}
            source={source}
            onSource={(v) => setView({ source: v })}
            confidence={confidence}
            onConfidence={(v) => setView({ confidence: v })}
            showNames={session.showNames}
            onShowNames={session.setShowNames}
            parts={view.parts}
            onParts={(v) => setView({ parts: v })}
          />

          {/* Always there by question, even at zero: the banner going away
              when the last proposal is validated would lift everything under
              it by its own height, the answer being read included. */}
          {order === "question" ? (
            <BatchBar
              evaluationId={evaluationId}
              scope={scope}
              count={entries.filter((e) => e.grading?.state === "proposed").length}
              scoped={source !== ANY || confidence !== ANY}
              primary={!runPrimary}
            />
          ) : null}

          <GradingWorkspace
            session={session}
            answersRef={answersRef}
            validating={validate.isPending}
            onValidate={validate.mutate}
            onOverride={setOverrideKey}
            onRegrade={(item) => setRegradeId(item.id)}
          />
        </>
      )}

      {overrideEntry ? (
        <OverrideSheet
          evaluationId={evaluationId}
          entry={overrideEntry}
          maxPoints={
            overrideEntry.grading?.maxPoints ?? itemsById.get(overrideEntry.itemId)?.points ?? 0
          }
          minPoints={itemsById.get(overrideEntry.itemId)?.minPoints ?? 0}
          onClose={() => setOverrideKey(null)}
        />
      ) : null}

      {regradeItem ? (
        <RegradeSheet
          evaluationId={evaluationId}
          item={regradeItem}
          onClose={() => setRegradeId(null)}
        />
      ) : null}
    </div>
  );
}
