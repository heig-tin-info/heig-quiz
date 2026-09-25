import { useMutation } from "@tanstack/react-query";
import { BarChart3, CheckCheck, RefreshCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { formatPoints } from "@quiz/domain";

import type { GradingConfidence, GradingSource } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import { useScreenCommands } from "../screenCommands";
import { typeLabel } from "../questionTypes";
import { Badge, Button, Card, cx, EmptyState, PageError, PageHeader, useMinWidth } from "../ui";
import { BatchBar, type BatchScope } from "./BatchBar";
import { ListSkeleton } from "./ListSkeleton";
import { entryKey } from "./EntryList";
import { GradingFilters } from "./GradingFilters";
import { GradingHeader } from "./GradingHeader";
import { StepAnswers, StepList } from "./GradingStep";
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
 * The step's badges sit in the step header and re-grading is on each answer
 * (#108), so the side column holds the answer list alone.
 *
 * What it reads is `useGradingTraversal`, its keyboard is `useGradingKeys`,
 * its filter row is `GradingFilters` and one step is `GradingStep`; this
 * component holds the choices and lays the screen out.
 */

/** The phone's sticky top bar (`h-14` in `Shell`) plus a little air. */
const PHONE_BAR = 64;

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
  /** The item whose re-grade sheet is open (#108: from any answer, either order). */
  const [regradeId, setRegradeId] = useState<string | null>(null);

  const {
    evaluation,
    itemsById,
    steps,
    step,
    queue,
    entries,
    counts,
    progress,
    explanations,
    current,
  } =
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

  // --- Keeping the answer in one place -----------------------------------

  const wide = useMinWidth(1024);
  const stickyRef = useRef<HTMLDivElement>(null);
  const answersRef = useRef<HTMLElement>(null);
  const [stickyHeight, setStickyHeight] = useState(0);

  // The height of the sticky step header, as a CSS variable the list column
  // and the detail's header stick under.
  useLayoutEffect(() => {
    const el = stickyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setStickyHeight(wide ? el.offsetHeight : 0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [wide, steps.length]);

  /*
   * Another answer opened: its top goes right under whatever sticks at the
   * top of the window (the step header from `lg`, the phone's top bar
   * below), wherever the teacher had scrolled to in the previous one — the
   * next step's first answer included. The answer the panel opens on is
   * not a move, and does not scroll.
   */
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = selected;
    const el = answersRef.current;
    if (!el || was === null || selected === null || was === selected) return;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return; // no layout (a test): nothing to align
    const target = wide ? stickyHeight : PHONE_BAR;
    if (Math.abs(rect.top - target) > 1) window.scrollBy({ top: rect.top - target });
  }, [selected, wide, stickyHeight]);

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

  /** The question a palette "re-grade" means: the step's, else the open answer's. */
  const regradeTarget =
    (order === "question" && step ? itemsById.get(step.key) : undefined) ??
    (current ? itemsById.get(current.entry.itemId) : undefined);

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
    ...(regradeTarget
      ? [
          {
            id: "grading:regrade",
            label: t("grading.regrade"),
            icon: RefreshCcw,
            group: "action" as const,
            run: () => setRegradeId(regradeTarget.id),
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
  /*
   * What the step is, beside its counter (#108). A question: its type, its
   * points and how many answers it has. A student: how many answers, and
   * their running total — the question's points mean nothing across a whole
   * copy, the student's total is what a teacher checks at the end of one.
   * The total is read from the queue as the server sent it, so only while
   * the state filter keeps every answer: a total of the proposals alone
   * would be a number that is no one's grade.
   */
  const stepEntries = queue.data?.entries ?? [];
  const studentTotal =
    order === "student" && stateFilter === "all" && queue.data && stepEntries.length > 0
      ? stepEntries.reduce(
          (sum, e) => ({
            points: sum.points + (e.grading?.points ?? 0),
            max: sum.max + (e.grading?.maxPoints ?? itemsById.get(e.itemId)?.points ?? 0),
          }),
          { points: 0, max: 0 },
        )
      : null;
  const badges = (
    <>
      {currentItem ? (
        <>
          <Badge tone="zinc">{typeLabel(t, currentItem.type)}</Badge>
          <Badge tone="zinc">{t("grading.points", { n: currentItem.points })}</Badge>
        </>
      ) : null}
      <Badge tone="zinc">{t("grading.answers", { n: counts.total })}</Badge>
      {studentTotal ? (
        <Badge tone="zinc">
          {t("grading.studentTotal", {
            points: formatPoints(studentTotal.points),
            max: formatPoints(studentTotal.max),
          })}
        </Badge>
      ) : null}
    </>
  );
  const listed = queue.isLoading || (!queue.isError && entries.length > 0);
  const regradeItem = regradeId ? itemsById.get(regradeId) : undefined;
  const scope: BatchScope = {
    ...(currentItem ? { itemId: currentItem.id } : {}),
    ...(source === ANY ? {} : { source }),
    ...(confidence === ANY ? {} : { confidence }),
  };

  return (
    <div
      className="space-y-6"
      style={{ "--grading-sticky": `${stickyHeight}px` } as CSSProperties}
    >
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
            badges={badges}
          />
          </div>

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

          {/* Always there by question, even at zero: the banner going away
              when the last proposal is validated would lift everything under
              it by its own height, the answer being read included. */}
          {order === "question" ? (
            <BatchBar
              evaluationId={evaluationId}
              scope={scope}
              count={proposedCount}
              scoped={source !== ANY || confidence !== ANY}
              primary={!runPrimary}
            />
          ) : null}

          {/* Master and detail from `lg`: the list column sticks under the
              step header and scrolls inside itself; the answer is in the
              page's flow, at least a window tall, its own header sticking
              under the step header. Moving to another answer brings the
              answer's top back under that header (see `answersRef`), so the
              teacher never scrolls to find it and it is always read from the
              same spot. Below `lg` the columns stack, the list becomes a
              select above the answer, and the same alignment happens under
              the phone's top bar. */}
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
            {/* Only the list lives here since #108: below `lg` it is the
                select above the answer, and the column is not drawn. */}
            <aside
              aria-label={t("aside.gradingItem")}
              className={cx(
                "hidden w-full shrink-0 flex-col gap-4 lg:sticky lg:top-(--grading-sticky) lg:max-h-[calc(100dvh-var(--grading-sticky)-1rem)] lg:w-75",
                // Nothing to list, nothing to draw: an empty column would
                // push the detail's empty state off centre for nothing.
                listed && "lg:flex",
              )}
            >
              <StepList
                className="flex min-h-0 flex-1"
                order={order}
                queue={queue}
                entries={entries}
                items={itemsById}
                selected={selected}
                onSelect={setSelected}
              />
            </aside>

            <section
              ref={answersRef}
              className="flex w-full min-w-0 flex-1 flex-col gap-3"
              aria-label={t("grading.title")}
            >
              <StepAnswers
                order={order}
                queue={queue}
                entries={entries}
                items={itemsById}
                selected={selected}
                current={current}
                onSelect={setSelected}
                onMove={move}
                explanations={explanations}
                validating={validate.isPending}
                onValidate={validate.mutate}
                onOverride={setOverrideKey}
                onRegrade={(item) => setRegradeId(item.id)}
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
