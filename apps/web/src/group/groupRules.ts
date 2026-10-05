/*
 * The group sets' rules on the web side (ADR-070, M3-16a), pure: where a
 * student is, the optimistic move, the words of a refusal, the sizes a
 * random formation would make, and (M3-16b) the GitHub consequences of a
 * write as its confirmation lists them. `GroupSetPage.tsx`,
 * `GroupBoard.tsx` and `ConsequencesDialog.tsx` draw them.
 */
import {
  GroupConsequences,
  GroupErrorCode,
  GroupRefusalProjects,
  type GroupConsequence,
  type GroupRemainder,
  type GroupSetDetail,
  type GroupStudent,
} from "@quiz/contracts";
import { groupSizes } from "@quiz/domain";

import { ApiError, refusalCodeOf } from "../api";
import type { Dict, TFunction } from "../i18n";

/** A student as the board writes them: family name first, like the roster and the project page. */
export const studentName = (s: Pick<GroupStudent, "nom" | "prenom">): string => `${s.nom} ${s.prenom}`;

/** The group `enrollmentId` is in (its id), `null` when in none, `undefined` when not a student of the set. */
export function placeOf(detail: GroupSetDetail, enrollmentId: string): string | null | undefined {
  if (detail.unplaced.some((s) => s.enrollmentId === enrollmentId)) return null;
  return detail.groups.find((g) => g.members.some((s) => s.enrollmentId === enrollmentId))?.id;
}

/** The student of the set `enrollmentId` names, wherever they are. */
export function studentOf(detail: GroupSetDetail, enrollmentId: string): GroupStudent | undefined {
  return [...detail.unplaced, ...detail.groups.flatMap((g) => g.members)].find((s) => s.enrollmentId === enrollmentId);
}

const byName = (a: GroupStudent, b: GroupStudent) => studentName(a).localeCompare(studentName(b));

/**
 * The set with `enrollmentId` moved into `groupId` (`null`: out of every
 * group), as the server will answer it: a list keeps its name order. The
 * optimistic step of a move, replaced by the server's answer.
 */
export function withMove(detail: GroupSetDetail, enrollmentId: string, groupId: string | null): GroupSetDetail {
  const student = studentOf(detail, enrollmentId);
  if (!student || (groupId !== null && !detail.groups.some((g) => g.id === groupId))) return detail;
  const without = (list: GroupStudent[]) => list.filter((s) => s.enrollmentId !== enrollmentId);
  const into = (list: GroupStudent[]) => [...without(list), student].sort(byName);
  return {
    ...detail,
    unplaced: groupId === null ? into(detail.unplaced) : without(detail.unplaced),
    groups: detail.groups.map((g) => ({ ...g, members: g.id === groupId ? into(g.members) : without(g.members) })),
  };
}

/** A group whose members outnumber the set's maximum size: a warning, never a refusal (ADR-070 §3). */
export const overMax = (members: number, maxSize: number | null): boolean => maxSize !== null && members > maxSize;

// ---------------------------------------------------------------- the random formation

/** The sizes of the new groups, largest first, counted: 23 by 3, smaller → [{3: 7}, {2: 1}]. */
export function sizesSummary(n: number, size: number, remainder: GroupRemainder): { size: number; count: number }[] {
  if (n < 1 || size < 1 || size > n) return [];
  const counts = new Map<number, number>();
  for (const s of groupSizes(n, size, remainder)) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => b - a).map(([s, count]) => ({ size: s, count }));
}

/** The size the random formation opens on: the set's maximum, else pairs — never more than the students to place. */
export const defaultRandomSize = (unplaced: number, maxSize: number | null): number =>
  Math.max(1, Math.min(maxSize ?? 2, unplaced));

// ---------------------------------------------------------------- the board's keyboard

/**
 * The zone the keyboard lands on from `from` (an index into the zones in
 * their reading order — No group, then each group): the next one for →
 * and ↓, the previous one for ← and ↑, held at the ends. `null` for any
 * other key. The board's keyboard drag is this walk.
 */
export function stepZone(count: number, from: number, code: string): number | null {
  const step = code === "ArrowRight" || code === "ArrowDown" ? 1 : code === "ArrowLeft" || code === "ArrowUp" ? -1 : 0;
  if (step === 0 || count === 0) return null;
  return Math.min(count - 1, Math.max(0, from + step));
}

// ---------------------------------------------------------------- refusals

/** The words of each refusal of the group routes, by code. */
const REFUSAL_KEY: Record<GroupErrorCode, keyof Dict> = {
  classroom_archived: "groups.refusal.classroomArchived",
  set_in_use: "groups.refusal.setInUse",
  duplicate_name: "groups.refusal.duplicateName",
  nobody_to_place: "groups.refusal.nobodyToPlace",
  size_out_of_range: "groups.refusal.sizeOutOfRange",
  has_repo: "groups.refusal.hasRepo",
  needs_confirmation: "groups.refusal.needsConfirmation",
  max_size_required: "groups.refusal.maxSizeRequired",
  set_closed: "groups.refusal.setClosed",
  set_frozen: "groups.refusal.setFrozen",
  group_full: "groups.refusal.groupFull",
};

/**
 * A write refused while a confirmation waits (M3-16b): the queue of the set
 * holds every later write rather than send it over a move the server has
 * not applied yet. Worded, never sent.
 */
export class WriteHeld extends Error {
  constructor() {
    super("A change waits for its confirmation");
    this.name = "WriteHeld";
  }
}

/** A group, a student or a set out of reach: the 404 of a missing one (another teacher deleted it, say). */
export const gone = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/**
 * What a failed write of a set says, always in the reader's language: the
 * refusal worded; a 404 as what it is from here, something no longer in
 * the set; anything else the generic failure (the server's own message is
 * English).
 */
export function groupRefusalMessage(error: unknown, t: TFunction): string {
  if (error instanceof WriteHeld) return t("groups.confirm.held");
  const code = GroupErrorCode.safeParse(refusalCodeOf(error));
  if (code.success) {
    const max = error instanceof ApiError ? (error.body as { max?: unknown } | null)?.max : undefined;
    return t(REFUSAL_KEY[code.data], { max: typeof max === "number" ? max : "" });
  }
  return t(gone(error) ? "groups.gone" : "error.save");
}

/** The refusals that name every project concerned (`GroupRefusalProjects`). */
export type ProjectsRefusal = { code: "set_in_use" | "has_repo"; projects: GroupRefusalProjects["projects"] };

/**
 * `409 set_in_use` (the projects that are not archived and name the set)
 * and `409 has_repo` (the following projects whose copy's group already
 * has a repository, M3-15b-1), with their projects; null for anything
 * else.
 */
export function projectsRefusal(error: unknown): ProjectsRefusal | null {
  const code = refusalCodeOf(error);
  if ((code !== "set_in_use" && code !== "has_repo") || !(error instanceof ApiError)) return null;
  const parsed = GroupRefusalProjects.safeParse(error.body);
  return { code, projects: parsed.success ? parsed.data.projects : [] };
}

// ---------------------------------------------------------------- GitHub consequences (ADR-070 §6, M3-16b)

/**
 * The consequences a `409 needs_confirmation` names (a set's write, or
 * *Resync with the set*), with the digest to send back; null for any other
 * error. The client never guesses them (ADR-070 §6).
 */
export function needsConfirmation(error: unknown): GroupConsequences | null {
  if (!(error instanceof ApiError) || refusalCodeOf(error) !== "needs_confirmation") return null;
  const parsed = GroupConsequences.safeParse(error.body);
  return parsed.success ? parsed.data : null;
}

/** One repository a confirmation names: who loses it, who joins it. `repo` null: its first provisioning runs. */
export interface RepoConsequences {
  key: string;
  repo: string | null;
  groupName: string;
  frozen: boolean;
  lose: string[];
  join: string[];
}

/** One project a confirmation names, its repositories in the order the server listed them. */
export interface ProjectConsequences {
  projectId: string;
  projectName: string;
  repos: RepoConsequences[];
}

/**
 * The consequences grouped as the dialog lists them: by project, then by
 * repository (a group's, by its copy group — a repository being created has
 * no name yet), then the students losing it and joining it, by name.
 */
export function consequencesByProject(consequences: readonly GroupConsequence[]): ProjectConsequences[] {
  const projects = new Map<string, ProjectConsequences>();
  for (const c of consequences) {
    let project = projects.get(c.projectId);
    if (!project) {
      project = { projectId: c.projectId, projectName: c.projectName, repos: [] };
      projects.set(c.projectId, project);
    }
    const key = `${c.groupId}:${c.repo ?? ""}`;
    let repo = project.repos.find((r) => r.key === key);
    if (!repo) {
      repo = { key, repo: c.repo, groupName: c.groupName, frozen: c.frozen, lose: [], join: [] };
      project.repos.push(repo);
    }
    repo.frozen ||= c.frozen;
    repo[c.kind].push(studentName(c));
  }
  for (const project of projects.values()) {
    for (const repo of project.repos) {
      repo.lose.sort((a, b) => a.localeCompare(b));
      repo.join.sort((a, b) => a.localeCompare(b));
    }
  }
  return [...projects.values()];
}

/**
 * What *Resync with the set* names first (ADR-070's second and fourth
 * amendments): the distinct frozen repositories it touches after their
 * deadline, then the arrivals into a group without a repository once
 * Accept is closed (R3: the student will have no repository), then the
 * rest, by repository.
 */
export function resyncSections(consequences: readonly GroupConsequence[]): {
  frozenRepos: string[];
  noRepo: { name: string; groupName: string }[];
  rest: RepoConsequences[];
} {
  const frozenRepos = [...new Set(consequences.flatMap((c) => (c.frozen && c.repo !== null ? [c.repo] : [])))].sort();
  const noRepo = consequences
    .filter((c) => c.acceptClosed)
    .map((c) => ({ name: studentName(c), groupName: c.groupName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rest = consequencesByProject(consequences.filter((c) => !c.acceptClosed)).flatMap((p) => p.repos);
  return { frozenRepos, noRepo, rest };
}
