import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen, Mail, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import type {
  ProjectDetail,
  ProjectInvitationResent,
  ProjectRepoDeadline,
  ProjectRepoDeadlineState,
  ProjectRepoProtection,
  ProjectRepoScores,
  ProjectRepoView,
  ScoreOverride,
} from "@quiz/contracts";

import { api, refusedWith } from "../api";
import { DateField } from "../evaluation/TimingStep";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { projectKey, projectRunsKey } from "../queryKeys";
import { Badge, Button, Fact, FieldError, fieldErrorProps, isoDateTime, RelativeTime, Sheet } from "../ui";
import { CiBadge, RepoLink, SyncBadge } from "./parts";
import { actionable, refusalMessage, repoEntryOf, repoFlags, shortSha } from "./projectPage";
import { RunHistory } from "./RunHistory";
import { ScoreSection } from "./TeacherScoreForm";

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
 * student and the repository, its scores slot by slot with the teacher's own
 * (F-PROJ-14, M3-12b), the state of its final review, its deadline and lock
 * — an own deadline set or taken back, a lock or an unlock by hand (F-PROJ-09,
 * M3-05a) —, the resend of a pending invitation (F-PROJ-07) and the
 * re-enable of its protected files (F-PROJ-08), each written at once, and
 * the history of its runs. The row is read from the page's own data, so a
 * write here is seen on the table behind the sheet. The sheet's one primary
 * action is the score's Save. A group's repository (M3-16b) is titled by
 * its group and lists its current members, by name and GitHub login, and
 * whether the group still follows its set.
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
  const entry = repoEntryOf(project, repoId);
  const repo = entry?.repo ?? null;

  /** What a route answered of the repository, laid over its row; then the page is read again. */
  const settle = (patch: (repo: ProjectRepoView) => ProjectRepoView) => {
    qc.setQueryData<ProjectDetail>(projectKey(project.id), (p) =>
      p ? { ...p, rows: p.rows.map((r) => (r.repo?.id === repoId ? { ...r, repo: patch(r.repo) } : r)) } : p,
    );
    void qc.invalidateQueries({ queryKey: projectKey(project.id) });
  };
  const failed = (error: unknown) => toast(refusalMessage(error, t), "error");
  const base = `/app/api/projects/${project.id}/repos/${repoId}`;
  const deadline = useMutation({
    mutationFn: (body: ProjectRepoDeadline) =>
      api<ProjectRepoDeadlineState>(`${base}/deadline`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (state) => {
      settle((r) => ({ ...r, ...state }));
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
      settle((r) => ({ ...r, ...state }));
      toast(t(on ? "project.repo.locked" : "project.repo.unlocked"), "success");
    },
    onError: failed,
  });
  const score = useMutation({
    mutationFn: (body: ScoreOverride) =>
      api<ProjectRepoScores>(`${base}/score`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: ({ scores, released, changedAfterRelease }, body) => {
      settle((r) => ({ ...r, scores, released, flags: { ...r.flags, changedAfterRelease } }));
      toast(t(body.points === null ? "project.teacherScore.cleared" : "project.teacherScore.saved"), "success");
    },
    // The refusal is worded under the form (`FormError`), not toasted.
  });
  const resend = useMutation({
    mutationFn: () => api<ProjectInvitationResent>(`${base}/invite`, { method: "POST" }),
    onSuccess: ({ invitationStatus }) => {
      settle((r) => ({ ...r, invitationStatus }));
      toast(t(invitationStatus === "accepted" ? "project.invitation.alreadyAccepted" : "project.invitation.resent"), "success");
    },
    onError: failed,
  });
  const reenable = useMutation({
    mutationFn: () => api<ProjectRepoProtection>(`${base}/protection`, { method: "POST" }),
    onSuccess: () => {
      settle((r) => ({ ...r, flags: { ...r.flags, protectionSuspended: false } }));
      // The runs flagged meanwhile keep their mark: the history is read again with the page.
      void qc.invalidateQueries({ queryKey: projectRunsKey(project.id, repoId) });
      toast(t("project.protection.reenabled"), "success");
    },
    onError: failed,
  });

  if (!entry || !repo) return null;
  const can = actionable(repo, project);
  const busy = deadline.isPending || lock.isPending;
  const deadlineRefused = refusedWith(deadline.error, "deadline_past") ? t("project.refusal.deadlinePast") : undefined;
  const flags = repoFlags(repo);

  return (
    <Sheet
      title={entry.label}
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
          {repo.flags.protectionSuspended ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm" disabled={!can} loading={reenable.isPending} onClick={() => reenable.mutate()}>
                <ShieldCheck /> {t("project.protection.reenable")}
              </Button>
              <p className="text-[13px] text-fg-muted">{t("project.protection.reenable.desc")}</p>
            </div>
          ) : null}
          {entry.kind === "group" ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
              <Fact label={t("project.sheet.members")}>
                {entry.members.length === 0 ? (
                  <span className="text-fg-faint">{t("project.repo.noMember")}</span>
                ) : (
                  <ul className="space-y-0.5">
                    {entry.members.map((m) => (
                      <li key={m.enrollmentId ?? m.email}>
                        {m.nom} {m.prenom}
                        {m.githubLogin ? <span className="ml-2 font-mono text-xs text-fg-faint">{m.githubLogin}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Fact>
              <Fact label={t("project.groupSet")}>
                {t(entry.group.stopped ? "project.sheet.stopped" : "project.sheet.follows")}
              </Fact>
            </dl>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Fact label={t("project.sheet.invitation")}>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {t(`project.invitation.${repo.invitationStatus}`)}
                {repo.invitationStatus === "pending" ? (
                  <Button variant="secondary" size="sm" disabled={!can} loading={resend.isPending} onClick={() => resend.mutate()}>
                    <Mail /> {t("project.invitation.resend")}
                  </Button>
                ) : null}
              </span>
            </Fact>
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
            {/* The source's sync (F-PROJ-12, M3-07): its pull request or outcome, and when the last sync reached it. */}
            {repo.sync.outcome !== null || repo.sync.pr !== null ? (
              <Fact label={t("project.sheet.sync")}>
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  <SyncBadge repo={repo} />
                  {repo.sync.at ? <RelativeTime iso={repo.sync.at} className="text-xs text-fg-muted" /> : null}
                </span>
              </Fact>
            ) : null}
          </dl>
        </Section>

        <Section title={t("project.sheet.scores")}>
          <ScoreSection project={project} repo={repo} score={score} />
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
