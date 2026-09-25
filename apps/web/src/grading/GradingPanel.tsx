import { useMutation } from "@tanstack/react-query";
import { BarChart3, CheckCheck, RefreshCcw } from "lucide-react";
import { useEffect, useState } from "react";

import type { GradingConfidence, GradingSource } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import { useScreenCommands } from "../screenCommands";
import { Button, Card, EmptyState, PageError, PageHeader } from "../ui";
import { BatchBar, type BatchScope } from "./BatchBar";
import { ListSkeleton } from "./ListSkeleton";
import { entryKey } from "./EntryList";
import { GradingFilters } from "./GradingFilters";
import { GradingHeader } from "./GradingHeader";
import { StepAnswers, StepCard, StepList } from "./GradingStep";
import { gradingLinks } from "./index";
import { ORDER_WORDS, type GradingOrder } from "./labels";
import { RegradeSheet } from "./RegradeSheet";
import { OverrideSheet } from "./OverrideSheet";
import { useGradingInvalidate } from "./useGradingInvalidate";
import { useGradingKeys } from "./useGradingKeys";
import {
  ANY,
  neighbour,
  useGradingTraversal,
  type Any,
  type StateFilter,
} from "./useGradingTraversal";

/**
 * The grading panel (F-GRADE-03 to 06, mockup `04-correction.html`).
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
 *
 * What it reads is `useGradingTraversal`, its keyboard is `useGradingKeys`,
 * its filter row is `GradingFilters` and one step is `GradingStep`; this
 * component holds the choices and lays the screen out.
 */

export function GradingPanel({
  evaluationId,
  navigate,
}: {
  evaluationId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();

  const [order, setOrder] = useState<GradingOrder>("question");
  const [showNames, setShowNames] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [source, setSource] = useState<GradingSource | Any>(ANY);
  const [confidence, setConfidence] = useState<GradingConfidence | Any>(ANY);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [regrading, setRegrading] = useState(false);

  const { evaluation, itemsById, steps, step, queue, entries, counts, progress, explanations } =
    useGradingTraversal(evaluationId, {
      order,
      index,
      selected,
      stateFilter,
      source,
      confidence,
      showNames,
    });

  const proposedCount = entries.filter((e) => e.grading?.state === "proposed").length;

  // The selection follows the list: it lands on the first answer of a step
  // and never points at a row that is no longer there.
  useEffect(() => {
    if (entries.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((current) =>
      current && entries.some((e) => entryKey(e) === current) ? current : entryKey(entries[0]!),
    );
  }, [entries]);

  const overrideEntry = entries.find((e) => entryKey(e) === overrideKey) ?? null;

  /** One answer back or forward: the detail's buttons, the same as `←` / `→`. */
  const move = (delta: number) => {
    const next = neighbour(entries, selected, delta);
    if (next) setSelected(next);
  };

  // --- Mutations ---------------------------------------------------------

  const invalidate = useGradingInvalidate(evaluationId);

  const validate = useMutation({
    mutationFn: (gradingId: string) =>
      api(`/app/api/gradings/${gradingId}/validate`, { method: "POST", body: "{}" }),
    onSuccess: invalidate,
    onError: toastError("grading.validate.failed"),
  });

  const run = useMutation({
    mutationFn: () =>
      api(`/app/api/evaluations/${evaluationId}/grading/run`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      invalidate();
      toast(t("grading.run.started"), "progress");
    },
    onError: toastError("grading.run.failed"),
  });

  useGradingKeys({
    entries,
    selected,
    onSelect: setSelected,
    onValidate: validate.mutate,
    onOverride: setOverrideKey,
  });

  // --- Palette commands of this screen ----------------------------------

  const links = gradingLinks(evaluationId);
  useScreenCommands([
    {
      id: "grading:results",
      label: t("palette.openResults"),
      icon: BarChart3,
      group: "navigate",
      run: () => navigate(links.results),
    },
    {
      id: "grading:run",
      label: t("grading.run"),
      icon: CheckCheck,
      group: "action",
      run: () => run.mutate(),
    },
    ...(order === "question" && step
      ? [
          {
            id: "grading:regrade",
            label: t("grading.regrade"),
            icon: RefreshCcw,
            group: "action" as const,
            run: () => setRegrading(true),
          },
        ]
      : []),
  ]);

  // --- Render ------------------------------------------------------------

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

  const title = evaluation.data?.evaluation.title ?? "";
  const currentItem = order === "question" && step ? itemsById.get(step.key) : undefined;
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

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={title}
        title={t("grading.title")}
        help="grading"
        description={t("grading.subtitle")}
        actions={
          <Button variant="secondary" onClick={() => navigate(links.results)}>
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
          <GradingHeader
            order={order}
            steps={steps}
            index={index}
            onPrev={() => setIndex((i) => (i - 1 + steps.length) % steps.length)}
            onNext={() => setIndex((i) => (i + 1) % steps.length)}
            onJump={setIndex}
            prevLabel={t(words.prev)}
            nextLabel={t(words.next)}
            title={t(words.position, { n: index + 1, total: steps.length })}
            counts={counts}
            progress={progress.data}
            onRun={() => run.mutate()}
            running={run.isPending}
            runPrimary={runPrimary}
          />

          <GradingFilters
            order={order}
            onOrder={(v) => {
              setOrder(v);
              setIndex(0);
            }}
            stateFilter={stateFilter}
            onStateFilter={setStateFilter}
            source={source}
            onSource={setSource}
            confidence={confidence}
            onConfidence={setConfidence}
            showNames={showNames}
            onShowNames={setShowNames}
          />

          {order === "question" && proposedCount > 0 ? (
            <BatchBar
              evaluationId={evaluationId}
              scope={scope}
              count={proposedCount}
              scoped={source !== ANY || confidence !== ANY}
              primary={!runPrimary}
            />
          ) : null}

          {/* Master and detail from `lg`, at the height of the window (the
              page's own vertical padding taken off) and never taller or
              shorter, whatever the answer holds: the next answer then changes
              neither the height of the page nor its scroll. Both columns
              scroll inside themselves. Below `lg` the columns stack, the list
              becomes a select above the answer, and the page scrolls as any
              page does. */}
          <div className="flex flex-col gap-6 lg:h-[calc(100dvh-4rem)] lg:min-h-120 lg:flex-row">
            <aside
              aria-label={t("aside.gradingItem")}
              className="flex w-full shrink-0 flex-col gap-4 lg:min-h-0 lg:w-75"
            >
              <StepCard
                order={order}
                label={step?.label}
                item={currentItem}
                total={counts.total}
                onRegrade={() => setRegrading(true)}
              />
              <StepList
                className="hidden lg:flex lg:min-h-0 lg:flex-1"
                order={order}
                queue={queue}
                entries={entries}
                items={itemsById}
                selected={selected}
                onSelect={setSelected}
              />
            </aside>

            <section
              className="flex w-full min-w-0 flex-1 flex-col gap-3 lg:min-h-0"
              aria-label={t("grading.title")}
            >
              <StepAnswers
                order={order}
                queue={queue}
                entries={entries}
                items={itemsById}
                selected={selected}
                onSelect={setSelected}
                onMove={move}
                explanations={explanations}
                validating={validate.isPending}
                onValidate={validate.mutate}
                onOverride={setOverrideKey}
              />
            </section>
          </div>
        </>
      )}

      {overrideEntry ? (
        <OverrideSheet
          evaluationId={evaluationId}
          entry={overrideEntry}
          maxPoints={
            overrideEntry.grading?.maxPoints ?? itemsById.get(overrideEntry.itemId)?.points ?? 0
          }
          onClose={() => setOverrideKey(null)}
        />
      ) : null}

      {regrading && currentItem ? (
        <RegradeSheet
          evaluationId={evaluationId}
          item={currentItem}
          onClose={() => setRegrading(false)}
        />
      ) : null}
    </div>
  );
}
