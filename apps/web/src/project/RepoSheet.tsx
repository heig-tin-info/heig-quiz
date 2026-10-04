import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen } from "lucide-react";
import type { ReactNode } from "react";

import type { ProjectDetail, ProjectRepoDeadline, ProjectRepoDeadlineState } from "@quiz/contracts";

import { api, refusedWith } from "../api";
import { DateField } from "../evaluation/TimingStep";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { projectKey } from "../queryKeys";
import { Badge, Button, Fact, FieldError, fieldErrorProps, isoDateTime, RelativeTime, Sheet } from "../ui";
import { CiBadge, Points, RepoLink, Score } from "./parts";
import { actionable, refusalMessage, repoFlags, shortSha } from "./projectPage";
import { RunHistory } from "./RunHistory";

const OWN_DEADLINE_ID = "project-repo-deadline";

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 px-6 py-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * One repository of the project page (F-PROJ-13), opened from its row: the
 * student and the repository, its scores slot by slot, its deadline and lock
 * — an own deadline set or taken back, a lock or an unlock by hand (F-PROJ-09,
 * M3-05a), each written at once — and the history of its runs. The row is
 * read from the page's own data, so a write here is seen on the table behind
 * the sheet.
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
  const failed = (error: unknown) => toast(refusalMessage(error, t), "error");
  const base = `/app/api/projects/${project.id}/repos/${repoId}`;
  const deadline = useMutation({
    mutationFn: (body: ProjectRepoDeadline) =>
      api<ProjectRepoDeadlineState>(`${base}/deadline`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (state) => {
      settle(state);
      toast(t("project.repo.deadlineSaved"), "success");
    },
    onError: (error) => {
      // A past date is said under the field, not toasted.
      if (!refusedWith(error, "deadline_past")) failed(error);
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
  const deadlineRefused = refusedWith(deadline.error, "deadline_past") ? t("project.refusal.deadlinePast") : undefined;
  const flags = repoFlags(repo);

  return (
    <Sheet
      title={`${row.student.nom} ${row.student.prenom}`}
      subtitle={repo.fullName ? <RepoLink fullName={repo.fullName} full icon /> : undefined}
      onClose={onClose}
      width="lg"
      flush
    >
      <div className="divide-y divide-line">
        <Section title={t("project.col.repo")}>
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
              <Points points={repo.scores.current?.points ?? null} max={repo.scores.current?.max ?? null} />
            </Fact>
            <Fact label={t("project.score.frozen")}>
              <Points points={repo.scores.frozen?.points ?? null} max={repo.scores.frozen?.max ?? null} />
            </Fact>
            <Fact label={t("project.reviewLabel")}>
              <Points points={repo.scores.review?.points ?? null} max={repo.scores.review?.max ?? null} />
            </Fact>
            <Fact label={t("project.score.teacher")}>
              <span title={repo.scores.teacher?.comment ?? undefined}>
                <Points points={repo.scores.teacher?.points ?? null} max={null} />
              </span>
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
