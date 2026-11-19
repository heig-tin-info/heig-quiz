import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardCheck, FolderGit2, History, Lock, PenLine, ShieldCheck, Snowflake } from "lucide-react";

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
import { projectGraded } from "@quiz/domain";

import { api, isNotFound, refusedWith } from "../api";
import { useT, type Dict } from "../i18n";
import { useToast } from "../notify";
import { projectKey, projectRunsKey } from "../queryKeys";
import { useSearchParam, type Navigate } from "../router";
import { Trail, useClassroomCrumbs, type Crumb } from "../Trail";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  IconButton,
  isoDateTime,
  Menu,
  Modal,
  PageError,
  PageHeader,
  PageSkeleton,
  QueryError,
  RelativeTime,
  RepoLink,
  SectionHeading,
  Stat,
  type MenuItem,
  type Tone,
} from "../ui";
import { OpenInWorkspaceButton, useReviewAction } from "./OpenInWorkspace";
import { CiBadge, CollectionBadge, Points, SCORE_SOURCE_KEY, SyncBadge } from "./parts";
import {
  actionable,
  entryMembers,
  entryOfRow,
  isStaffTest,
  joinedCount,
  projectRefetchInterval,
  refusalMessage,
  repoFilterOf,
  repoFlags,
  repoPrimary,
  repoSteps,
  reviewTag,
  shortSha,
  type RepoEntry,
  type RepoFilter,
} from "./projectPage";
import { RepoActivity, RepoMembers } from "./RepoMembers";
import { RepoRail } from "./RepoRail";
import { RunHistory } from "./RunHistory";
import { TeacherScoreForm } from "./TeacherScoreForm";

/** The writes of a repository's page, each laid over its row of the project's page, which is then read again. */
function useRepoWrites(project: ProjectDetail, entry: RepoEntry | undefined, onScored: () => void) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const repoId = entry?.repo?.id ?? "";
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
    mutationFn: (body: ScoreOverride) => api<ProjectRepoScores>(`${base}/score`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: ({ scores, released, changedAfterRelease }, body) => {
      settle((r) => ({ ...r, scores, released, flags: { ...r.flags, changedAfterRelease } }));
      toast(t(body.points === null ? "project.teacherScore.cleared" : "project.teacherScore.saved"), "success");
      onScored();
    },
    // The refusal is worded under the form (`FormError`), not toasted.
  });
  const resend = useMutation({
    mutationFn: () => api<ProjectInvitationResent>(`${base}/invite`, { method: "POST" }),
    onSuccess: ({ invitationStatus }) => {
      // A group's row is not written by a resend: the page's re-read says it.
      settle((r) => (entry?.kind === "group" ? r : { ...r, invitationStatus }));
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
  return { deadline, lock, score, resend, reenable };
}

export type RepoWrites = ReturnType<typeof useRepoWrites>;

/** The state of a row's repository, as the header's one badge (ADR-104's grammar: green open, a fact zinc). */
function stateBadge(repo: ProjectRepoView | null): { key: keyof Dict; tone: Tone; icon?: typeof Lock } {
  if (repo === null) return { key: "project.repo.notAccepted", tone: "zinc" };
  if (repo.provisionStatus === "pending") return { key: "project.repo.provisioning", tone: "zinc" };
  if (repo.provisionStatus === "error") return { key: "project.repo.provisionFailed", tone: "red" };
  if (repo.frozenAt !== null) return { key: "project.frozen", tone: "zinc", icon: Snowflake };
  if (repo.deadlineAppliedAt !== null) return { key: "project.frozen.provisional", tone: "zinc", icon: Snowflake };
  if (repo.locked) return { key: "project.lock.locked", tone: "zinc", icon: Lock };
  return { key: "project.lock.open", tone: "green" };
}

/** What the row says of its repository besides its state: the review, the collection, the sync and the flags. */
function RepoTags({ repo }: { repo: ProjectRepoView }) {
  const t = useT();
  const review = reviewTag(repo);
  const flags = repoFlags(repo);
  if (!review && flags.length === 0 && repo.collection === null && repo.sync.outcome === null && repo.sync.pr === null) return null;
  return (
    <span className="mt-2 flex flex-wrap items-center gap-1" data-testid="repo-tags">
      {review ? <Badge tone={review.tone}>{t(review.key)}</Badge> : null}
      <CollectionBadge repo={repo} />
      <SyncBadge repo={repo} />
      {flags.map((f) => (
        <Badge key={f.key} tone={f.tone}>
          {t(f.key)}
        </Badge>
      ))}
    </span>
  );
}

/** ‹ n of N ›: the previous and next rows of the Repositories tab (ADR-137). */
function RepoStepper({ project, entry, filter, navigate }: { project: ProjectDetail; entry: RepoEntry; filter: RepoFilter | null; navigate: Navigate }) {
  const t = useT();
  const steps = isStaffTest(entry) ? null : repoSteps(project, entry, filter);
  if (!steps || steps.total < 2) return null;
  const go = (rowId: string | null) =>
    rowId ? () => navigate({ view: "projectRepo", id: project.id, rowId, ...(filter ? { filter } : {}) }, { replace: true }) : undefined;
  return (
    <span role="group" aria-label={t("project.repos")} className="mr-1 inline-flex items-center gap-1 text-[13px] text-fg-muted">
      <IconButton label={t("project.grading.prevRepo")} disabled={steps.prev === null} onClick={go(steps.prev)}>
        <ChevronLeft />
      </IconButton>
      <span className="px-1 tabular-nums" data-testid="repo-position">
        {t("project.grading.position", { n: steps.n, total: steps.total })}
      </span>
      <IconButton label={t("project.grading.nextRepo")} disabled={steps.next === null} onClick={go(steps.next)}>
        <ChevronRight />
      </IconButton>
    </span>
  );
}

/**
 * The four figures of a repository (ADR-137), from the row the page holds:
 * its commits, its last commit, its CI and — graded — its final score, else
 * how many of its readers joined it on GitHub. A figure the row lacks is a
 * dash.
 */
function RepoStats({ project, entry, repo }: { project: ProjectDetail; entry: RepoEntry; repo: ProjectRepoView }) {
  const t = useT();
  const unattributed = entry.kind === "group" ? repo.unattributed.n : 0;
  const final = repo.scores.final;
  const joined = joinedCount(entryMembers(entry));
  return (
    <section aria-label={t("project.repoPage.figures")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label={t("project.repoPage.commits")}
        value={repo.commits}
        hint={unattributed > 0 ? (unattributed === 1 ? t("project.repo.unattributed.one") : t("project.repo.unattributed", { n: unattributed })) : undefined}
      />
      <Stat
        label={t("project.col.commit")}
        value={repo.lastCommit ? <span className="font-mono text-[20px] font-semibold">{shortSha(repo.lastCommit.sha)}</span> : "—"}
        hint={repo.lastCommit?.at ? <RelativeTime iso={repo.lastCommit.at} /> : undefined}
      />
      <Stat
        label={t("project.col.ci")}
        value={repo.live?.checksTotal != null ? t("project.repo.checks", { passed: repo.live.checksPassed ?? 0, total: repo.live.checksTotal }) : "—"}
        hint={repo.ciStatus === "none" ? undefined : <CiBadge status={repo.ciStatus} />}
      />
      {projectGraded(project.gradingMode) ? (
        <Stat
          label={t("project.col.score")}
          value={<Points points={final?.points ?? null} max={final?.max ?? null} />}
          hint={final ? t(SCORE_SOURCE_KEY[final.source]) : undefined}
        />
      ) : (
        <Stat label={t("project.repoPage.joined")} value={joined.total > 0 ? `${joined.n}/${joined.total}` : "—"} />
      )}
    </section>
  );
}

/**
 * One repository of a project, the staff's page (ADR-137, amending
 * F-PROJ-13), `/projects/:id/repos/:rowId`: what the row of the
 * Repositories tab opens, in place of the former sheet. It reads the
 * project's own page (`projectKey`, cached, refetched as the page is, never
 * waiting for GitHub) and finds its row there — a repository, or a row not
 * accepted yet, which shows its members and nothing of GitHub.
 *
 * The header: the trail, the row's name with its state and "x/y joined",
 * its repository and deadline, ‹ n of N › over the tab's rows (its filter
 * kept, the staff's test repository never a step), *Open in workspace*
 * (secondary, ADR-129 §11) and the ONE primary, by state (`repoPrimary`):
 * none during the project; once frozen for good, Grade (the grading screen
 * on this repository) under criteria, the teacher's score (its dialog)
 * under the CI's. Re-enabling the protection is the overflow menu's.
 *
 * Then four figures, and two columns — a rail under the main one below
 * `lg`: the members with their access, their commits and Resend, the
 * unattributed commits; the weekly commits as a heatmap; the runs. The
 * rail: the deadline and the lock, the scores, the place in the class, the
 * repository's facts. See DESIGN.md › The repository page.
 */
export function RepoPage({ projectId, rowId, navigate }: { projectId: string; rowId: string; navigate: Navigate }) {
  const t = useT();
  const [filterParam] = useSearchParam("filter", "");
  const filter = repoFilterOf(filterParam);
  const detail = useQuery<ProjectDetail>({
    queryKey: projectKey(projectId),
    queryFn: () => api(`/app/api/projects/${projectId}`),
    refetchInterval: (q) => projectRefetchInterval(q.state.data),
  });
  const crumbs = useClassroomCrumbs(detail.data?.classroomId);

  if (detail.isLoading) return <PageSkeleton header="title-and-bar" body="summary-and-block" />;
  if (detail.isError) {
    if (isNotFound(detail.error)) return <QueryError title={t("project.notFound")} query={detail} />;
    return <PageError title={t("project.page")} query={detail} />;
  }
  const project = detail.data!;
  const entry = entryOfRow(project, rowId);
  const back = { view: "project" as const, id: project.id, tab: "repositories" as const, ...(filter ? { filter } : {}) };
  const trail = [...crumbs, { label: project.name, route: back }];
  if (!entry) {
    // A row the project does not hold (a mistyped address, a repository gone with its row): said as a missing record.
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={<Trail navigate={navigate} items={trail} />} title={t("project.repoPage.notFound")} />
        <Card>
          <EmptyState
            icon={FolderGit2}
            title={t("project.repoPage.notFound.body")}
            action={
              <Button variant="secondary" onClick={() => navigate(back)}>
                {t("project.repoPage.back")}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }
  return <RepoView project={project} entry={entry} filter={filter} trail={[...trail, { label: entry.label }]} navigate={navigate} />;
}

/** The page of a row the project holds: what `RepoPage` draws once the project is read. */
function RepoView({
  project,
  entry,
  filter,
  trail,
  navigate,
}: {
  project: ProjectDetail;
  entry: RepoEntry;
  filter: RepoFilter | null;
  trail: Crumb[];
  navigate: Navigate;
}) {
  const t = useT();
  const [scoring, setScoring] = useState(false);
  const writes = useRepoWrites(project, entry, () => setScoring(false));
  const reviewOf = useReviewAction(project);
  const { repo } = entry;
  const state = stateBadge(repo);
  const joined = joinedCount(entryMembers(entry));
  const primary = repoPrimary(entry, project);
  const can = repo !== null && actionable(repo, project);
  const rail = repo !== null || entry.kind === "group";
  const menu: MenuItem[] =
    repo?.flags.protectionSuspended
      ? [
          {
            label: t("project.protection.reenable"),
            description: t("project.protection.reenable.desc"),
            icon: ShieldCheck,
            disabled: !can,
            onSelect: () => writes.reenable.mutate(),
          },
        ]
      : [];
  const openScore = () => setScoring(true);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Trail navigate={navigate} items={trail} />}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {entry.label}
            <span className="flex flex-wrap items-center gap-1.5 text-sm font-normal tracking-normal">
              <Badge tone={state.tone} icon={state.icon}>
                {t(state.key)}
              </Badge>
              {repo !== null && joined.total > 1 && joined.n < joined.total ? (
                <Badge tone="zinc">{t("project.access.joinedCount", joined)}</Badge>
              ) : null}
              {isStaffTest(entry) ? <Badge tone="zinc">{t("grading.staff")}</Badge> : null}
            </span>
          </span>
        }
        description={
          <>
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {repo?.fullName ? <RepoLink fullName={repo.fullName} full icon className="font-mono text-[13px] text-fg" /> : null}
              {repo ? (
                <span className="tabular-nums">{t("project.repoPage.deadline", { date: isoDateTime(repo.effectiveDeadlineAt) })}</span>
              ) : null}
            </span>
            {repo ? <RepoTags repo={repo} /> : null}
          </>
        }
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <RepoStepper project={project} entry={entry} filter={filter} navigate={navigate} />
            {repo && reviewOf ? <OpenInWorkspaceButton projectId={project.id} repo={repo} action={reviewOf(repo)} /> : null}
            {primary === "grade" && repo ? (
              <Button onClick={() => navigate({ view: "projectGrading", id: project.id }, { query: { repo: repo.id } })}>
                <ClipboardCheck /> {t("project.grading.open")}
              </Button>
            ) : primary === "teacherScore" && repo ? (
              <Button onClick={openScore}>
                <PenLine /> {t(repo.scores.teacher ? "project.teacherScore.edit" : "project.teacherScore.enter")}
              </Button>
            ) : null}
          </span>
        }
        menu={menu.length > 0 ? <Menu items={menu} /> : undefined}
      />

      {repo ? <RepoStats project={project} entry={entry} repo={repo} /> : null}

      {/* The rail: a repository's deadline, scores and facts, or a group's set; a student who has not accepted has none. */}
      <div className={cx("grid items-start gap-8", rail && "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
        <div className="min-w-0 space-y-8">
          <RepoMembers entry={entry} can={can} resend={writes.resend} />
          {repo && repo.provisionStatus === "ok" ? <RepoActivity project={project} entry={entry} repo={repo} /> : null}
          {repo && repo.provisionStatus === "ok" ? (
            <section aria-labelledby="repo-runs" className="space-y-3">
              <SectionHeading icon={History} title={<span id="repo-runs">{t("project.runs")}</span>} />
              <Card className="overflow-hidden">
                <RunHistory projectId={project.id} repoId={repo.id} />
              </Card>
            </section>
          ) : null}
        </div>
        {rail ? <RepoRail project={project} entry={entry} writes={writes} can={can} primary={primary} onScore={openScore} /> : null}
      </div>

      {scoring && repo ? (
        <Modal title={t("project.teacherScore")} subtitle={entry.label} onClose={() => setScoring(false)}>
          <TeacherScoreForm key={repo.scores.teacher?.gradedAt ?? "none"} repo={repo} score={writes.score} />
        </Modal>
      ) : null}
    </div>
  );
}
