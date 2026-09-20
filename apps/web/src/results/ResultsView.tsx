import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, ClipboardCheck, Send, Users } from "lucide-react";
import { useState } from "react";

import type { ByQuestion, ReleaseResponse, ResultsView as ResultsPayload } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { gradingLinks } from "../grading";
import { useT } from "../i18n";
import { useToast } from "../notify";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import { useScreenCommands } from "../screenCommands";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  isoDateTime,
  Menu,
  PageHeader,
  QueryError,
  SectionHeading,
  Skeleton,
  Tabs,
} from "../ui";
import { ByQuestionView } from "./ByQuestionView";
import { ExportButton } from "./ExportButton";
import { GradeTable } from "./GradeTable";
import { Histogram } from "./Histogram";
import { StatsRow } from "./StatsRow";

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
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [tabParam, setTab] = useSearchParam("tab", "students");
  const tab: Tab = tabParam === "questions" ? "questions" : "students";
  const [releasing, setReleasing] = useState(false);

  const results = useQuery<ResultsPayload>({
    queryKey: ["results", evaluationId, "view"],
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/results`),
  });

  const byQuestion = useQuery<ByQuestion[]>({
    queryKey: ["results", evaluationId, "by-question"],
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
      void qc.invalidateQueries({ queryKey: ["results", evaluationId] });
      void qc.invalidateQueries({ queryKey: ["evaluation", evaluationId] });
      toast(t(on ? "results.release.done" : "results.unrelease.done"), "success");
    },
    onError: (error) => toast(apiErrorMessage(error, t("results.release.failed")), "error"),
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
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (results.isError || !view) {
    return (
      <QueryError
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
        eyebrow={view.title}
        title={t("results.title")}
        description={
          view.released && view.releasedAt
            ? t("results.released", { date: isoDateTime(view.releasedAt) })
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
          { value: "students", label: t("results.tab.students"), icon: Users, count: view.rows.length },
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
