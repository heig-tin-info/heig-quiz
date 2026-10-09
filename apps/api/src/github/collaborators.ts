/**
 * Outside collaborators of a student repository: the one invitation call the
 * provisioning makes, and its reverse for group repositories (issue #2, lot
 * 2), where a member who leaves the group must lose their access for real.
 * Both are idempotent, so a retried request never fails on its own trace.
 */
import type { Octokit } from "octokit";

import type { SentInvitation } from "@quiz/contracts";

import { unless404 } from "./app.js";

export type CollaboratorPermission = "push" | "pull";

/**
 * The login GitHub knows today for the immutable account id we linked.
 * Students rename their account: the stored login then points at nobody, and
 * GitHub refuses any invitation for it with a misleading 403 "Resource not
 * accessible by integration" (seen live 2026-09-25, Prog-A Labo-01). `null`
 * when the account no longer exists; any other failure throws.
 */
export async function currentLogin(octokit: Octokit, githubUserId: number): Promise<string | null> {
  return unless404(async () => {
    const { data } = await octokit.request("GET /user/{account_id}", {
      account_id: githubUserId,
      request: { retries: 0 },
    });
    return data.login;
  });
}

/**
 * True when GitHub refused the invitation itself (403/404 on the
 * collaborators endpoint): the repository was created with the same App
 * permissions, so the refusal points at the student's account, not at the
 * installation.
 */
export function isInvitationRefused(err: unknown): boolean {
  const { status, request } = err as { status?: number; request?: { url?: string } };
  return (status === 403 || status === 404) && /\/collaborators\//.test(request?.url ?? "");
}

/**
 * Invites `login` on `owner/repo`. `pending` when GitHub created an
 * invitation (201), `accepted` when the user already is a collaborator (204).
 */
export async function inviteCollaborator(
  octokit: Octokit,
  owner: string,
  repo: string,
  login: string,
  permission: CollaboratorPermission = "push",
): Promise<SentInvitation> {
  const res = await octokit.request("PUT /repos/{owner}/{repo}/collaborators/{username}", {
    owner,
    repo,
    username: login,
    permission,
  });
  return res.status === 201 ? "pending" : "accepted";
}

/** The pending invitations of `owner/repo`: each one's id and its invitee's login. */
export async function pendingInvitees(octokit: Octokit, owner: string, repo: string): Promise<{ id: number; login: string }[]> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/invitations", { owner, repo, per_page: 100 });
  return data.flatMap((i: { id: number | bigint; invitee?: { login?: string } | null }) =>
    i.invitee?.login ? [{ id: Number(i.id), login: i.invitee.login }] : [],
  );
}

/**
 * Takes every access of `login` away from `owner/repo`: a pending
 * invitation first — cancelled before the seat, so that it cannot be
 * accepted in between and outlive the revocation (removing a collaborator
 * does not cancel an invitation) —, then the collaborator seat. A user who
 * had neither is a no-op, not an error — the revocation may be a replay.
 */
export async function revokeCollaborator(
  octokit: Octokit,
  owner: string,
  repo: string,
  login: string,
): Promise<{ invitationsCancelled: number }> {
  const mine = (await pendingInvitees(octokit, owner, repo)).filter((i) => i.login.toLowerCase() === login.toLowerCase());
  for (const invitation of mine) {
    await octokit.request("DELETE /repos/{owner}/{repo}/invitations/{invitation_id}", {
      owner,
      repo,
      invitation_id: invitation.id,
    });
  }
  try {
    await octokit.request("DELETE /repos/{owner}/{repo}/collaborators/{username}", {
      owner,
      repo,
      username: login,
      request: { retries: 0 },
    });
  } catch (err) {
    // 404: no such collaborator (or a renamed account) — nothing to remove.
    if ((err as { status?: number }).status !== 404) throw err;
  }
  return { invitationsCancelled: mine.length };
}
