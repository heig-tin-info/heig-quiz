import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardCheck, FolderGit2, History, Lock, ShieldCheck, Snowflake } from "lucide-react";

import type { ProjectDetail, ProjectRepoView } from "@quiz/contracts";
import { projectGraded } from "@quiz/domain";

import { api, isNotFound } from "../api";
import { useT } from "../i18n";
import { useSearchParam, type Navigate } from "../router";
import { projectKey } from "../queryKeys";
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
} from "../ui";
import { OpenInWorkspaceButton, useReviewAction } from "./OpenInWorkspace";
import { CiBadge, Points, RepoTags, SCORE_SOURCE_KEY, unattributedText } from "./parts";
import {
  actionable,
  entryMembers,
  entryOfRow,
  isStaffTest,
  joinedCount,
  projectRefetchInterval,
  repoFilterOf,
  repoPrimary,
  repoStateBadge,
  repoSteps,
  shortSha,
  type RepoEntry,
  type RepoFilter,
} from "./projectPage";
import { RepoActivity, RepoMembers } from "./RepoMembers";
import { RepoRail } from "./RepoRail";
import { RunHistory } from "./RunHistory";
import { TeacherScoreButton, TeacherScoreForm } from "./TeacherScoreForm";
import { useRepoWrites } from "./useRepoWrites";

const STATE_ICON = { lock: Lock, frozen: Snowflake } as const;

/** ‹ n of N ›: the previous and next rows of the Repositories tab (ADR-137); none on the staff's test repository. */
function RepoStepper({ project, entry, filter, navigate }: { project: ProjectDetail; entry: RepoEntry; filter: RepoFilter | null; navigate: Navigate }) {
  const t = useT();
  const steps = repoSteps(project, entry, filter);
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
 * The figures of a repository (ADR-137), from the row the page holds: its
 * commits (the unattributed ones in the hint), its last commit, its CI and,
 * graded, its final score. A figure the row lacks is a dash. Who joined is
 * the header's badge, not a figure.
 */
function RepoStats({ project, repo }: { project: ProjectDetail; repo: ProjectRepoView }) {
  const t = useT();
  const final = repo.scores.final;
  const graded = projectGraded(project.gradingMode);
  return (
    <section aria-label={t("project.repoPage.figures")} className={cx("grid grid-cols-2 gap-3", graded ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
      <Stat
        label={t("project.repoPage.commits")}
        value={repo.commits}
        hint={repo.unattributed.n > 0 ? unattributedText(t, repo.unattributed.n) : undefined}
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
      {graded ? (
        <Stat
          label={t("project.col.score")}
          value={<Points points={final?.points ?? null} max={final?.max ?? null} />}
          hint={final ? t(SCORE_SOURCE_KEY[final.source]) : undefined}
        />
      ) : null}
    </section>
  );
}

/**
 * One repository of a project, the staff's page (ADR-137, amending
 * F-PROJ-13), `/projects/:id/repos/:rowId`: what the row of the
 * Repositories tab opens. It reads the project's own page (`projectKey`,
 * cached, refetched as the page is, never waiting for GitHub) and finds its
 * row there — a repository, or a row not accepted yet, which shows its
 * members and nothing of GitHub.
 *
 * The header: the trail, the row's name with its state and "x/y joined",
 * its repository, deadline and tags, ‹ n of N › over the tab's rows (its
 * filter kept, the staff's test repository never a step), *Open in
 * workspace* (secondary, ADR-129 §11) and the ONE primary, by state
 * (`repoPrimary`): none during the project; once frozen for good, Grade
 * (the grading screen on this repository) under criteria, the teacher's
 * score (its dialog) under the CI's. Re-enabling the protection is the
 * overflow menu's.
 *
 * Then the figures, and two columns — the rail under the main one below
 * `lg`: the members, the weekly commits, the runs; the deadline and the
 * lock, the scores, the place in the class, the repository's facts. See
 * DESIGN.md › The repository page.
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
  const writes = useRepoWrites(project.id, entry, () => setScoring(false));
  const reviewOf = useReviewAction(project);
  const { repo } = entry;
  const state = repoStateBadge(repo);
  const joined = joinedCount(entryMembers(entry));
  const primary = repoPrimary(entry, project);
  const can = repo !== null && actionable(repo, project);
  // The rail: a repository's deadline, scores and facts, or a group's set; a student who has not accepted has none.
  const rail = repo !== null || entry.kind === "group";
  const menu: MenuItem[] = repo?.flags.protectionSuspended
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
              <Badge tone={state.tone} icon={state.icon ? STATE_ICON[state.icon] : undefined}>
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
          repo ? (
            <>
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {repo.fullName ? <RepoLink fullName={repo.fullName} full icon className="font-mono text-[13px] text-fg" /> : null}
                <span className="tabular-nums">{t("project.repoPage.deadline", { date: isoDateTime(repo.effectiveDeadlineAt) })}</span>
              </span>
              {/* The collection and the sync are the rail's facts: said once. */}
              <RepoTags repo={repo} facts={false} className="mt-2 flex flex-wrap items-center gap-1" />
            </>
          ) : undefined
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
              <TeacherScoreButton repo={repo} onClick={openScore} />
            ) : null}
          </span>
        }
        menu={menu.length > 0 ? <Menu items={menu} /> : undefined}
      />

      {repo ? <RepoStats project={project} repo={repo} /> : null}

      <div className={cx("grid items-start gap-8", rail && "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
        <div className="min-w-0 space-y-8">
          <RepoMembers entry={entry} can={can} resend={writes.resend} />
          {repo && repo.provisionStatus === "ok" ? (
            <>
              <RepoActivity project={project} entry={entry} repo={repo} />
              <section aria-labelledby="repo-runs" className="space-y-3">
                <SectionHeading icon={History} title={<span id="repo-runs">{t("project.runs")}</span>} />
                <Card className="overflow-hidden">
                  <RunHistory projectId={project.id} repoId={repo.id} />
                </Card>
              </section>
            </>
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
