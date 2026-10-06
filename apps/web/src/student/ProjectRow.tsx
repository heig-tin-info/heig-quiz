/**
 * A student's project on the home and the classroom page (F-PROJ-04; merge
 * task M3-13), and the one action it offers, shared with the project's page:
 * the four-state onboarding of `docs/merge/05-web.md` §5.3 — Link GitHub,
 * Accept, Open the invitation, Open repository — and the states that offer
 * nothing but a line (`projectRow.ts`). Its title opens the project's page.
 *
 * Accept is the one write (`POST /app/api/student/projects/:id/accept`,
 * F-PROJ-05): under a minute, so the button says so while it waits; on
 * `provision_in_progress` the row re-reads instead of resending; a stale
 * GitHub account turns the button into "Relink GitHub"; every other refusal
 * is worded (`studentRefusalMessage`). Every write ends by invalidating the
 * `student` root: the home, the classroom page and the project page re-read.
 *
 * An impersonation session (ADR-034) and a teacher in the student view
 * without a seat get no button: linking is refused to them (F-GH-05) and
 * Accept answers them the 404 of a missing project. One muted line says so.
 * A teacher's staff seat (ADR-018) gets the real actions, on a test
 * repository counted nowhere (ADR-077).
 *
 * `now` is the page's, read off the server's clock (invariant 5): the start
 * and the deadline are judged against it, never against the browser's.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { CalendarClock, CircleSlash, Eye, FolderGit2, Gauge, GitCommitHorizontal, Lock, MailCheck, TriangleAlert } from "lucide-react";

import type { StudentActivityGroup } from "@quiz/domain";
import type { ProjectAcceptance, StudentProjectCard, StudentProjectStatus, StudentProjectWork } from "@quiz/contracts";

import { api, useMe } from "../api";
import { githubLinkHref } from "../github/api";
import { useI18n, useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { CiBadge } from "../project/parts";
import { shortSha } from "../project/projectPage";
import { studentRootKey } from "../queryKeys";
import { routeToPath, type Navigate } from "../router";
import { GithubIcon, isoDateTime, MetaItem, relativeTime, type IconType } from "../ui";
import { ActivityRow, leftLine, startsLine, type RowAction, type RowStatus } from "./ActivityRow";
import {
  ACCENT_KINDS,
  factsOfCard,
  invitationHref,
  PROJECT_STATUS_KEY,
  projectActionKind,
  type ProjectActionKind,
  REREAD_REFUSALS,
  scorePoints,
  STATE_KEY,
  studentRefusalCode,
  studentRefusalMessage,
  type ProjectFacts,
} from "./projectRow";

/**
 * Whether the student screens are read by someone who cannot act as the
 * student: an admin acting as them (ADR-034), or a teacher in the student
 * view who holds no seat in the classroom (`seated` false). A teacher WITH a
 * staff seat acts on their own test repository (ADR-077); the project's
 * writes are the seat holder's alone (F-PROJ-05, F-GH-05).
 */
export function useStudentReadOnly(seated: boolean): boolean {
  const me = useMe();
  return !seated || me.data?.session?.kind === "impersonation";
}

/**
 * The one action of a project (`projectActionKind`), ready to draw: Link or
 * Relink GitHub (the account link flow, back to this page), Accept (the
 * write), the invitation or the repository on GitHub (a new tab). `null` for
 * the states with nothing to offer, and for a read-only reader.
 */
export function useProjectAction(
  facts: ProjectFacts,
  { now, primary, readOnly }: { now: number; primary: boolean; readOnly: boolean },
): RowAction | null {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const accept = useMutation({
    mutationFn: () => api<ProjectAcceptance>(`/app/api/student/projects/${facts.id}/accept`, { method: "POST" }),
    onSuccess: (made) => {
      toast(t(made.invitationStatus === "accepted" ? "sproj.accepted.ready" : "sproj.accepted.invited"), "success");
    },
    onError: (error) => {
      const code = studentRefusalCode(error);
      toast(studentRefusalMessage(error, t), code !== null && REREAD_REFUSALS.has(code) ? "progress" : "error");
    },
    // Refused or not, the server's state is the truth: the home, the
    // classroom page and the project page re-read it.
    onSettled: () => qc.invalidateQueries({ queryKey: studentRootKey }),
  });

  if (readOnly) return null;
  const kind = projectActionKind(facts, now);
  const accent = primary && ACCENT_KINDS.has(kind);
  if (facts.repo?.state === "live") {
    return facts.repo.invitation === "pending"
      ? { label: t("sproj.openInvitation"), icon: GithubIcon, primary: accent, href: invitationHref(facts.repo.url), external: true }
      : { label: t("sproj.openRepo"), icon: GithubIcon, href: facts.repo.url, external: true };
  }
  if (kind === "link") {
    return { label: t("github.link"), icon: GithubIcon, primary: accent, href: githubLinkHref(window.location.pathname) };
  }
  if (kind === "accept") {
    return studentRefusalCode(accept.error) === "github_account_stale"
      ? { label: t("sproj.relink"), icon: GithubIcon, primary: accent, href: githubLinkHref(window.location.pathname) }
      : {
          label: t(accept.isPending ? "sproj.accepting" : "sproj.accept"),
          primary: accent,
          loading: accept.isPending,
          onClick: () => accept.mutate(),
        };
  }
  return null;
}

/** The status badge of a project (F-PROJ-04): amber waits on the student, green is under way or done, zinc is closed. */
export function projectStatus(status: StudentProjectStatus, t: TFunction): RowStatus {
  const label = t(PROJECT_STATUS_KEY[status]);
  switch (status) {
    case "to_accept":
      return { label, tone: "amber" };
    case "in_progress":
      return { label, tone: "green" };
    case "locked":
      return { label, tone: "zinc", icon: Lock };
    case "released":
      return { label, tone: "green" };
  }
}

/** What a state says beside the deadline, with the icon that marks it (`STATE_KEY` holds the words). */
const STATE_ICON: Partial<Record<ProjectActionKind, IconType>> = {
  link: GithubIcon,
  invitation: MailCheck,
  deleted: TriangleAlert,
  notAccepted: CircleSlash,
};

/** "Due {date} · {time} left" while the deadline is ahead, "Closed {ago}" once it has passed. */
function deadlineText(deadlineAt: string, now: number, locale: "en" | "fr", t: TFunction): string {
  if (Date.parse(deadlineAt) > now) return `${t("shome.dueAt", { when: isoDateTime(deadlineAt) })} · ${leftLine(deadlineAt, now, t)}`;
  return t("sproj.closed", { when: relativeTime(deadlineAt, now, locale, t) });
}

/**
 * The facts of a project, as `MetaItem`s (merge task M3-14l), ONE definition
 * for the card and the project page's header: the start while it waits, else
 * the deadline (with the time left, or how long ago it closed); on the card
 * (`withState`), what the state adds — an invitation to accept, a repository
 * GitHub lost, a project never accepted — and, to a read-only reader, why
 * there is no button; then, once the repository is ready, the commit the
 * work stands on, its CI badge ONLY when a run exists, and the indicative
 * score (a lock when frozen at the deadline; none once released, N-SEC-21).
 */
export function ProjectMeta({
  project,
  facts,
  work,
  now,
  group,
  readOnly = false,
  withState = false,
}: {
  project: Pick<StudentProjectCard, "startAt" | "deadlineAt">;
  facts: ProjectFacts;
  work: StudentProjectWork | null;
  now: number;
  group?: StudentActivityGroup;
  readOnly?: boolean;
  withState?: boolean;
}) {
  const t = useT();
  const { locale } = useI18n();
  const upcoming = group === "upcoming" || Date.parse(project.startAt) > now;
  const kind = projectActionKind(facts, now);
  const stateKey = withState && !upcoming ? STATE_KEY[kind] : undefined;
  const StateIcon = STATE_ICON[kind] ?? CircleSlash;
  const commit = work?.lastCommit ?? null;
  const frozen = work?.score?.frozen ?? false;
  const afterDeadline = Date.parse(project.deadlineAt) <= now || frozen;
  return (
    <>
      {upcoming ? (
        <MetaItem icon={CalendarClock}>{startsLine(project.startAt, now, t)}</MetaItem>
      ) : (
        <MetaItem icon={CalendarClock}>{deadlineText(project.deadlineAt, now, locale, t)}</MetaItem>
      )}
      {stateKey ? <MetaItem icon={StateIcon}>{t(stateKey)}</MetaItem> : null}
      {work && !upcoming ? (
        <MetaItem icon={GitCommitHorizontal} label={t(afterDeadline ? "sproj.commit.evaluated" : "sproj.commit.last")}>
          {commit ? (
            <span className="inline-flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-fg">{shortSha(commit.sha)}</span>
              {commit.at ? <span>{isoDateTime(commit.at)}</span> : null}
              {work.commits > 0 ? <span>{work.commits === 1 ? t("sproj.commits.one") : t("sproj.commits", { n: work.commits })}</span> : null}
            </span>
          ) : (
            t("sproj.commit.none")
          )}
        </MetaItem>
      ) : null}
      {work && !upcoming && work.ciStatus !== "none" ? <CiBadge status={work.ciStatus} /> : null}
      {work?.score ? (
        <MetaItem icon={frozen ? Lock : Gauge} {...(frozen ? { label: t("sproj.score.frozen") } : {})}>
          <span className="font-semibold tabular-nums text-fg">{scorePoints(work.score.points, work.score.max)}</span>{" "}
          {t("sgrades.indicative")}
        </MetaItem>
      ) : null}
      {withState && readOnly ? <MetaItem icon={Eye}>{t("sproj.readOnly")}</MetaItem> : null}
    </>
  );
}

/**
 * The row. `primary` is the page's word on the accent: the home lights every
 * open card, the classroom page its most urgent one; a ready project never
 * takes it, whatever the page says. Upcoming carries no button, as every
 * card of that group (DESIGN.md, "Coming up"): the page offers Link GitHub
 * there.
 */
export function ProjectRow({
  card,
  group,
  now,
  navigate,
  primary = false,
  showWhere = true,
}: {
  card: StudentProjectCard;
  group: StudentActivityGroup;
  now: number;
  navigate: Navigate;
  primary?: boolean;
  showWhere?: boolean;
}) {
  const t = useT();
  const readOnly = useStudentReadOnly(true);
  const facts = factsOfCard(card);
  const action = useProjectAction(facts, { now, primary, readOnly });
  const route = { view: "project", id: card.id } as const;
  return (
    <ActivityRow
      kind={{ label: t("activities.kind.project"), icon: FolderGit2 }}
      title={card.title}
      link={{ href: routeToPath(route), onNavigate: () => navigate(route) }}
      where={showWhere ? `${card.courseCode} · ${card.classroomName}` : undefined}
      status={group === "upcoming" ? undefined : projectStatus(card.status, t)}
      meta={<ProjectMeta project={card} facts={facts} work={card.work} now={now} group={group} readOnly={readOnly} withState />}
      action={group === "upcoming" ? undefined : (action ?? undefined)}
    />
  );
}
