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

import type { StudentActivityGroup } from "@quiz/domain";
import type { ProjectAcceptance, StudentProjectCard } from "@quiz/contracts";

import { api, useMe } from "../api";
import { githubLinkHref } from "../github/api";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { studentRootKey } from "../queryKeys";
import { routeToPath, type Navigate } from "../router";
import { ActivityRow, leftLine, startsLine, type RowAction } from "./ActivityRow";
import {
  ACCENT_KINDS,
  factsOfCard,
  invitationHref,
  PROJECT_STATUS_KEY,
  projectActionKind,
  REREAD_REFUSALS,
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
      ? { label: t("sproj.openInvitation"), primary: accent, href: invitationHref(facts.repo.url), external: true }
      : { label: t("sproj.openRepo"), href: facts.repo.url, external: true };
  }
  if (kind === "link") {
    return { label: t("github.link"), primary: accent, href: githubLinkHref(window.location.pathname) };
  }
  if (kind === "accept") {
    return studentRefusalCode(accept.error) === "github_account_stale"
      ? { label: t("sproj.relink"), primary: accent, href: githubLinkHref(window.location.pathname) }
      : {
          label: t(accept.isPending ? "sproj.accepting" : "sproj.accept"),
          primary: accent,
          loading: accept.isPending,
          onClick: () => accept.mutate(),
        };
  }
  return null;
}

/**
 * The line of a project card: the start while it waits; its status, then
 * the deadline it counts down to while it runs, then what the state adds —
 * an invitation to accept, a repository GitHub lost, a project never
 * accepted (F-PROJ-04). A read-only reader is told why there is no button.
 */
export function projectLine(
  card: StudentProjectCard,
  group: StudentActivityGroup,
  now: number,
  readOnly: boolean,
  t: TFunction,
): string {
  const parts: string[] = [];
  if (group === "upcoming") parts.push(startsLine(card.startAt, now, t));
  else {
    parts.push(t(PROJECT_STATUS_KEY[card.status]));
    if (group === "open") parts.push(leftLine(card.deadlineAt, now, t));
    const key = STATE_KEY[projectActionKind(factsOfCard(card), now)];
    if (key) parts.push(t(key));
  }
  if (readOnly) parts.push(t("sproj.readOnly"));
  return parts.join(" · ");
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
  const action = useProjectAction(factsOfCard(card), { now, primary, readOnly });
  const route = { view: "project", id: card.id } as const;
  return (
    <ActivityRow
      title={card.title}
      link={{ href: routeToPath(route), onNavigate: () => navigate(route) }}
      where={showWhere ? `${card.courseCode} · ${card.classroomName}` : undefined}
      line={projectLine(card, group, now, readOnly, t)}
      badge={{ label: t("activities.kind.project"), accent: false }}
      action={group === "upcoming" ? undefined : (action ?? undefined)}
    />
  );
}
