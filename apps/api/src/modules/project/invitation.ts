/**
 * The staff's resend of a student's invitation (F-PROJ-07; merge task
 * M3-08b, product owner's decision 5 of 2026-10-02): on a live repository
 * (`409 repo_unavailable` otherwise), at most once a minute per repository
 * (`429 resend_too_soon`, claimed on the row before GitHub is called and
 * given back when GitHub's part fails — kept when GitHub found nobody out),
 * with the `push` permission and never more (N-SEC-21), audited
 * `project_repo.invite_resent`. An individual repository's invitation must
 * be PENDING (`409 invitation_not_pending`); a group's, pending or accepted
 * (ADR-070's amendment of 2026-11-19).
 *
 * The student is named by the login GitHub knows TODAY for the immutable
 * account id they linked (`linkedLogin`, as Accept does): a stored login
 * renamed away may belong to somebody else now, who would be invited with
 * push. Apart from the reconciliation's daily re-invite (M3-06), which
 * reads none of this: two paths, one rule each.
 *
 * The student's own resend is the project's student view's (M3-09).
 *
 * Whom (M3-15b): the repository's readers (`repoMembers`) — an
 * individual repository's student seat (none: `409 repo_unavailable`), a
 * group's members of the copy, never `project_repos.user_id` (N-SEC-20).
 * The staff's resend on a group's re-invites the members still out
 * (`stillOut`; none: `409 invitation_not_pending`); a member whose account
 * cannot be invited is skipped. A student's own resend invites them alone,
 * on a group's repository only while they are out. Each invitation goes
 * through `inviteAccount` (recorded first, what a departure revokes). Only
 * an individual repository's row follows GitHub's answer: a group's
 * resend never writes the group's row.
 */
import { and, eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import type { FastifyBaseLogger } from "fastify";

import type { ProjectInvitationResent, SentInvitation } from "@quiz/contracts";

import { audit, type AuditActor } from "../../audit.js";
import { iso } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { projectRepos } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { projectInstallation } from "../github/service.js";
import { inviteAccount, notRecorded } from "./access.js";
import { liveRepoForUpdate } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { repoMembers, type RepoMember } from "./groupRepos.js";
import { checkGrants, liveGrants } from "./memberAccess.js";
import type { RepoRow } from "./repos.js";

/** The least time between two resends of one repository's invitation. */
export const RESEND_INTERVAL_MS = 60_000;

/**
 * The members of a repository still out of it: no live grant of
 * theirs known in (`accepted_at`, which the `member` webhook's `removed`
 * clears), and none found in by the check of their other grants
 * (`checkGrants`, which records what it found on each) — invited and
 * waiting, or gone (expired or declined).
 */
async function stillOut(db: Db, octokit: Octokit, repo: RepoRow, members: RepoMember[], now: Date): Promise<RepoMember[]> {
  const grants = await liveGrants(db, repo.id);
  const { joined } = await checkGrants(db, octokit, repo.fullName!, grants, now);
  const inside = new Set([...grants.filter((g) => g.acceptedAt !== null), ...joined].map((g) => g.enrollmentId));
  return members.filter((m) => !inside.has(m.enrollmentId));
}

/**
 * `POST /app/api/projects/:id/repos/:rid/invite`: the invitation sent
 * again, `invitationStatus` as GitHub answered (`accepted` when the student
 * already is a collaborator: an individual repository's row follows).
 * `only`: the student's own resend, by their seat.
 */
export async function resendInvitation(
  db: Db,
  config: AppConfig,
  projectId: string,
  repoId: string,
  actor: AuditActor,
  now: Date,
  log: FastifyBaseLogger,
  only?: string,
): Promise<ProjectInvitationResent> {
  // The minute claimed on the row before GitHub is called.
  const { project, repo } = await db.transaction(async (tx) => {
    const found = await liveRepoForUpdate(tx, projectId, repoId);
    // A group's row speaks for none of its members (one is in: `accepted`): they are looked at on GitHub below.
    const status = found.repo.invitationStatus;
    if (found.repo.groupId === null ? status !== "pending" : status === "none") {
      throw new ProjectError("invitation_not_pending", "The invitation is not pending");
    }
    if (found.repo.invitationResentAt !== null && now.getTime() - found.repo.invitationResentAt.getTime() < RESEND_INTERVAL_MS) {
      throw new ProjectError("resend_too_soon", "The invitation was resent less than a minute ago");
    }
    await tx.update(projectRepos).set({ invitationResentAt: now }).where(eq(projectRepos.id, found.repo.id));
    return found;
  });

  // GitHub's part: a failure here means the resend did not happen, and the
  // minute is given back — not when GitHub found nobody out, which would
  // let a member already in ask GitHub again and again.
  const invited: { login: string; invitation: SentInvitation }[] = [];
  try {
    const org = await projectInstallation(db, project.orgId);
    if (!org) throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");
    const { octokit } = await installationClient(config, org.installationId);
    const members = await repoMembers(db, repo, project.classroomId);
    const readers = only === undefined ? members : members.filter((m) => m.enrollmentId === only);
    if (readers.length === 0) throw new ProjectError("repo_unavailable", "The repository has no student on the roster to invite");
    // Checked for both kinds (an expired invitation cancelled first); a student's own repository re-invites its reader whatever the check found.
    const out = await stillOut(db, octokit, repo, readers, now);
    const targets = repo.groupId === null ? readers : out;
    if (targets.length === 0) throw new ProjectError("invitation_not_pending", only === undefined ? "Every member of the group is in" : "You already are in");
    const group = repo.groupId !== null && only === undefined;
    const stale = new ProjectError("github_account_stale", "The student's GitHub account is gone or renamed: they must relink it");
    let refusal: unknown = stale;
    for (const member of targets) {
      try {
        if (member.account === null) throw stale;
        const ctx = { actor, now, log, via: "resend", failure: "invite_failed" } as const;
        const done = await inviteAccount(db, octokit, repo, { ...member, account: member.account }, ctx);
        if (!notRecorded(done)) invited.push(done);
      } catch (err) {
        // A group's member whose account cannot be invited is skipped; GitHub failing fails the resend.
        if (!group || !(err instanceof ProjectError && err.code === "github_account_stale")) throw err;
        refusal = err;
      }
    }
    if (invited.length === 0) throw refusal;
  } catch (err) {
    if (err instanceof ProjectError && err.code === "invitation_not_pending") throw err;
    await db
      .update(projectRepos)
      .set({ invitationResentAt: repo.invitationResentAt })
      .where(and(eq(projectRepos.id, repo.id), eq(projectRepos.invitationResentAt, now)));
    throw err;
  }

  // GitHub accepted: an individual repository's row follows its answer; a
  // group's is left as it is (the `member` webhook's). Audited with it.
  const invitationStatus = invited.some((i) => i.invitation === "pending") ? "pending" : "accepted";
  await db.transaction(async (tx) => {
    if (repo.groupId === null) {
      await tx.update(projectRepos).set({ invitationStatus }).where(eq(projectRepos.id, repo.id));
    }
    await audit(tx, {
      ...actor,
      action: "project_repo.invite_resent",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { logins: invited.map((i) => i.login), invitationStatus },
    });
  });
  return { invitationStatus, resentAt: iso(now) };
}
