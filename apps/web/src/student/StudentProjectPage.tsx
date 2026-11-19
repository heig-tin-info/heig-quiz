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
 * once released, the final score, the grade and the teacher's comment; on a
 * project graded by criteria, the criteria table under the score
 * (`ProjectCriteria.tsx`, ADR-106 §9), indicative until the release; the
 * teacher's message of the latest sync under the header (ADR-132 §10). The
 * clock is the server's (invariant 5): the payload's `serverNow` is sampled
 * into `useServerClock`, and every countdown and gate reads its offset.
 *
 * It is the shell's width, like the classroom page it hangs from, and the
 * rhythm of an evaluation's results page (M3-14l). The header is the card's:
 * the status badge and the card's timing and commit items, in one line under
 * the title (one definition for both), the action with the GitHub mark; the
 * CI run and the score have their own sections below, not the header.
 *
 * The four decisions:
 *   - Type: the project's title at the page-title step; the score at the
 *     Stat's 22 px; everything else 13–14 px.
 *   - Color: ONE accent, the header's action while the student has a step to
 *     take (Link, Accept, Open the invitation); a ready repository is a
 *     secondary link, and the page then has no primary at all.
 *   - Space: 24 between the header and the sections, 32 between sections,
 *     12 inside a card.
 *   - Finish: cards on the canvas, hairlines, no shadow.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, FolderGit2, Laptop, Lock } from "lucide-react";

import {
  projectSebPath,
  workspaceStartPath,
  WorkspaceStartRefusal,
  type ProjectInvitationResent,
  type StudentProject,
  type StudentProjectRepo,
} from "@quiz/contracts";
import { ciShare, ciShareOnly, criteriaTotals, formatScore } from "@quiz/domain";

import { api, apiErrorMessage, isNotFound, refusalCodeOf, useMe } from "../api";
import { usePortalLaunch } from "../portalLaunch";
import { Grade } from "../Grade";
import { useT } from "../i18n";
import { useNoticeToasts } from "../notifications/notices";
import { useToast } from "../notify";
import { studentProjectKey, studentRootKey } from "../queryKeys";
import { useServerNow } from "../realtime/useServerClock";
import { useSearchParam, type Navigate } from "../router";
import { Trail, useRootCrumb } from "../Trail";
import { CiBadge } from "../project/parts";
import {
  Alert,
  BarLegend,
  Button,
  Card,
  EmptyState,
  GithubIcon,
  isoDateTime,
  MetaLine,
  NotePanel,
  PageError,
  PageHeader,
  PageSkeleton,
  SectionHeading,
  SegmentedBar,
  Stat,
  type BarPart,
} from "../ui";
import { RowActionControl, StatusBadge } from "./ActivityRow";
import { CriteriaSection } from "./ProjectCriteria";
import { notStarted, ProjectCommitMeta, ProjectTimingMeta, projectStatus, useProjectAction, useStudentReadOnly } from "./ProjectRow";
import {
  factsOfProject,
  hasState,
  projectActionKind,
  REREAD_REFUSALS,
  scorePoints,
  STATE_KEY,
  studentRefusalCode,
  studentRefusalMessage,
} from "./projectRow";
import { SebLaunchModal } from "./SebLaunchModal";
import { SebQuitButton } from "./SebQuit";
import { studentProjectNotices, studentProjectNoticeToast } from "./studentProjectNotices";

export function StudentProjectPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const t = useT();
  const project = useQuery<StudentProject>({
    queryKey: studentProjectKey(id),
    queryFn: () => api(`/app/api/student/projects/${id}`),
  });
  // F-PROJ-21 (M3-09c): what each re-read of their own repository found changed.
  useNoticeToasts(project, (prev, next) => studentProjectNotices(prev, next).map((k) => studentProjectNoticeToast(k, t)));

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
      <PageError title={t("activities.kind.project")} query={project} />
    );
  }
  if (!project.data) return <PageSkeleton body="summary-and-block" />;

  return <ProjectBody project={project.data} navigate={navigate} />;
}

function ProjectBody({ project, navigate }: { project: StudentProject; navigate: Navigate }) {
  const t = useT();
  const readOnly = useStudentReadOnly(project.seat !== null);
  // The server's clock, from the payload (invariant 5).
  const now = useServerNow(project.serverNow);
  // D21: the session confined to this project (a `seb` one, the only kind
  // with a `projectId`): the page's one action is *Open workspace*, GitHub is
  // out of SEB's reach, and the page frames itself (no shell around it).
  const inSeb = useMe().data?.session?.projectId === project.id;

  // ADR-047 §2: under Safe Exam Browser the student is invited to nothing
  // (`invitation` null) and reaches no repository before grading. Once
  // accepted, the page's action is the workspace's, never GitHub's.
  const noGithub = inSeb || project.workspace?.mode === "online_seb";

  const facts = factsOfProject(project);
  const kind = projectActionKind(facts, now);
  const accepted = kind === "open";
  const projectAction = useProjectAction(facts, { now, primary: true, readOnly });
  const action = noGithub && accepted ? null : projectAction;
  const live = project.repo && !project.repo.deleted ? project.repo : null;
  const coursesRoot = useRootCrumb("studentCourses");

  return (
    <div className={inSeb ? "mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6" : "space-y-6"}>
      <WorkspaceRefusal />
      <PageHeader
        eyebrow={
          <Trail
            navigate={navigate}
            items={[
              coursesRoot,
              { label: project.classroomName, route: { view: "classroom", id: project.classroomId } },
              { label: project.title },
            ]}
          />
        }
        title={project.title}
        description={
          <>
            <div data-coach="sproj.deadline">
              <MetaLine>
                {/* Not started (a scheduled project too, ADR-127): the start says it, as on the card, and the section below. */}
                {kind === "notStarted" ? null : <StatusBadge status={projectStatus(project.status, t)} />}
                <ProjectTimingMeta project={project} now={now} />
                {live && !notStarted(project, now) ? (
                  <ProjectCommitMeta work={live} evaluated={Date.parse(project.deadlineAt) <= now || live.locked} named />
                ) : null}
              </MetaLine>
            </div>
            {readOnly ? (
              <p className="mt-1.5 text-[13px]">{t(project.seat === null ? "sproj.readOnly.noSeat" : "sproj.readOnly")}</p>
            ) : null}
            {project.seat === "staff" && !readOnly ? <p className="mt-1.5 text-[13px]">{t("sproj.staffTest")}</p> : null}
          </>
        }
        actions={
          action || inSeb ? (
            <>
              {/* ADR-027 */}
              {inSeb ? <SebQuitButton variant="secondary" /> : null}
              {action ? (
                <span className="block w-full sm:w-auto" data-coach="sproj.action">
                  <RowActionControl action={action} className="w-full sm:w-auto" />
                </span>
              ) : null}
            </>
          ) : undefined
        }
      />

      {project.projectUpdate ? <TeacherUpdateSection update={project.projectUpdate} /> : null}

      {inSeb ? null : (
        <section className="space-y-3">
          <SectionHeading title={t("sproj.repo")} help="student-project" />
          {live ? (
            <RepoCard project={project} repo={live} readOnly={readOnly} />
          ) : (
            <Card className="px-5 py-4 text-sm text-fg-muted">
              {kind === "accept"
                ? t("sproj.repo.toAccept")
                : kind === "notStarted"
                  ? t("sproj.repo.notStarted", { when: isoDateTime(project.startAt) })
                  : t(hasState(kind) ? STATE_KEY[kind] : "sproj.repo.toAccept")}
            </Card>
          )}
        </section>
      )}

      {project.workspace ? (
        <WorkspaceSection
          project={project}
          live={live !== null}
          primary={(accepted || inSeb) && !readOnly}
          inSeb={inSeb}
          readOnly={readOnly}
        />
      ) : null}

      {live?.run && !inSeb ? <RunSection repo={live} run={live.run} /> : null}

      {project.release ? (
        <ReleaseSection release={project.release} />
      ) : project.gradingMode !== "none" && live ? (
        <ScoreSection repo={live} project={project} />
      ) : null}

      {project.criteria ? <CriteriaSection rows={project.criteria} /> : null}
    </div>
  );
}

/**
 * Why the workspace did not open (ADR-047, M6-06): the start route's
 * refusal, kept in the address as `?workspace=<code>` (`WorkspaceStartRefusal`)
 * so that a reload still says it; any other value is ignored.
 */
function WorkspaceRefusal() {
  const t = useT();
  const [code] = useSearchParam("workspace", "");
  const refusal = WorkspaceStartRefusal.safeParse(code);
  if (!refusal.success) return null;
  return (
    <Alert tone="warning" icon={AlertTriangle} title={t("sproj.workspace.refused")}>
      {t(`sproj.workspace.refusal.${refusal.data}`)}
    </Alert>
  );
}

/**
 * The online workspace (ADR-047, M6-06): *Open workspace* ({@link
 * OpenWorkspaceButton}) once the student's repository exists; the page's
 * accent when the repository is ready and nothing else is asked of the
 * student. Under Safe Exam Browser (D21, M6-07), it opens from the
 * project's own `seb` session only; from the portal, the action is the
 * project's `.seb`, through the steps of {@link SebLaunchModal}.
 */
function WorkspaceSection({
  project,
  live,
  primary,
  inSeb,
  readOnly,
}: {
  project: StudentProject;
  live: boolean;
  primary: boolean;
  inSeb: boolean;
  readOnly: boolean;
}) {
  const t = useT();
  const [launching, setLaunching] = useState(false);
  const online = project.workspace?.mode === "online";
  // ADR-089: at Kiosk only there is no `.seb` to offer; the student is sent to a station.
  const devices = project.workspace?.devices ?? "any";
  const variant = primary ? "primary" : "secondary";
  const action = !live ? null : online || inSeb ? (
    <OpenWorkspaceButton projectId={project.id} variant={variant} />
  ) : readOnly || devices === "kiosk" ? null : (
    <Button variant={variant} onClick={() => setLaunching(true)}>
      <Lock /> {t("sproj.workspace.openInSeb")}
    </Button>
  );
  const where = inSeb ? "sproj.workspace.inSeb" : (`sproj.workspace.${devices}` as const);
  // ADR-130 §7: inside SEB or at a station the repository card is not shown, so the collection is said here.
  const collected = inSeb && project.repo?.collected === true;
  return (
    <section className="space-y-3" data-testid="sproj-workspace">
      <SectionHeading title={t("sproj.workspace")} />
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm">
        <div className="space-y-2">
          <p className="text-fg-muted">{t(where)}</p>
          {collected ? <p className="text-fg-muted">{t("sproj.collected")}</p> : null}
        </div>
        {action}
      </Card>
      {launching ? (
        <SebLaunchModal kind="workspace" href={projectSebPath(project.id)} title={project.title} onClose={() => setLaunching(false)} />
      ) : null}
    </section>
  );
}

/**
 * *Open workspace* (audit L7): a POST to the start route — a write under the
 * CSRF check, never a link a cross-site page could make a browser follow —,
 * then the page goes to the portal's launch address it answers. A refusal
 * the student can read lands in the address (`?workspace=<code>`), where
 * {@link WorkspaceRefusal} words it; anything else is a toast.
 */
function OpenWorkspaceButton({ projectId, variant }: { projectId: string; variant: "primary" | "secondary" }) {
  const t = useT();
  const toast = useToast();
  const [, setRefusal] = useSearchParam("workspace", "");
  const { busy, launch } = usePortalLaunch(workspaceStartPath(projectId), (error) => {
    const refusal = WorkspaceStartRefusal.safeParse(refusalCodeOf(error));
    if (refusal.success) setRefusal(refusal.data);
    else toast(apiErrorMessage(error, t("error.save")), "error");
  });
  return (
    <Button variant={variant} onClick={launch} loading={busy}>
      <Laptop /> {t("sproj.workspace.open")}
    </Button>
  );
}

/**
 * The student's live repository: its name on GitHub, their invitation while
 * it waits (with the Resend; on a group's, also once the group's is
 * accepted, for a member whose own invitation expired), its lock, and that the online workspace was
 * collected at the deadline (ADR-130 §7): the evaluated commit may then be
 * the platform's, which nothing calls a push. The commit it stands on is the
 * header's; the run and the score have their own sections. No invitation
 * at all under Safe Exam Browser, where nobody is invited (ADR-047 §2).
 */
function RepoCard({
  project,
  repo,
  readOnly,
}: {
  project: StudentProject;
  repo: StudentProjectRepo;
  readOnly: boolean;
}) {
  const t = useT();
  return (
    <Card className="space-y-2 p-5 text-sm">
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
      {repo.invitation === "pending" ? (
        <p className="flex flex-wrap items-center gap-3">
          <span>{t("sproj.invitation.pending")}</span>
          {!readOnly ? <ResendButton projectId={project.id} /> : null}
        </p>
      ) : repo.group && repo.invitation === "accepted" && !readOnly ? (
        // The group's row says accepted once one member is in: theirs may have expired, the server tells.
        <p className="flex flex-wrap items-center gap-3 text-fg-muted">
          <span>{t("sproj.invitation.lost")}</span>
          <ResendButton projectId={project.id} />
        </p>
      ) : null}
      {repo.locked ? <p className="text-fg-muted">{t("sproj.locked")}</p> : null}
      {repo.collected ? <p className="text-fg-muted">{t("sproj.collected")}</p> : null}
    </Card>
  );
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

/**
 * The CI run the score comes from, when one exists: its status as a badge,
 * the run on GitHub (a new tab) and when it finished.
 */
function RunSection({ repo, run }: { repo: StudentProjectRepo; run: NonNullable<StudentProjectRepo["run"]> }) {
  const t = useT();
  return (
    <section className="space-y-3">
      <SectionHeading title={t("sproj.ci")} />
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-5 text-sm">
        <CiBadge status={repo.ciStatus} />
        <a href={run.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 hover:underline">
          <GithubIcon className="size-4 shrink-0 text-fg-faint" />
          {t("sproj.run.open")}
          <ExternalLink className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
        </a>
        <span className="text-fg-faint">{isoDateTime(run.completedAt)}</span>
      </Card>
    </section>
  );
}

/**
 * The score before the release (N-SEC-21): the CI's, INDICATIVE — current
 * while the project runs, frozen once the deadline is applied — with the run
 * it comes from. Nothing of the review's or the teacher's. Graded by
 * criteria, the CI's score is only its share of the whole: no grade, the
 * share drawn against the criteria's total ({@link CiShareStat}).
 */
function ScoreSection({ repo, project }: { repo: StudentProjectRepo; project: Pick<StudentProject, "gradingMode" | "criteria"> }) {
  const t = useT();
  return (
    <section className="space-y-3" data-coach="sproj.score">
      <SectionHeading title={t("sproj.score")} />
      {repo.score && repo.score.max !== null && ciShareOnly(project.gradingMode, "ci") ? (
        <CiShareStat
          score={{ ...repo.score, max: repo.score.max }}
          total={Math.max(criteriaTotal(project.criteria) ?? 0, repo.score.max)}
        />
      ) : repo.score ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat
            label={t(repo.score.frozen ? "sproj.score.frozen" : "sproj.score.current")}
            value={scorePoints(repo.score.points, repo.score.max)}
            hint={t(repo.score.frozen ? "sproj.score.frozenHint" : "sproj.score.indicativeHint")}
          />
          {repo.score.grade ? (
            <Stat label={t("results.col.grade")} value={<Grade value={repo.score.grade.grade} />} hint={t("sgrades.indicative")} />
          ) : null}
        </div>
      ) : (
        <Card className="px-5 py-4 text-sm text-fg-muted">{t("sproj.score.none")}</Card>
      )}
    </section>
  );
}

/** The criteria's total (`criteriaTotals`: the positive maxima, no penalty, no bonus), null without the table. */
const criteriaTotal = (rows: StudentProject["criteria"]): number | null =>
  rows ? criteriaTotals(rows.map((row) => ({ id: row.criterionId, maxPoints: row.max })), {}).max : null;

/**
 * The CI's score of a project graded by criteria, before the release
 * (product owner, 2026-11-18): only the CI's share, the AI and the teacher
 * grading the rest later, so no grade. The points out of the CI's maximum,
 * the whole total beside them (`total`, never below the CI's maximum), and
 * one bar of the whole (`ciShare`): green what the CI awarded, red what it
 * did not, grey what the AI or the teacher grades — "later" is not said: the
 * table below may already hold their indicative points. The bar spells its
 * parts out to a screen reader and on hover; the legend and the sentence
 * under it say the same in words.
 */
function CiShareStat({ score, total }: { score: { points: number; max: number; frozen: boolean }; total: number }) {
  const t = useT();
  const share = ciShare(score, total);
  const parts: (BarPart & { label: string; legend: string })[] = [
    { tone: "success", value: share.awarded, label: t("sproj.share.awarded"), legend: t("sproj.share.awarded") },
    { tone: "danger", value: share.missed, label: t("sproj.share.missed"), legend: t("sproj.share.missed") },
    ...(share.later > 0
      ? [{ tone: "muted" as const, value: share.later, label: t("sproj.share.others"), legend: t("sproj.share.others.legend") }]
      : []),
  ];
  return (
    <Stat
      label={t(score.frozen ? "sproj.share.frozen" : "sproj.share.current")}
      aside={t("sproj.share.total", { n: formatScore(total) })}
      value={scorePoints(score.points, score.max)}
    >
      <SegmentedBar parts={parts} className="h-2.5" />
      <BarLegend parts={parts.map(({ tone, legend }) => ({ tone, label: legend }))} />
      <p>
        {share.later > 0
          ? `${t(share.later === 1 ? "sproj.share.othersPoints.one" : "sproj.share.othersPoints", { n: formatScore(share.later) })} `
          : ""}
        {t("sproj.share.noGrade")}
      </p>
    </Stat>
  );
}

/**
 * "Update from your teacher" (ADR-132 §10): the latest sync's message, the
 * teacher's own plain text — a text node, never Markdown — and its date.
 * Shown inside Safe Exam Browser too, where the pull request is out of reach.
 */
function TeacherUpdateSection({ update }: { update: NonNullable<StudentProject["projectUpdate"]> }) {
  const t = useT();
  return (
    <section data-testid="sproj-teacher-update">
      <NotePanel eyebrow={t("sproj.teacherUpdate")} aside={isoDateTime(update.at)} tone="outlined">
        <p className="mt-1 whitespace-pre-wrap text-sm">{update.text}</p>
      </NotePanel>
    </section>
  );
}

/**
 * What the release gave the student (F-PROJ-14): the final score, its grade,
 * the teacher's comment as the release wrote it, then — when the grade was
 * adjusted (ADR-135) — the adjustment's justification, never its delta.
 */
function ReleaseSection({ release }: { release: NonNullable<StudentProject["release"]> }) {
  const t = useT();
  return (
    <section className="space-y-3" data-coach="sproj.score">
      <SectionHeading title={t("sproj.result")} description={t("sproj.result.publishedAt", { when: isoDateTime(release.at) })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={t("sproj.score.final")} value={release.points === null ? "—" : scorePoints(release.points, release.max)} />
        {release.grade ? <Stat label={t("results.col.grade")} value={<Grade value={release.grade.grade} />} /> : null}
      </div>
      {release.comment ? (
        <NotePanel eyebrow={t("feedback.comment")} tone="outlined">
          <p className="whitespace-pre-wrap text-sm">{release.comment}</p>
        </NotePanel>
      ) : null}
      {release.adjustmentComment ? (
        <NotePanel eyebrow={t("sproj.gradeAdjusted")} tone="outlined">
          <p className="whitespace-pre-wrap text-sm" data-testid="sproj-adjustment">
            {release.adjustmentComment}
          </p>
        </NotePanel>
      ) : null}
    </section>
  );
}
