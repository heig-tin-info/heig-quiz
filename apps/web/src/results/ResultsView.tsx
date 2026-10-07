import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  ClipboardCheck,
  Presentation,
  Send,
  Undo2,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  ByQuestion,
  ResultRow,
  EvaluationDetail,
  ReleaseResponse,
  ResultsView as ResultsPayload,
} from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { hasCorrection } from "../evaluation/common";
import { gradingLinks } from "../grading";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import { Trail, useEvaluationCrumbs } from "../Trail";
import { useScreenCommands } from "../screenCommands";
import {
  Actions,
  Alert,
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  QueryError,
  RelativeTime,
  Skeleton,
  Tabs,
} from "../ui";
import { ByQuestionView, isNotOver } from "./ByQuestionView";
import { ExportButton } from "./ExportButton";
import { GradeTable, useGradeSort } from "./GradeTable";
import { Histogram } from "./Histogram";
import { StudentCopy } from "./StudentCopy";
import { StudentStats } from "./StudentStats";
import { Summary } from "./Summary";
import { useIsCourseOwner } from "../course/parts";
import { evaluationKey, resultsByQuestionKey, resultsKey, resultsViewKey } from "../queryKeys";

type Tab = "students" | "questions";

const NO_ROWS: ResultRow[] = [];

/**
 * The results of one evaluation (F-RES-01 to F-RES-03).
 *
 * The ONE primary action is publishing: everything else on the page is a
 * reading. The export is a secondary link, withdrawing a publication lives
 * in the overflow menu as a destructive item, and both the publication and
 * its withdrawal name the evaluation in their confirmation — a teacher with
 * four tabs open must be told WHICH class is about to see its grades.
 */
export function ResultsView({
  evaluationId,
  navigate,
}: {
  evaluationId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [tabParam, setTab] = useSearchParam("tab", "students");
  const tab: Tab = tabParam === "questions" ? "questions" : "students";
  const [releasing, setReleasing] = useState(false);
  /** The student's copy open over the table, by attempt, in the URL. */
  const [copyId, setCopyId] = useSearchParam("copy", "");

  const results = useQuery<ResultsPayload>({
    queryKey: resultsViewKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/results`),
  });

  const byQuestion = useQuery<ByQuestion[]>({
    queryKey: resultsByQuestionKey(evaluationId),
    enabled: tab === "questions",
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/results/by-question`),
  });

  const release = useMutation<ReleaseResponse, unknown, boolean>({
    mutationFn: (on) =>
      api(`/app/api/evaluations/${evaluationId}/${on ? "release" : "unrelease"}`, {
        method: "POST",
        body: JSON.stringify(on ? { confirm: true } : {}),
      }),
    onSuccess: (_data, on) => {
      void qc.invalidateQueries({ queryKey: resultsKey(evaluationId) });
      void qc.invalidateQueries({ queryKey: evaluationKey(evaluationId) });
      toast(t(on ? "results.release.done" : "results.unrelease.done"), "success");
    },
    onError: toastError("results.release.failed"),
    onSettled: () => setReleasing(false),
  });

  const view = results.data;
  const title = view?.title ?? "";

  const table = useGradeSort(view?.rows ?? NO_ROWS);
  /** The open copy, and ↑ / ↓ through the table's attempts in the order on screen. */
  const copy = useMemo(() => {
    const order = table.sorted.flatMap((r) => (r.attemptId === null ? [] : [{ ...r, attemptId: r.attemptId }]));
    const at = order.findIndex((r) => r.attemptId === copyId);
    if (at < 0) return null;
    const step = (delta: number) => {
      const next = order[at + delta];
      return next === undefined ? undefined : () => setCopyId(next.attemptId);
    };
    return { row: order[at]!, prev: step(-1), next: step(1) };
  }, [table.sorted, copyId, setCopyId]);

  const ask = async (on: boolean) => {
    const ok = await confirm({
      title: t(on ? "results.release.confirm.title" : "results.unrelease.confirm.title", { title }),
      message: t(on ? "results.release.confirm.body" : "results.unrelease.confirm.body"),
      confirmLabel: t(on ? "results.release.confirm.ok" : "results.unrelease.confirm.ok"),
      cancelLabel: t("common.cancel"),
      danger: !on,
    });
    if (!ok) return;
    setReleasing(true);
    release.mutate(on);
  };

  /**
   * The evaluation, for one thing only: which classroom to go back to. It is
   * an aid, never an error state — the results render perfectly well without
   * it, and the eyebrow simply stays a label until it arrives.
   */
  const evaluation = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}`),
    retry: false,
  });
  const classroomId = evaluation.data?.evaluation.classroomId ?? null;
  const crumbs = useEvaluationCrumbs(classroomId, evaluationId, evaluation.data?.evaluation.title);
  // The correction exists once the evaluation is over, or once an exercise's
  // correction is published (ADR-050): `hasCorrection` is the server's own
  // `not_over` rule (`isDebriefOpen`, @quiz/domain), and the evaluation is
  // already here — no by-question fetch just to decide a button.
  const presentable =
    evaluation.data !== undefined && hasCorrection(evaluation.data.evaluation) && (view?.items.length ?? 0) > 0;

  // Releasing and withdrawing are a course owner's (ADR-068): an assistant
  // reads and grades, and is offered neither. Not known yet is not an owner.
  const isOwner = useIsCourseOwner(evaluation.data?.courseId);

  const links = gradingLinks(evaluationId);
  useScreenCommands([
    {
      id: "results:grading",
      label: t("palette.openGrading"),
      icon: ClipboardCheck,
      group: "navigate",
      run: () => navigate(links.grading),
    },
    ...(isOwner
      ? [
          {
            id: "results:release",
            label: t(view?.released ? "results.release.again" : "results.release"),
            icon: Send,
            group: "action" as const,
            run: () => void ask(true),
          },
        ]
      : []),
  ]);

  if (results.isLoading) {
    return <PageSkeleton body="summary-and-block" />;
  }
  if (results.isError || !view) {
    return (
      <PageError
        title={t("results.loadFailed")}
        error={results.error}
        onRetry={() => void results.refetch()}
        retrying={results.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Trail navigate={navigate} items={[...crumbs, { label: t("results.title") }]} />
        }
        title={t("results.title")}
        help="results"
        description={
          view.released && view.releasedAt
            ? (
              <>
                {t("results.released")} <RelativeTime iso={view.releasedAt} />
              </>
            )
            : t("results.notReleased")
        }
        actions={
          <>
            <ExportButton evaluationId={evaluationId} />
            <Button variant="secondary" onClick={() => navigate(links.grading)}>
              <ClipboardCheck /> {t("results.grading")}
            </Button>
            {presentable ? (
              // The Questions tab on a beamer, for the correction in class.
              <Button variant="secondary" onClick={() => navigate({ view: "correction", evaluationId })}>
                <Presentation /> {t("results.present")}
              </Button>
            ) : null}
            {isOwner ? (
              <Button onClick={() => void ask(true)} loading={releasing}>
                <Send /> {t(view.released ? "results.release.again" : "results.release")}
              </Button>
            ) : null}
          </>
        }
        menu={
          view.released && isOwner ? (
            // One action, so one icon button: `Actions` is what turns a
            // single-item overflow menu into the thing it always was.
            <Actions
              label={t("common.actions")}
              items={[
                {
                  label: t("results.unrelease"),
                  icon: Undo2,
                  danger: true,
                  onSelect: () => void ask(false),
                },
              ]}
            />
          ) : null
        }
      />

      {view.modifiedAfterRelease ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("results.modified")}>
          {t("results.modifiedBody")}
        </Alert>
      ) : null}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        label={t("results.title")}
        items={[
          {
            value: "students",
            label: t("results.tab.students"),
            icon: Users,
            // The CLASS: a teacher's own test walk is a row of the table and
            // not one of its students (ADR-018).
            count: view.rows.filter((r) => !r.staff).length,
          },
          {
            value: "questions",
            label: t("results.tab.questions"),
            icon: BarChart3,
            count: view.items.length,
          },
        ]}
      />

      {tab === "students" ? (
        view.rows.length === 0 ? (
          <Card>
            <EmptyState icon={Users} title={t("results.empty.title")}>
              {t("results.empty.body")}
            </EmptyState>
          </Card>
        ) : (
          <div className="space-y-6">
            <Summary
              title={t("results.histogram.title")}
              chart={<Histogram buckets={view.stats.histogram} className="h-40 lg:h-56" />}
              stats={<StudentStats stats={view.stats} rows={view.rows} />}
            />
            <GradeTable table={table} openId={copy ? copyId : null} onOpen={setCopyId} />
            {copy ? (
              <StudentCopy
                evaluationId={evaluationId}
                row={copy.row}
                items={view.items}
                onClose={() => setCopyId("")}
                onMove={{ prev: copy.prev, next: copy.next }}
                navigate={navigate}
              />
            ) : null}
          </div>
        )
      ) : byQuestion.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : byQuestion.isError ? (
        <QueryError
          title={t("results.loadFailed")}
          // Before the close the server refuses (ADR-033): say so in the
          // reader's language, never in the server's.
          error={isNotOver(byQuestion.error) ? null : byQuestion.error}
          onRetry={() => void byQuestion.refetch()}
          retrying={byQuestion.isFetching}
          fallback={t(isNotOver(byQuestion.error) ? "results.byQuestion.notOver" : "error.server")}
        />
      ) : (
        <ByQuestionView questions={byQuestion.data ?? []} />
      )}
    </div>
  );
}
