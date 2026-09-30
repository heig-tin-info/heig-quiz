/**
 * Group projects (ported from classroom's `groupRepo.ts`, ADR-048): the two
 * pure rules the server applies around group repositories.
 *
 * - `groupRepoName`: what the group repository is called on GitHub.
 * - `pickStudentRepo`: which repository a student's line reads, when a
 *   project can hold both a group repository and — a leftover from before
 *   acceptance knew about groups — an individual one.
 */
import { repoName } from "./repoName.js";

/**
 * `<project-slug>-<group-slug>`, capped at GitHub's limit (both slugs are
 * already `[a-z0-9-]`, up to `SLUG_MAX` characters each). `disambiguator` is
 * appended when that name is already taken by another repository of the
 * organization (two classrooms of the same organization with the same
 * project slug both have a `group-1`); it survives the cap, the stem is what
 * gets shortened.
 */
export function groupRepoName(projectSlug: string, groupSlug: string, disambiguator?: string): string {
  return repoName(`${projectSlug}-${groupSlug}`, disambiguator);
}

/** The fields of a student repository row the rules below read. */
export interface RepoLifeLike {
  groupId: string | null;
  provisionStatus: string;
  fullName: string | null;
  deletedAt: Date | string | null;
}

/**
 * A live individual repository: provisioned, named, not deleted, no group.
 * In a group project it can only be a leftover, created before acceptance
 * knew about groups — and its student keeps working in it. The ONE
 * definition of that "holder": the read views, the acceptance, the
 * invitations and the e-mails all ask this predicate, so a failed or pending
 * row never holds a student out of their group's repository in one place
 * while another place already invited them into it.
 */
export function isLiveIndividualRepo(r: RepoLifeLike): boolean {
  return r.groupId === null && r.provisionStatus === "ok" && r.fullName !== null && r.deletedAt === null;
}

/**
 * The repository a student's line reads on a project. `own` is the student's
 * individual repository (no group), `group` the repository of their group. A
 * live individual repository wins (see `isLiveIndividualRepo`); a failed,
 * pending or deleted one gives way to the group repository, and with no
 * group repository it is still shown, so its state stays visible.
 */
export function pickStudentRepo<R extends RepoLifeLike>(own: R | undefined, group: R | undefined): R | undefined {
  if (own && isLiveIndividualRepo(own)) return own;
  return group ?? own;
}
