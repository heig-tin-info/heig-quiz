import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, ClipboardCheck, Send, Users } from "lucide-react";
import { useState } from "react";

import type {
  ByQuestion,
  EvaluationDetail,
  ReleaseResponse,
  ResultsView as ResultsPayload,
} from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { gradingLinks } from "../grading";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import { useScreenCommands } from "../screenCommands";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Menu,
  PageError,
  PageHeader,
  PageSkeleton,
  ParentLink,
  QueryError,
  RelativeTime,
  SectionHeading,
  Skeleton,
  Tabs,
} from "../ui";
import { ByQuestionView } from "./ByQuestionView";
import { ExportButton } from "./ExportButton";
import { GradeTable } from "./GradeTable";
import { Histogram } from "./Histogram";
import { StatsRow } from "./StatsRow";
import { evaluationKey, resultsByQuestionKey, resultsKey, resultsViewKey } from "../queryKeys";

type Tab = "students" | "questions";

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

  const links = gradingLinks(evaluationId);
  useScreenCommands([
    {
      id: "results:grading",
      label: t("palette.openGrading"),
      icon: ClipboardCheck,
      group: "navigate",
      run: () => navigate(links.grading),
    },
    {
      id: "results:release",
      label: t(view?.released ? "results.release.again" : "results.release"),
      icon: Send,
      group: "action",
      run: () => void ask(true),
    },
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
          classroomId ? (
            <ParentLink
              onClick={() => navigate({ view: "classroom", id: classroomId })}
              tip={t("results.classroom")}
            >
              {view.title}
            </ParentLink>
          ) : (
            view.title
          )
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
            <Button onClick={() => void ask(true)} loading={releasing}>
              <Send /> {t(view.released ? "results.release.again" : "results.release")}
            </Button>
            {view.released ? (
              <Menu
                label={t("common.actions")}
                items={[
                  {
                    label: t("results.unrelease"),
                    danger: true,
                    onSelect: () => void ask(false),
                  },
                ]}
              />
            ) : null}
          </>
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
            <StatsRow stats={view.stats} rows={view.rows} />
            <Card className="space-y-4 p-5">
              <SectionHeading title={t("results.histogram.title")} />
              <Histogram buckets={view.stats.histogram} />
            </Card>
            <GradeTable rows={view.rows} />
            <p className="text-xs text-fg-faint">{t("results.export.hint")}</p>
          </div>
        )
      ) : byQuestion.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : byQuestion.isError ? (
        <QueryError
          title={t("results.loadFailed")}
          error={byQuestion.error}
          onRetry={() => void byQuestion.refetch()}
          retrying={byQuestion.isFetching}
          fallback={t("error.server")}
        />
      ) : (
        <ByQuestionView questions={byQuestion.data ?? []} />
      )}
    </div>
  );
}
