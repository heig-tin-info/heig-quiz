import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Lock, LockOpen } from "lucide-react";
import type { ReactNode } from "react";

import type {
  GradeRunList,
  GradeRunView,
  ProjectDetail,
  ProjectRepoDeadline,
  ProjectRepoDeadlineState,
} from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { DateField } from "../evaluation/TimingStep";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { projectKey, projectRunsKey } from "../queryKeys";
import {
  Badge,
  Button,
  EmptyState,
  FieldError,
  fieldErrorProps,
  GithubIcon,
  isoDateTime,
  QueryError,
  RelativeTime,
  Sheet,
  Skeleton,
  T,
} from "../ui";
import { CiBadge, Score } from "./ProjectRepos";
import { actionable, refusalCode, refusalKey, repoFlags, repoHref, shortSha } from "./projectPage";

const OWN_DEADLINE_ID = "project-repo-deadline";

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 px-6 py-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-fg-muted">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

/** One slot's score: points out of their maximum, or a dash. */
function SlotScore({ score }: { score: { points: number | null; max: number | null } | null }) {
  if (!score || score.points === null) return <span className="text-fg-faint">—</span>;
  return (
    <span className="tabular-nums">
      {score.points}
      {score.max !== null ? `/${score.max}` : ""}
    </span>
  );
}

/** Which of the three slots a run fills, by its id (null: none). */
function slotOf(run: GradeRunView, list: GradeRunList): "current" | "frozen" | "review" | null {
  if (run.id === list.reviewGradeRunId) return "review";
  if (run.id === list.frozenGradeRunId) return "frozen";
  if (run.id === list.currentGradeRunId) return "current";
  return null;
}

/** The history of a repository's runs (`GET …/repos/:rid/runs`), the newest first, the slots marked. */
function RunHistory({ projectId, repoId }: { projectId: string; repoId: string }) {
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
            return (
              <tr key={run.id} className={T.row}>
                <td className={`${T.td} pl-6 text-fg-muted`}>
                  <RelativeTime iso={run.completedAt} />
                </td>
                <td className={T.td}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Badge tone="zinc">{t(`project.run.kind.${run.kind}`)}</Badge>
                    <span className="font-mono text-xs text-fg-muted">
                      {run.headBranch}@{shortSha(run.headSha)}
                    </span>
                    <span className="text-xs text-fg-faint">{run.conclusion}</span>
                  </span>
                </td>
                <td className={`${T.td} text-right`}>
                  <span className="flex flex-col items-end">
                    <SlotScore score={run} />
                    {run.testsTotal !== null ? (
                      <span className="text-xs text-fg-faint">
                        {t("project.run.tests", { passed: run.testsPassed ?? 0, total: run.testsTotal })}
                      </span>
                    ) : null}
                    {run.parseStatus !== "ok" ? (
                      <span className="text-xs text-fg-muted">{t(`project.run.parse.${run.parseStatus}`)}</span>
                    ) : null}
                    {run.parseDetail ? (
                      <span className="max-w-60 truncate font-mono text-xs text-fg-faint" title={run.parseDetail}>
                        {run.parseDetail}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className={`${T.td} pr-6`}>
                  <span className="flex flex-wrap gap-1">
                    {slot ? <Badge tone="accent">{t(`project.run.slot.${slot}`)}</Badge> : null}
                    {run.afterDeadline ? <Badge tone="zinc">{t("project.run.afterDeadline")}</Badge> : null}
                    {run.toVerify ? <Badge tone="amber">{t("project.run.toVerify")}</Badge> : null}
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

/**
 * One repository of the project page (F-PROJ-13), opened from its row: the
 * student and the repository, its scores slot by slot, its deadline and lock
 * — an own deadline set or taken back, a lock or an unlock by hand (F-PROJ-09,
 * M3-05a), each written at once — and the history of its runs, the three
 * slots marked. The row is read from the page's own data, so a write here
 * is seen on the table behind the sheet.
 *
 * The resend of an invitation, the re-enable of the protection and the
 * teacher's score come with M3-08b's routes (merge tasks M3-12b, M3-12c).
 */
export function RepoSheet({
  project,
  repoId,
  onClose,
}: {
  project: ProjectDetail;
  repoId: string;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const row = project.rows.find((r) => r.repo?.id === repoId);
  const repo = row?.repo ?? null;

  /** The repository's deadline state answered by its routes, laid over its row. */
  const settle = (state: ProjectRepoDeadlineState) => {
    qc.setQueryData<ProjectDetail>(projectKey(project.id), (p) =>
      p
        ? { ...p, rows: p.rows.map((r) => (r.repo?.id === state.id ? { ...r, repo: { ...r.repo, ...state } } : r)) }
        : p,
    );
    void qc.invalidateQueries({ queryKey: projectKey(project.id) });
  };
  const failed = (error: unknown) => {
    const key = refusalKey(error);
    toast(key ? t(key) : apiErrorMessage(error, t("error.save")), "error");
  };
  const base = `/app/api/projects/${project.id}/repos/${repoId}`;
  const deadline = useMutation({
    mutationFn: (body: ProjectRepoDeadline) =>
      api<ProjectRepoDeadlineState>(`${base}/deadline`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (state) => {
      settle(state);
      toast(t("project.repo.deadlineSaved"), "success");
    },
    onError: (error) => {
      if (refusalCode(error) !== "deadline_past") failed(error);
    },
  });
  const lock = useMutation({
    mutationFn: (on: boolean) => api<ProjectRepoDeadlineState>(`${base}/${on ? "lock" : "unlock"}`, { method: "POST" }),
    onSuccess: (state, on) => {
      settle(state);
      toast(t(on ? "project.repo.locked" : "project.repo.unlocked"), "success");
    },
    onError: failed,
  });

  if (!row || !repo) return null;
  const can = actionable(repo, project);
  const busy = deadline.isPending || lock.isPending;
  const deadlineRefused =
    deadline.isError && refusalCode(deadline.error) === "deadline_past" ? t("project.refusal.deadlinePast") : undefined;
  const flags = repoFlags(repo);

  return (
    <Sheet
      title={`${row.student.nom} ${row.student.prenom}`}
      subtitle={
        repo.fullName ? (
          <a
            href={repoHref(repo.fullName)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[13px] hover:underline"
          >
            <GithubIcon className="size-3.5" />
            {repo.fullName}
          </a>
        ) : undefined
      }
      onClose={onClose}
      width="lg"
      flush
    >
      <div className="divide-y divide-line">
        <Section title={t("project.sheet.repo")}>
          {flags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {flags.map((f) => (
                <Badge key={f.key} tone={f.tone}>
                  {t(f.key)}
                </Badge>
              ))}
            </div>
          ) : null}
          {repo.flags.malformed ? (
            <p className="font-mono text-xs text-fg-muted">{repo.flags.malformed}</p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Fact label={t("project.sheet.invitation")}>{t(`project.invitation.${repo.invitationStatus}`)}</Fact>
            <Fact label={t("project.col.commit")}>
              {repo.lastCommit ? (
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs">{shortSha(repo.lastCommit.sha)}</span>
                  {repo.lastCommit.at ? <RelativeTime iso={repo.lastCommit.at} className="text-xs text-fg-muted" /> : null}
                </span>
              ) : (
                <span className="text-fg-faint">—</span>
              )}
            </Fact>
            <Fact label={t("project.col.ci")}>
              <CiBadge status={repo.ciStatus} />
              {repo.live?.checksTotal != null ? (
                <span className="ml-2 text-xs text-fg-faint">
                  {t("project.repo.checks", { passed: repo.live.checksPassed ?? 0, total: repo.live.checksTotal })}
                </span>
              ) : null}
            </Fact>
          </dl>
        </Section>

        <Section title={t("project.sheet.scores")}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
            <Fact label={t("project.score.current")}>
              <SlotScore score={repo.scores.current} />
            </Fact>
            <Fact label={t("project.score.frozen")}>
              <SlotScore score={repo.scores.frozen} />
            </Fact>
            <Fact label={t("project.score.review")}>
              <SlotScore score={repo.scores.review} />
            </Fact>
            <Fact label={t("project.score.teacher")}>
              {repo.scores.teacher ? (
                <span className="tabular-nums" title={repo.scores.teacher.comment ?? undefined}>
                  {repo.scores.teacher.points}
                </span>
              ) : (
                <span className="text-fg-faint">—</span>
              )}
            </Fact>
            <Fact label={t("project.score.final")}>
              <Score score={repo.scores.final} />
            </Fact>
          </dl>
        </Section>

        <Section title={t("project.sheet.deadline")}>
          {!can ? <p className="text-[13px] text-fg-muted">{t("project.sheet.unavailable")}</p> : null}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Fact label={t("project.sheet.effective")}>
              <span className="tabular-nums">{isoDateTime(repo.effectiveDeadlineAt)}</span>
            </Fact>
            <Fact label={t("project.score.frozen")}>
              {repo.frozenAt ? (
                <span className="tabular-nums">{isoDateTime(repo.frozenAt)}</span>
              ) : repo.deadlineAppliedAt ? (
                t("project.frozen.provisional")
              ) : (
                <span className="text-fg-faint">—</span>
              )}
            </Fact>
            <Fact label={t("project.col.state")}>
              {repo.locked ? t("project.lock.locked") : t("project.lock.open")}
              {repo.staffLock !== null ? ` · ${t("project.lock.byStaff")}` : ""}
            </Fact>
          </dl>
          {repo.degraded ? <p className="text-[13px] text-fg-muted">{t("project.sheet.degraded")}</p> : null}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <DateField
                key={repo.deadlineAt ?? ""}
                id={OWN_DEADLINE_ID}
                label={t("project.sheet.ownDeadline")}
                disabled={!can || busy}
                value={repo.deadlineAt}
                onCommit={(deadlineAt, reset) => {
                  if (deadlineAt === null) {
                    reset();
                    return;
                  }
                  deadline.mutate({ deadlineAt }, { onError: reset });
                }}
                {...fieldErrorProps(OWN_DEADLINE_ID, deadlineRefused)}
              />
              <FieldError id={OWN_DEADLINE_ID}>{deadlineRefused}</FieldError>
            </div>
            {repo.deadlineAt !== null ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={!can}
                loading={deadline.isPending}
                onClick={() => deadline.mutate({ deadlineAt: null })}
              >
                {t("project.sheet.clearDeadline")}
              </Button>
            ) : null}
            <span className="grow" />
            <Button
              variant="secondary"
              size="sm"
              disabled={!can}
              loading={lock.isPending}
              onClick={() => lock.mutate(!repo.locked)}
            >
              {repo.locked ? <LockOpen /> : <Lock />} {t(repo.locked ? "project.sheet.unlock" : "project.sheet.lock")}
            </Button>
          </div>
          <p className="text-[13px] text-fg-muted">{t("project.sheet.ownDeadline.desc")}</p>
        </Section>

        <Section title={t("project.runs")}>
          <RunHistory projectId={project.id} repoId={repo.id} />
        </Section>
      </div>
    </Sheet>
  );
}
