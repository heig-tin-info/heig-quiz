/**
 * The commit graph of one repository on the grading screen (ADR-119 §8,
 * card L-06e): the handed-out branches' commits with their parents, git's
 * declared author, date and message, the receipt time when the platform has
 * one (`push_receipts`), the App's commits (`bot_commits`) and the
 * handed-out ones (reachable from the distribution's heads) marked, and
 * each commit's linked member when GitHub matched it to a GitHub account
 * the platform knows (`github_accounts`) — a colour on the screen, never a
 * proof: the declared author is free text.
 *
 * STAFF ONLY (N-SEC-20): the route loads the repository through
 * `staffAccess` (invariant 6). Read on demand through the App and cached
 * as the live state (`readCommitListing`), never stored, never sent to the
 * model, never in a student's payload. GitHub failing answers
 * `unavailable` — no message, no URL (invariant 15).
 */
import { asc, eq, sql, type AnyColumn } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import type { ProjectCommitGraph } from "@quiz/contracts";
import { commitReceiptTimes, reachableCommits } from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { botCommits, enrollments, githubAccounts, projectGroupMembers, pushReceipts, users } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { readCommitListing } from "../../github/commitGraph.js";
import { isRateLimited } from "../../github/metrics.js";
import { projectInstallation } from "../github/service.js";
import type { RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

type Member = { name: string; login: string | null; githubUserId: number | null };

/** The repository's linked students, by name: a group's every member, or the student whose repository it is. */
async function membersOf(db: Db, repo: RepoRow): Promise<Member[]> {
  if (repo.groupId !== null) {
    return db
      .select({ name: sqlName(enrollments.prenom, enrollments.nom), login: githubAccounts.login, githubUserId: githubAccounts.githubUserId })
      .from(projectGroupMembers)
      .innerJoin(enrollments, eq(enrollments.id, projectGroupMembers.enrollmentId))
      .leftJoin(githubAccounts, eq(githubAccounts.userId, enrollments.userId))
      .where(eq(projectGroupMembers.groupId, repo.groupId))
      .orderBy(asc(enrollments.nom), asc(enrollments.prenom));
  }
  return db
    .select({ name: sqlName(users.givenName, users.familyName), login: githubAccounts.login, githubUserId: githubAccounts.githubUserId })
    .from(users)
    .leftJoin(githubAccounts, eq(githubAccounts.userId, users.id))
    .where(eq(users.id, repo.userId));
}

/** `given family`, as one column. */
const sqlName = (given: AnyColumn, family: AnyColumn) => sql<string>`trim(${given} || ' ' || ${family})`;

/** A date GitHub gave, as the contract's ISO string; null when absent or unreadable. */
const isoDate = (value: string | null) => {
  const ms = value === null ? NaN : Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** `GET /app/api/projects/:id/repos/:rid/commits`: the graph, or why there is none. */
export async function repoCommitGraph(
  db: Db,
  config: AppConfig,
  project: ProjectRow,
  repo: RepoRow,
  log: FastifyBaseLogger,
): Promise<ProjectCommitGraph> {
  if (repo.fullName === null || repo.githubRepoId === null || repo.deletedAt !== null) return { status: "unavailable", reason: "no_repo" };
  const unavailable: ProjectCommitGraph = { status: "unavailable", reason: "github" };
  const org = await projectInstallation(db, project.orgId);
  if (!org || isRateLimited(org.installationId)) return unavailable;
  let read;
  try {
    const { octokit } = await installationClient(config, org.installationId);
    read = await readCommitListing(octokit, org.installationId, repo.fullName, undefined, project.branches, project.distributionFullName);
  } catch (err) {
    log.warn({ err, repo: repo.id }, "project commit graph: GitHub read failed");
    return unavailable;
  }
  const listing = read.state;
  if (!listing) return unavailable;

  const [members, receipts, appCommits] = await Promise.all([
    membersOf(db, repo),
    db.select({ headSha: pushReceipts.headSha, receivedAt: pushReceipts.receivedAt }).from(pushReceipts).where(eq(pushReceipts.githubRepoId, repo.githubRepoId)),
    db.select({ sha: botCommits.sha }).from(botCommits).where(eq(botCommits.repoId, repo.id)),
  ]);
  const received = commitReceiptTimes(listing.commits, receipts);
  const handedOut = reachableCommits(listing.commits, listing.handedOut);
  const app = new Set(appCommits.map((c) => c.sha));
  const memberOf = new Map(members.flatMap((m, i) => (m.githubUserId === null ? [] : [[m.githubUserId, i] as const])));
  return {
    status: "ok",
    branches: listing.branches,
    members: members.map(({ name, login }) => ({ name, login })),
    commits: listing.commits.map((c) => ({
      sha: c.sha,
      parents: c.parents,
      message: c.message,
      authorName: c.authorName,
      authoredAt: isoDate(c.authoredAt),
      member: c.accountId === null ? null : (memberOf.get(c.accountId) ?? null),
      receivedAt: received.get(c.sha)?.toISOString() ?? null,
      mark: app.has(c.sha) ? "app" : handedOut.has(c.sha) ? "handout" : null,
    })),
    truncated: listing.truncated,
    stale: read.stale,
  };
}
