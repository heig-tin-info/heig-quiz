/**
 * The student's project (F-PROJ-15, N-SEC-20; merge task M3-13),
 * `/projects/:id` — the same address as the staff's page, which `App.tsx`
 * gives the staff; a student, a teacher in the student view (ADR-018) and an
 * impersonation session (ADR-034) read this one, from the ONE exit
 * `GET /app/api/student/projects/:id`.
 *
 * What it shows is what the server sends and nothing it reconstructs: the
 * repository and its invitation (with the student's own Resend, F-PROJ-07),
 * the evaluated commit, its CI run and status, the current score marked
 * indicative, the frozen score after the deadline (still indicative), and,
 * once released, the final score, the grade and the teacher's comment.
 *
 * The four decisions:
 *   - Type: the project's title at the page-title step; the score at the
 *     Stat's 22 px; everything else 13–14 px.
 *   - Color: ONE accent, the header's action while the student has a step to
 *     take (Link, Accept, Open the invitation); a ready repository is a
 *     secondary link, and the page then has no primary at all.
 *   - Space: 32 between the sections, 12 inside a card.
 *   - Finish: cards on the canvas, hairlines, no shadow.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FolderGit2 } from "lucide-react";

import { formatPoints } from "@quiz/domain";
import type { CiStatus, ProjectInvitationResent, StudentProject, StudentProjectRepo } from "@quiz/contracts";

import { api, ApiError } from "../api";
import { Grade } from "../Grade";
import { useT, type Dict, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { studentProjectKey, studentRootKey } from "../queryKeys";
import type { Navigate } from "../router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  GithubIcon,
  isoDateTime,
  NotePanel,
  PageError,
  PageHeader,
  PageSkeleton,
  ParentLink,
  SectionHeading,
  Stat,
  useNow,
  type Tone,
} from "../ui";
import { RowActionControl } from "./ActivityRow";
import { deadlineLine, startLine, useProjectAction, useStudentReadOnly } from "./ProjectRow";
import {
  factsOfProject,
  PROJECT_STATUS_KEY,
  projectActionKind,
  REREAD_REFUSALS,
  studentRefusalCode,
  studentRefusalMessage,
  type ProjectActionKind,
} from "./projectRow";

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

export function StudentProjectPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const t = useT();
  const now = useNow(30_000);
  const readOnly = useStudentReadOnly();
  const project = useQuery<StudentProject>({
    queryKey: studentProjectKey(id),
    queryFn: () => api(`/app/api/student/projects/${id}`),
  });

  // A project the caller holds no seat for, a draft, an archived one: all
  // read as a project that does not exist (invariant 6).
  if (isNotFound(project.error)) {
    return (
      <EmptyState
        icon={FolderGit2}
        titleAs="h1"
        title={t("sproj.notFound")}
        action={
          <Button variant="secondary" onClick={() => navigate({ view: "home" })}>
            {t("sproj.backToActivities")}
          </Button>
        }
      />
    );
  }
  if (project.isError) {
    return (
      <PageError
        title={t("sproj.page")}
        error={project.error}
        onRetry={() => void project.refetch()}
        retrying={project.isFetching}
      />
    );
  }
  if (!project.data) return <PageSkeleton body="summary-and-block" />;

  return <ProjectBody project={project.data} now={now} readOnly={readOnly} navigate={navigate} />;
}

function ProjectBody({
  project,
  now,
  readOnly,
  navigate,
}: {
  project: StudentProject;
  now: number;
  readOnly: boolean;
  navigate: Navigate;
}) {
  const t = useT();
  const facts = factsOfProject(project);
  const kind = projectActionKind(facts, now);
  const action = useProjectAction(facts, { now, primary: true, readOnly });
  const ahead = Date.parse(project.startAt) > now;

  return (
    <div className="mx-auto max-w-180 space-y-8">
      <PageHeader
        eyebrow={
          <ParentLink onClick={() => navigate({ view: "classroom", id: project.classroomId })}>
            {project.classroomName}
          </ParentLink>
        }
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            {project.title}
            <Badge tone="zinc">{t(PROJECT_STATUS_KEY[project.status])}</Badge>
          </span>
        }
        description={
          <>
            <p>
              {project.courseCode} · {project.classroomName}
            </p>
            <p className="mt-0.5 text-[13px] text-fg-faint">
              {ahead
                ? startLine(project.startAt, now, t)
                : Date.parse(project.deadlineAt) > now
                  ? `${t("sproj.deadline", { when: isoDateTime(project.deadlineAt) })} · ${deadlineLine(project.deadlineAt, now, t)}`
                  : t("sproj.deadline", { when: isoDateTime(project.deadlineAt) })}
            </p>
            {readOnly ? <p className="mt-0.5 text-[13px] text-fg-muted">{t("sproj.readOnly")}</p> : null}
          </>
        }
        actions={action ? <RowActionControl action={action} className="w-full sm:w-auto" /> : undefined}
        actionsFullWidth
      />

      <section className="space-y-3">
        <SectionHeading title={t("sproj.repo")} />
        <RepoCard project={project} kind={kind} readOnly={readOnly} now={now} />
      </section>

      {project.release ? (
        <ReleaseSection release={project.release} />
      ) : project.gradingMode !== "none" && project.repo && !project.repo.deleted ? (
        <ScoreSection repo={project.repo} />
      ) : null}
    </div>
  );
}

/** The sentence of a repository the student does not have (yet, or any more). */
const NO_REPO_KEY: Partial<Record<ProjectActionKind, keyof Dict>> = {
  link: "sproj.repo.link",
  accept: "sproj.repo.toAccept",
  notAccepted: "sproj.repo.notAccepted",
  deleted: "sproj.repo.deleted",
};

/**
 * The student's repository: its name on GitHub, their invitation (and the
 * Resend while it waits), its lock, the commit the view stands on and its CI
 * status — or why there is none.
 */
function RepoCard({
  project,
  kind,
  readOnly,
  now,
}: {
  project: StudentProject;
  kind: ProjectActionKind;
  readOnly: boolean;
  now: number;
}) {
  const t = useT();
  const repo = project.repo;
  if (!repo || repo.deleted) {
    const key = NO_REPO_KEY[kind];
    return (
      <Card className="px-5 py-4 text-sm text-fg-muted">
        {key ? t(key) : t("sproj.repo.notStarted", { when: isoDateTime(project.startAt) })}
      </Card>
    );
  }
  const commit = repo.lastCommit;
  const afterDeadline = Date.parse(project.deadlineAt) <= now || repo.locked;
  return (
    <Card className="space-y-3 p-5">
      <a
        href={repo.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-2 font-mono text-[14px] hover:underline"
      >
        <GithubIcon className="size-4 shrink-0 text-fg-faint" />
        <span className="truncate">{repo.fullName}</span>
        <ExternalLink className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
      </a>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-fg-muted">{t("sproj.invitation")}</dt>
        <dd className="flex flex-wrap items-center gap-3">
          <span>{t(repo.invitation === "pending" ? "sproj.invitation.pending" : "sproj.invitation.accepted")}</span>
          {repo.invitation === "pending" && !readOnly ? <ResendButton projectId={project.id} /> : null}
        </dd>
        {repo.locked ? (
          <>
            <dt className="text-fg-muted">{t("sproj.lock")}</dt>
            <dd>{t("sproj.lock.locked")}</dd>
          </>
        ) : null}
        <dt className="text-fg-muted">{t(afterDeadline ? "sproj.commit.evaluated" : "sproj.commit.last")}</dt>
        <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {commit ? (
            <>
              <span className="font-mono text-[13px]">{commit.sha.slice(0, 7)}</span>
              {commit.at ? <span className="text-fg-faint">{isoDateTime(commit.at)}</span> : null}
              <CiBadge status={repo.ciStatus} />
            </>
          ) : (
            <span className="text-fg-faint">{t("sproj.commit.none")}</span>
          )}
        </dd>
      </dl>
    </Card>
  );
}

const CI: Record<Exclude<CiStatus, "none">, { tone: Tone; key: keyof Dict }> = {
  pending: { tone: "zinc", key: "sproj.ci.pending" },
  pass: { tone: "green", key: "sproj.ci.pass" },
  fail: { tone: "red", key: "sproj.ci.fail" },
};

/** The CI status of the commit the view stands on; nothing while it has no run at all. */
function CiBadge({ status }: { status: CiStatus }) {
  const t = useT();
  if (status === "none") return null;
  return <Badge tone={CI[status].tone}>{t(CI[status].key)}</Badge>;
}

/**
 * The student's own resend of their pending invitation (F-PROJ-07): the
 * staff's minute applies (`429 resend_too_soon`, worded); an invitation
 * accepted meanwhile re-reads the page instead.
 */
function ResendButton({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const resend = useMutation({
    mutationFn: () =>
      api<ProjectInvitationResent>(`/app/api/student/projects/${projectId}/invite`, { method: "POST" }),
    onSuccess: () => toast(t("sproj.resent"), "success"),
    onError: (error) => {
      const code = studentRefusalCode(error);
      toast(studentRefusalMessage(error, t), code !== null && REREAD_REFUSALS.has(code) ? "progress" : "error");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: studentRootKey }),
  });
  return (
    <Button variant="secondary" size="sm" onClick={() => resend.mutate()} loading={resend.isPending}>
      {t("sproj.resend")}
    </Button>
  );
}

const points = (p: number, max: number | null): string => (max === null ? formatPoints(p) : `${formatPoints(p)} / ${formatPoints(max)}`);

/**
 * The score before the release (N-SEC-21): the CI's, INDICATIVE — current
 * while the project runs, frozen once the deadline is applied — with the run
 * it comes from. Nothing of the review's or the teacher's.
 */
function ScoreSection({ repo }: { repo: StudentProjectRepo }) {
  const t = useT();
  return (
    <section className="space-y-3">
      <SectionHeading title={t("sproj.score")} />
      {repo.score ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat
            label={t(repo.score.frozen ? "sproj.score.frozen" : "sproj.score.current")}
            value={points(repo.score.points, repo.score.max)}
            hint={t(repo.score.frozen ? "sproj.score.frozenHint" : "sproj.score.indicativeHint")}
          />
          {repo.score.grade ? (
            <Stat label={t("sproj.grade")} value={<Grade value={repo.score.grade.grade} />} hint={t("sgrades.indicative")} />
          ) : null}
        </div>
      ) : (
        <Card className="px-5 py-4 text-sm text-fg-muted">{t("sproj.score.none")}</Card>
      )}
      {repo.run ? <RunLine run={repo.run} t={t} /> : null}
    </section>
  );
}

/** The run the score comes from: its commit, its conclusion, when it finished, and the run on GitHub. */
function RunLine({ run, t }: { run: NonNullable<StudentProjectRepo["run"]>; t: TFunction }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-muted">
      <span>{t("sproj.run.commit", { sha: run.sha.slice(0, 7) })}</span>
      <span className="text-fg-faint">{run.conclusion}</span>
      <span className="text-fg-faint">{isoDateTime(run.completedAt)}</span>
      <a href={run.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
        {t("sproj.run.open")}
        <ExternalLink className="size-3.5" aria-hidden />
      </a>
    </p>
  );
}

/** What the release gave the student (F-PROJ-14): the final score, its grade, the teacher's comment as the release wrote it. */
function ReleaseSection({ release }: { release: NonNullable<StudentProject["release"]> }) {
  const t = useT();
  return (
    <section className="space-y-3">
      <SectionHeading title={t("sproj.result")} description={t("sproj.result.publishedAt", { when: isoDateTime(release.at) })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={t("sproj.score.final")} value={release.points === null ? "—" : points(release.points, release.max)} />
        {release.grade ? <Stat label={t("sproj.grade")} value={<Grade value={release.grade.grade} />} /> : null}
      </div>
      {release.comment ? (
        <Card className="p-5">
          <NotePanel eyebrow={t("sproj.comment")} tone="outlined">
            <p className="whitespace-pre-wrap text-sm">{release.comment}</p>
          </NotePanel>
        </Card>
      ) : null}
    </section>
  );
}
