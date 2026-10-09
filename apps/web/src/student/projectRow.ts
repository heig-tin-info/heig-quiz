/*
 * The rules of a student's project row and page (F-PROJ-04, F-PROJ-05,
 * F-PROJ-07, F-PROJ-15; merge task M3-13; `docs/merge/05-web.md` §5.3),
 * pure: which one action a project offers in its state, what its line says
 * beside the status, and the words of each refusal of Accept and Resend.
 * `ProjectRow.tsx` and `StudentProjectPage.tsx` draw them.
 */
import type {
  ProjectAcceptErrorCode,
  ProjectErrorCode,
  SentInvitation,
  StudentProject,
  StudentProjectCard,
  StudentProjectStatus,
} from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { Lock } from "lucide-react";

import { refusalCodeOf, wordedRefusal } from "../api";
import type { Dict, TFunction } from "../i18n";
import type { IconType, Tone } from "../ui";

/**
 * What the row and the page both know of a project: the card's facts, and
 * the student's repository as far as each payload tells it — live with its
 * invitation, or lost on GitHub (`deleted`), or none yet. A card names the
 * repository only while it is live, so a card whose project is in progress
 * without a repository is one GitHub lost; the page says it outright.
 */
export interface ProjectFacts {
  id: string;
  status: StudentProjectStatus;
  startAt: string;
  githubLinked: boolean;
  /** `invitation` null: nobody is invited (an `online_seb` project, ADR-047 §2). */
  repo: { state: "live"; url: string; invitation: SentInvitation | null } | { state: "deleted" } | null;
}

export function factsOfCard(card: StudentProjectCard): ProjectFacts {
  const { id, status, startAt, githubLinked } = card;
  const repo: ProjectFacts["repo"] =
    // A live repository names its URL; its invitation is null when nobody is
    // invited (an `online_seb` project, ADR-047 §2), never a sign it was lost.
    card.repoUrl !== null
      ? { state: "live", url: card.repoUrl, invitation: card.invitation }
      : status === "in_progress"
        ? { state: "deleted" }
        : null;
  return { id, status, startAt, githubLinked, repo };
}

export function factsOfProject(p: StudentProject): ProjectFacts {
  const { id, status, startAt, githubLinked } = p;
  const repo: ProjectFacts["repo"] = p.repo
    ? p.repo.deleted
      ? { state: "deleted" }
      : { state: "live", url: p.repo.url, invitation: p.repo.invitation }
    : null;
  return { id, status, startAt, githubLinked, repo };
}

/**
 * The one thing a project offers its student, by state — the four states of
 * §5.3 and the three that offer nothing:
 *   - `deleted`: the repository is gone from GitHub; nothing is made again
 *     (F-PROJ-05), the line says so;
 *   - `invitation`: the repository exists and the invitation waits on GitHub;
 *   - `open`: the repository is theirs, locked or not;
 *   - `notAccepted`: the project closed before they accepted it;
 *   - `link`: no linked GitHub account — linking is the step before Accept;
 *   - `notStarted`: linked, nothing to accept until the start;
 *   - `accept`: linked, the project open, no repository yet.
 */
export type ProjectActionKind = "link" | "accept" | "notStarted" | "invitation" | "open" | "notAccepted" | "deleted";

export function projectActionKind(facts: ProjectFacts, now: number): ProjectActionKind {
  if (facts.repo?.state === "deleted") return "deleted";
  if (facts.repo) return facts.repo.invitation === "pending" ? "invitation" : "open";
  if (facts.status === "locked" || facts.status === "released") return "notAccepted";
  if (!facts.githubLinked) return "link";
  return Date.parse(facts.startAt) > now ? "notStarted" : "accept";
}

/** The kinds whose button may wear the page's accent: a step the student has to take. A ready project never does. */
export const ACCENT_KINDS: ReadonlySet<ProjectActionKind> = new Set(["link", "accept", "invitation"]);

/** Whether the project still needs something from the student: what `mostUrgent` ranks a project by. */
export const needsStudentAction = (card: StudentProjectCard, now: number): boolean =>
  ACCENT_KINDS.has(projectActionKind(factsOfCard(card), now));

/** A score as the card and the page write it: "7.5 / 10", or the points alone without a maximum. */
export const scorePoints = (points: number, max: number | null): string =>
  max === null ? formatPoints(points) : `${formatPoints(points)} / ${formatPoints(max)}`;

/** The page on GitHub where a pending invitation is accepted. */
export const invitationHref = (repoUrl: string): string => `${repoUrl}/invitations`;

/** The status word of a student's project (F-PROJ-04). */
export const PROJECT_STATUS_KEY = {
  to_accept: "sproj.status.to_accept",
  in_progress: "sproj.status.in_progress",
  locked: "sproj.status.locked",
  released: "sproj.status.released",
} as const satisfies Record<StudentProjectStatus, keyof Dict>;

/**
 * The status badge's tone, from the one rule of the student's cards: green is
 * under way or done, amber waits on the student, zinc is closed or neutral.
 */
export const PROJECT_STATUS_TONE: Record<StudentProjectStatus, { tone: Tone; icon?: IconType }> = {
  to_accept: { tone: "amber" },
  in_progress: { tone: "green" },
  locked: { tone: "zinc", icon: Lock },
  released: { tone: "green" },
};

/** The states that say something beside the deadline; the others' button says it all. */
export type StateKind = "link" | "invitation" | "deleted" | "notAccepted";

export const hasState = (kind: ProjectActionKind): kind is StateKind => Object.hasOwn(STATE_KEY, kind);

/**
 * The ONE wording of a state, on the row's line after the status and in the
 * page's repository card alike.
 */
export const STATE_KEY: Record<StateKind, keyof Dict> = {
  link: "sproj.state.link",
  invitation: "sproj.invitation.pending",
  deleted: "sproj.state.deleted",
  notAccepted: "sproj.state.notAccepted",
};

/**
 * The words of the refusals of Accept (`ProjectAcceptErrorCode`) and of the
 * student's Resend (`ProjectErrorCode`, F-PROJ-07). Every one is worded:
 * a student never reads the server's English sentence.
 */
type StudentRefusal = ProjectAcceptErrorCode | Extract<ProjectErrorCode, "resend_too_soon" | "invitation_not_pending" | "repo_unavailable" | "invite_failed">;

const REFUSAL_KEY: Record<StudentRefusal, keyof Dict> = {
  not_started: "sproj.refusal.notStarted",
  deadline_passed: "sproj.refusal.deadlinePassed",
  no_group: "sproj.refusal.noGroup",
  github_not_linked: "sproj.state.link",
  github_account_stale: "sproj.refusal.githubAccountStale",
  app_not_installed: "sproj.refusal.askTeacher",
  distribution_missing: "sproj.refusal.askTeacher",
  provision_in_progress: "sproj.refusal.provisionInProgress",
  repo_name_taken: "sproj.refusal.askTeacher",
  provision_failed: "sproj.refusal.provisionFailed",
  resend_too_soon: "sproj.refusal.resendTooSoon",
  invitation_not_pending: "sproj.refusal.invitationNotPending",
  repo_unavailable: "sproj.refusal.repoUnavailable",
  invite_failed: "sproj.refusal.inviteFailed",
};

/** The refusal's code when the row knows it, else null (a network failure, a 500). */
export function studentRefusalCode(error: unknown): StudentRefusal | null {
  const code = refusalCodeOf(error);
  return code !== null && Object.hasOwn(REFUSAL_KEY, code) ? (code as StudentRefusal) : null;
}

/** What a refused Accept or Resend says: the refusal worded, else the server's message, else `error.save`. */
export const studentRefusalMessage = (error: unknown, t: TFunction): string => wordedRefusal(error, REFUSAL_KEY, t);

/**
 * The refusals after which the row re-reads the project rather than
 * resending: another Accept of the same repository is under way, or the
 * invitation was accepted meanwhile. The screen then shows the state the
 * server has.
 */
export const REREAD_REFUSALS: ReadonlySet<StudentRefusal> = new Set(["provision_in_progress", "invitation_not_pending"]);
