import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";

import type { GradeRunList, GradeRunView } from "@quiz/contracts";

import { api } from "../api";
import { useT, type Dict } from "../i18n";
import { projectRunsKey } from "../queryKeys";
import { Badge, EmptyState, QueryError, RelativeTime, Skeleton, T } from "../ui";
import { Points } from "./parts";
import { shortSha } from "./projectPage";

/** A run's kind, and which slot it fills, in one word each. */
const KIND_KEY: Record<GradeRunView["kind"], keyof Dict> = { ci: "project.col.ci", review: "project.review" };
const SLOT_KEY = { current: "project.run.slot.current", frozen: "project.frozen", review: "project.review" } as const;
/** Why a run has no score (`parseStatus` other than `ok`). */
const PARSE_KEY: Record<Exclude<GradeRunView["parseStatus"], "ok">, keyof Dict> = {
  no_annotation: "project.run.parse.no_annotation",
  malformed: "project.run.parse.malformed",
  multiple: "project.flag.multiple",
  fallback: "project.run.parse.fallback",
};
/** GitHub's conclusions worded; an unknown one is shown as GitHub spelled it. */
const CONCLUSION_KEY: Partial<Record<string, keyof Dict>> = {
  success: "project.run.conclusion.success",
  failure: "project.run.conclusion.failure",
  cancelled: "project.run.conclusion.cancelled",
  skipped: "project.run.conclusion.skipped",
  timed_out: "project.run.conclusion.timed_out",
};

/** Which of the three slots a run fills, by its id (null: none). */
function slotOf(run: GradeRunView, list: GradeRunList): keyof typeof SLOT_KEY | null {
  if (run.id === list.reviewGradeRunId) return "review";
  if (run.id === list.frozenGradeRunId) return "frozen";
  if (run.id === list.currentGradeRunId) return "current";
  return null;
}

/**
 * The history of a repository's runs (`GET …/repos/:rid/runs`, F-PROJ-13),
 * the newest first, in the repository's sheet: when, what ran on which
 * commit and how it ended, its score and tests, why it has no score, and
 * its marks — the slot it fills, after the deadline, to verify.
 */
export function RunHistory({ projectId, repoId }: { projectId: string; repoId: string }) {
  const t = useT();
  const runs = useQuery<GradeRunList>({
    queryKey: projectRunsKey(projectId, repoId),
    queryFn: () => api(`/app/api/projects/${projectId}/repos/${repoId}/runs`),
  });
  if (runs.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    );
  }
  if (runs.isError) {
    return (
      <QueryError
        title={t("project.runs.failed")}
        error={runs.error}
        onRetry={() => void runs.refetch()}
        retrying={runs.isFetching}
      />
    );
  }
  const list = runs.data!;
  if (list.runs.length === 0) {
    return (
      <EmptyState icon={History} title={t("project.runs.empty")} className="py-8">
        {t("project.runs.emptyBody")}
      </EmptyState>
    );
  }
  return (
    <div className={`${T.container} -mx-6 overflow-x-auto`}>
      <table className={T.table}>
        <thead className={T.head}>
          <tr>
            <th scope="col" className={`${T.th} pl-6`}>
              {t("project.col.when")}
            </th>
            <th scope="col" className={T.th}>
              {t("project.col.run")}
            </th>
            <th scope="col" className={`${T.th} text-right`}>
              {t("project.col.result")}
            </th>
            <th scope="col" className={`${T.th} pr-6`}>
              {t("project.col.state")}
            </th>
          </tr>
        </thead>
        <tbody>
          {list.runs.map((run) => {
            const slot = slotOf(run, list);
            const conclusion = CONCLUSION_KEY[run.conclusion];
            return (
              <tr key={run.id} className={T.row}>
                <td className={`${T.td} pl-6 text-fg-muted`}>
                  <RelativeTime iso={run.completedAt} />
                </td>
                <td className={T.td}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Badge tone="zinc">{t(KIND_KEY[run.kind])}</Badge>
                    <span className="font-mono text-xs text-fg-muted">
                      {run.headBranch}@{shortSha(run.headSha)}
                    </span>
                    <span className="text-xs text-fg-faint">{conclusion ? t(conclusion) : run.conclusion}</span>
                  </span>
                </td>
                <td className={`${T.td} text-right`}>
                  <span className="flex flex-col items-end">
                    <Points points={run.points} max={run.max} />
                    {run.testsTotal !== null ? (
                      <span className="text-xs text-fg-faint">
                        {t("project.run.tests", { passed: run.testsPassed ?? 0, total: run.testsTotal })}
                      </span>
                    ) : null}
                    {run.parseStatus !== "ok" ? (
                      <span className="text-xs text-fg-muted">{t(PARSE_KEY[run.parseStatus])}</span>
                    ) : null}
                    {run.clamped ? <Badge tone="amber">{t("project.run.clamped")}</Badge> : null}
                    {run.parseDetail ? (
                      <span className="max-w-60 truncate font-mono text-xs text-fg-faint" title={run.parseDetail}>
                        {run.parseDetail}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className={`${T.td} pr-6`}>
                  <span className="flex flex-wrap gap-1">
                    {slot ? <Badge tone="accent">{t(SLOT_KEY[slot])}</Badge> : null}
                    {run.afterDeadline ? <Badge tone="zinc">{t("project.run.afterDeadline")}</Badge> : null}
                    {run.toVerify ? <Badge tone="amber">{t("project.flag.toVerify")}</Badge> : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
