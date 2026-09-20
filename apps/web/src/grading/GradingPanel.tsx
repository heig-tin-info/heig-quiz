import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, CheckCheck, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ByQuestion,
  EvaluationDetail,
  GradingConfidence,
  GradingEntry,
  GradingQueue,
  GradingQueueItem,
  GradingSource,
  GradingState,
} from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import type { Route } from "../router";
import { useScreenCommands } from "../screenCommands";
import { typeLabel } from "../questionTypes";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  QueryError,
  Segmented,
  Select,
  Switch,
} from "../ui";
import { BatchBar, type BatchScope } from "./BatchBar";
import { ListSkeleton } from "./ListSkeleton";
import { EntryDetail } from "./EntryDetail";
import { EntryList, entryKey } from "./EntryList";
import { GradingHeader } from "./GradingHeader";
import { gradingLinks } from "./index";
import { RegradeSheet } from "./RegradeSheet";
import { OverrideSheet } from "./OverrideSheet";
import { useGradingProgress } from "./progress";

/**
 * The grading panel (F-GRADE-03 to 06, mockup `04-correction.html`).
 *
 * The whole screen is one traversal: a path of steps at the top, the answers
 * of the current step below, one of them open. The traversal runs BY
 * QUESTION by default — grading the same question across thirty students is
 * the only way to grade it consistently — and by student on demand.
 *
 * Names are hidden until the teacher asks (F-GRADE-03, decision D20), and
 * the server is what hides them: `?anonymous=0` is a different request, not
 * a client-side unmasking of something already downloaded.
 *
 * One accent action: the batch validation. Everything else — validate one,
 * adjust, re-grade, run the pass — is secondary or lives in the detail.
 */

type StateFilter = "all" | GradingState;

const ANY = "any";

export function GradingPanel({
  evaluationId,
  navigate,
}: {
  evaluationId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();

  const [order, setOrder] = useState<"question" | "student">("question");
  const [showNames, setShowNames] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [source, setSource] = useState<GradingSource | typeof ANY>(ANY);
  const [confidence, setConfidence] = useState<GradingConfidence | typeof ANY>(ANY);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [regrading, setRegrading] = useState(false);

  // --- The evaluation and its items -------------------------------------

  const evaluation = useQuery<EvaluationDetail>({
    queryKey: ["evaluation", evaluationId],
    queryFn: () => api(`/app/api/evaluations/${evaluationId}`),
  });

  const items = useMemo<GradingQueueItem[]>(
    () =>
      (evaluation.data?.items ?? []).map((i) => ({
        id: i.id,
        position: i.position,
        internalName: i.internalName,
        type: i.type,
        points: i.points,
      })),
    [evaluation.data],
  );
  const anonymous = showNames ? "0" : "1";

  /**
   * The students, read from the queue of the FIRST question: one entry per
   * attempt, already carrying the label the server decided to show. It saves
   * an endpoint, and the pseudonyms cannot drift from the ones the list
   * below prints, because they come from the same place.
   */
  const roster = useQuery<GradingQueue>({
    queryKey: ["grading", evaluationId, "roster", items[0]?.id ?? "", anonymous],
    enabled: order === "student" && items.length > 0,
    queryFn: () =>
      api(
        `/app/api/evaluations/${evaluationId}/grading?by=question&itemId=${items[0]!.id}&anonymous=${anonymous}`,
      ),
  });
  const students = useMemo(
    () => (roster.data?.entries ?? []).map((e) => ({ key: e.attemptId, label: e.label })),
    [roster.data],
  );

  const steps = useMemo(
    () =>
      order === "question"
        ? // `position` is 0-based on the wire; every screen of this app numbers
          // questions from 1, and the step counter above this list does too.
          items.map((i) => ({ key: i.id, label: `${i.position + 1}. ${i.internalName}` }))
        : students,
    [order, items, students],
  );
  const step = steps[Math.min(index, Math.max(0, steps.length - 1))];

  // --- The queue of the current step -------------------------------------

  const scopeParam =
    step === undefined
      ? null
      : order === "question"
        ? `by=question&itemId=${step.key}`
        : `by=student&attemptId=${step.key}`;

  const queue = useQuery<GradingQueue>({
    queryKey: ["grading", evaluationId, "queue", scopeParam, stateFilter, anonymous],
    enabled: scopeParam !== null,
    queryFn: () =>
      api(
        `/app/api/evaluations/${evaluationId}/grading?${scopeParam}&anonymous=${anonymous}` +
          (stateFilter === "all" ? "" : `&state=${stateFilter}`),
      ),
  });

  const progress = useGradingProgress(evaluationId);

  /**
   * The explanations, taken from the per-question results view. It is an
   * aid, not the screen: a failure here shows nothing extra and never an
   * error state, so a grading session is not interrupted by a secondary read.
   */
  const byQuestion = useQuery<ByQuestion[]>({
    queryKey: ["results", evaluationId, "by-question"],
    retry: false,
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/results/by-question`),
  });
  const explanations = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of byQuestion.data ?? []) {
      if (q.explanation) map.set(q.item.id, q.explanation);
    }
    return map;
  }, [byQuestion.data]);

  // --- Filtering and ordering -------------------------------------------

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const matches = useCallback(
    (e: GradingEntry) =>
      (source === ANY || e.grading?.source === source) &&
      (confidence === ANY || e.grading?.confidence === confidence),
    [source, confidence],
  );

  /** Proposals first: they are the only reason the teacher opened this page. */
  const entries = useMemo(() => {
    const kept = (queue.data?.entries ?? []).filter(matches);
    return kept
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const rank = (x: GradingEntry) => (x.grading?.state === "proposed" ? 0 : 1);
        return rank(a.e) - rank(b.e) || a.i - b.i;
      })
      .map((x) => x.e);
  }, [queue.data, matches]);

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

  const selectedEntry = entries.find((e) => entryKey(e) === selected) ?? null;
  const overrideEntry = entries.find((e) => entryKey(e) === overrideKey) ?? null;

  // --- Mutations ---------------------------------------------------------

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["grading", evaluationId] });
    void qc.invalidateQueries({ queryKey: ["results", evaluationId] });
  };

  const validate = useMutation({
    mutationFn: (gradingId: string) =>
      api(`/app/api/gradings/${gradingId}/validate`, { method: "POST", body: "{}" }),
    onSuccess: invalidate,
    onError: (error) => toast(apiErrorMessage(error, t("grading.validate.failed")), "error"),
  });

  const run = useMutation({
    mutationFn: () =>
      api(`/app/api/evaluations/${evaluationId}/grading/run`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      invalidate();
      toast(t("grading.run.started"), "progress");
    },
    onError: (error) => toast(apiErrorMessage(error, t("grading.run.failed")), "error"),
  });

  // --- Keyboard (docs/08 §8.5) ------------------------------------------

  const move = useCallback(
    (delta: number) => {
      if (entries.length === 0) return;
      const at = entries.findIndex((e) => entryKey(e) === selected);
      const next = entries[Math.min(entries.length - 1, Math.max(0, at + delta))];
      if (next) setSelected(entryKey(next));
    },
    [entries, selected],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      // A sheet, a dialog or a field owns the keyboard while it is up: `v`
      // must type a v in the comment box, not validate behind the form.
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      const key = e.key.toLowerCase();
      if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
      } else if (key === "v") {
        e.preventDefault();
        const grading = selectedEntry?.grading;
        if (grading && grading.state === "proposed") validate.mutate(grading.id);
        move(1);
      } else if (key === "o") {
        e.preventDefault();
        if (selected) setOverrideKey(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, selected, selectedEntry, validate]);

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
  const counts = queue.data?.counts ?? { total: 0, validated: 0, proposed: 0, missing: 0 };
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
            steps={steps}
            index={index}
            onPrev={() => setIndex((i) => (i - 1 + steps.length) % steps.length)}
            onNext={() => setIndex((i) => (i + 1) % steps.length)}
            prevLabel={order === "question" ? t("grading.prevItem") : t("grading.prevStudent")}
            nextLabel={order === "question" ? t("grading.nextItem") : t("grading.nextStudent")}
            title={t(order === "question" ? "grading.item.position" : "grading.student.position", {
              n: index + 1,
              total: steps.length,
            })}
            counts={counts}
            progress={progress.data}
            onRun={() => run.mutate()}
            running={run.isPending}
            runPrimary={runPrimary}
          />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <Segmented
              name="grading-order"
              value={order}
              options={[
                { value: "question", label: t("grading.order.byQuestion") },
                { value: "student", label: t("grading.order.byStudent") },
              ]}
              onChange={(v) => {
                setOrder(v);
                setIndex(0);
              }}
            />
            <Segmented
              name="grading-state"
              value={stateFilter}
              options={[
                { value: "all", label: t("grading.filter.all") },
                { value: "proposed", label: t("grading.filter.proposed") },
                { value: "validated", label: t("grading.filter.validated") },
              ]}
              onChange={(v) => setStateFilter(v as StateFilter)}
            />
            <Select
              aria-label={t("grading.filter.source")}
              size="sm"
              width="w-36"
              value={source}
              onChange={(e) => setSource(e.target.value as GradingSource | typeof ANY)}
            >
              <option value={ANY}>{t("grading.filter.source")}</option>
              <option value="auto">{t("grading.source.auto")}</option>
              <option value="llm">{t("grading.source.llm")}</option>
              <option value="manual">{t("grading.source.manual")}</option>
            </Select>
            <Select
              aria-label={t("grading.filter.confidence")}
              size="sm"
              width="w-40"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value as GradingConfidence | typeof ANY)}
            >
              <option value={ANY}>{t("grading.filter.confidence")}</option>
              <option value="low">{t("grading.confidence.low")}</option>
              <option value="medium">{t("grading.confidence.medium")}</option>
              <option value="high">{t("grading.confidence.high")}</option>
            </Select>
            <span className="flex-1" />
            <span className="flex items-center gap-2 text-[13px] font-medium text-fg-muted">
              <Switch checked={showNames} onChange={setShowNames} label={t("grading.showNames")} />
              {t("grading.showNames")}
            </span>
          </div>
          {!showNames ? (
            <p className="-mt-3 text-xs text-fg-faint">{t("grading.anonymousNote")}</p>
          ) : null}

          {order === "question" && proposedCount > 0 ? (
            <BatchBar
              evaluationId={evaluationId}
              scope={scope}
              count={proposedCount}
              scoped={source !== ANY || confidence !== ANY}
              primary={!runPrimary}
            />
          ) : null}

          {/* `items-start` only from `lg`: on a phone the column stacks, and
              stretching is what keeps the two children at the page width —
              `items-start` there sizes them to their content and pushes the
              whole document sideways. */}
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
            <aside
              aria-label={t("aside.gradingItem")}
              className="w-full shrink-0 lg:sticky lg:top-6 lg:w-75"
            >
              <Card className="space-y-3 p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-faint">
                  {order === "question"
                    ? t("grading.order.byQuestion")
                    : t("grading.order.byStudent")}
                </p>
                <p className="text-base font-semibold tracking-tight">{step?.label}</p>
                {currentItem ? (
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="zinc">{typeLabel(t, currentItem.type)}</Badge>
                    <Badge tone="zinc">{t("grading.points", { n: currentItem.points })}</Badge>
                    <Badge tone="zinc">{t("grading.answers", { n: counts.total })}</Badge>
                  </div>
                ) : (
                  <Badge tone="zinc">{t("grading.answers", { n: counts.total })}</Badge>
                )}
                {currentItem ? (
                  <Button variant="ghost" size="sm" onClick={() => setRegrading(true)}>
                    <RefreshCcw /> {t("grading.regrade")}
                  </Button>
                ) : null}
              </Card>
            </aside>

            <section className="w-full min-w-0 flex-1 space-y-4" aria-label={t("grading.title")}>
              {queue.isLoading ? (
                <ListSkeleton />
              ) : queue.isError ? (
                <QueryError
                  title={t("grading.loadFailed")}
                  error={queue.error}
                  onRetry={() => void queue.refetch()}
                  retrying={queue.isFetching}
                  fallback={t("error.server")}
                />
              ) : entries.length === 0 ? (
                <Card>
                  <EmptyState icon={CheckCheck} title={t("grading.empty.title")}>
                    {t("grading.empty.body")}
                  </EmptyState>
                </Card>
              ) : (
                <EntryList
                  entries={entries}
                  items={itemsById}
                  selectedKey={selected}
                  onSelect={setSelected}
                  rowLabel={(entry, item) =>
                    order === "question"
                      ? entry.label
                      : item
                        ? `${item.position + 1}. ${item.internalName}`
                        : entry.label
                  }
                  renderDetail={(entry, item) => (
                    <EntryDetail
                      entry={entry}
                      item={item}
                      explanation={explanations.get(entry.itemId) ?? null}
                      validating={validate.isPending}
                      onValidate={() => {
                        if (entry.grading) validate.mutate(entry.grading.id);
                      }}
                      onOverride={() => setOverrideKey(entryKey(entry))}
                    />
                  )}
                />
              )}
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
