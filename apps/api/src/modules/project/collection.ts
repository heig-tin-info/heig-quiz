/**
 * The online workspace collected at the deadline (ADR-130), the deadline
 * job's first step on a project (`jobs.ts`): the collections a crash left
 * unsettled are settled first, then every repository due
 * ({@link COLLECTION_DUE}) is claimed, ordered from the portal (`codespace`
 * module), checked, signed and moved onto its branch — and the job locks or
 * commits as before, whatever came of it. Each outcome is recorded and
 * audited (`project_repo.workspace_collected`).
 *
 * The rules it holds, in order:
 *
 *  - in a `hybrid` project the last writer wins (ADR-149 §2,
 *    `collectsWorkspace`): the branch's head and every push received,
 *    newest first, the neutral ones skipped (a bot's, GitHub's web
 *    interface's); when the first other one is a machine's
 *    ({@link machineHead}) — before the order, or as the head the commit
 *    meets after a 422 — nothing is collected but `last_push_local`;
 *  - an order leaves only within `COLLECTION_ORDER_WINDOW_MS` of the
 *    effective deadline, judged on Quiz's clock right before it is sent,
 *    which also dates its token (§5): later, `too_late`;
 *  - the branch is `collectionBranch` of the student's last push by the
 *    deadline, which is also the target when it is on that branch;
 *  - the portal is sent the project's protected files as stored: it alone
 *    applies `collectionKeptPaths` (the contract says so);
 *  - before signing, Quiz checks that the commit on the temporary ref is the
 *    reported tree on the base, and, before each commit, that every entry
 *    under the kept paths is the head's it goes on (§4.3): otherwise
 *    `check_refused`, nothing signed — a staff push to a protected file
 *    meanwhile is never reverted by the App;
 *  - the commit and its receipt (`collected`, dated at the effective
 *    deadline, §6) are recorded before the branch moves, `force: false`;
 *    when it never reaches the branch both are withdrawn; a 422 (the head
 *    moved) signs again on the new head, three times at most;
 *  - the temporary ref is deleted after every order, whatever its outcome.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNotNull, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Octokit } from "octokit";

import type { CodespaceCollectionResult } from "@quiz/contracts";
import {
  collectionBranch,
  collectionKeptPaths,
  collectionRef,
  collectionTooLate,
  collectsWorkspace,
  effectiveDeadline,
  headWriter,
  ONLINE_MODES,
  weighsLastWriter,
  zonedIso,
  type HeadWriter,
  type CollectionFailureReason,
} from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { botCommits, codespaceCollections, codespaceLaunches, codespaceRelays, projectRepos, projects, pushReceipts } from "../../db/schema.js";
import { branchHead, githubStatus, ownerRepo } from "../../github/app.js";
import { collectionLanded, deleteCollectionRef, keptEntriesHold, madeOnGitHub, pushedCommitIs } from "../../github/collection.js";
import { commitOnBranch } from "../../github/commit.js";
import {
  claimCollection,
  orderCollection,
  recordCollectionCommit,
  settleCollection,
  unsettledCollections,
  type CollectionSettlement,
} from "../codespace/service.js";
import { dropCollectedReceipt, recordCollectedReceipt } from "../github/service.js";
import { EFFECTIVE_DEADLINE, LIVE } from "./deadline.js";
import type { LeasedRun } from "./lease.js";
import { repoWithProject, type RepoRow } from "./repos.js";
import { lastStudentPush } from "./review.js";
import type { ProjectRow } from "./views.js";

/** Portal orders in flight at once for one project, in waves (ADR-130 §5). */
export const COLLECTION_CONCURRENCY = 16;
/** Signed commits tried when the head moves under the collection (a 422). */
const MOVE_TRIES = 3;

/**
 * Due for collection: an individual repository of a project in the portal
 * (`hybrid` included, whose last push then decides: `collectsWorkspace`),
 * its deadline applied, its student launched a workspace, no lock held, not
 * archived, none recorded for its effective deadline. Over a
 * `project_repos` row joined to its project.
 */
export const COLLECTION_DUE = and(
  inArray(projects.workMode, [...ONLINE_MODES]),
  isNull(projectRepos.groupId),
  isNotNull(projectRepos.deadlineAppliedAt),
  isNull(projectRepos.lockedAt),
  isNull(projectRepos.archivedAt),
  sql`EXISTS (SELECT 1 FROM ${codespaceLaunches} WHERE ${codespaceLaunches.projectId} = ${projects.id} AND ${codespaceLaunches.userId} = ${projectRepos.userId})`,
  sql`NOT EXISTS (SELECT 1 FROM ${codespaceCollections} WHERE ${codespaceCollections.repoId} = ${projectRepos.id} AND ${codespaceCollections.deadlineAt} = ${EFFECTIVE_DEADLINE})`,
)!;

/** A head of a student's repository, with what the database knows of who wrote it (ADR-149 §2). */
interface Head {
  sha: string;
  branch: string;
  /** An earlier collection's commit. */
  collected: boolean;
  /** Received as a bot's push (the App's, a workflow's), or one of the App's own commits. */
  bot: boolean;
  /** Declared by the portal before it relayed it (ADR-078 §6). */
  relayed: boolean;
}

/**
 * The heads of `repo` newest first: `top` — the branch's head now — first,
 * unless the newest receipt names it already; then every push received, a
 * bot's included, newest first. One read of the receipts with their facts.
 * A `top` no receipt names yet is a push whose receipt is not in, read on
 * its own; without any person's push it is the handout, left out.
 */
async function headsOf(db: Db, repo: RepoRow, top: { sha: string; branch: string } | null): Promise<Head[]> {
  const githubRepoId = repo.githubRepoId!;
  const own = (sha: AnyColumn | SQL) =>
    sql<boolean>`EXISTS (SELECT 1 FROM ${botCommits} WHERE ${botCommits.repoId} = ${repo.id} AND ${botCommits.sha} = ${sha})`.mapWith(Boolean);
  const relayed = (sha: AnyColumn | SQL) =>
    sql<boolean>`EXISTS (SELECT 1 FROM ${codespaceRelays} WHERE ${codespaceRelays.githubRepoId} = ${githubRepoId} AND ${codespaceRelays.sha} = ${sha})`.mapWith(Boolean);
  const receipts = await db
    .select({
      sha: pushReceipts.headSha,
      branch: pushReceipts.branch,
      collected: pushReceipts.collected,
      isBot: pushReceipts.isBot,
      own: own(pushReceipts.headSha),
      relayed: relayed(pushReceipts.headSha),
    })
    .from(pushReceipts)
    .where(eq(pushReceipts.githubRepoId, githubRepoId))
    .orderBy(desc(pushReceipts.receivedAt), desc(pushReceipts.collected));
  const heads: Head[] = receipts.map(({ isBot, own: ownCommit, ...head }) => ({ ...head, bot: isBot || ownCommit }));
  if (top === null || heads[0]?.sha === top.sha) return heads;
  const known = heads.find((head) => head.sha === top.sha);
  if (known) return [known, ...heads];
  if (!heads.some((head) => !head.bot)) return heads;
  const [facts] = await db
    .select({ own: own(sql`${top.sha}`), relayed: relayed(sql`${top.sha}`) })
    .from(projectRepos)
    .where(eq(projectRepos.id, repo.id));
  return [{ ...top, collected: false, bot: facts?.own ?? false, relayed: facts?.relayed ?? false }, ...heads];
}

/**
 * The head a machine wrote that the workspace may not be collected over
 * (ADR-149 §2), or null: the writer of each head ({@link headsOf}, newest
 * first) read up to the first that is not neutral, GitHub's committer read
 * only for a head a person pushed (`madeOnGitHub`: an edit or a merge made
 * there is neutral), and `collectsWorkspace` decides. Throws when GitHub
 * cannot be read.
 */
async function machineHead(db: Db, octokit: Octokit, repo: RepoRow, mode: ProjectRow["workMode"], top: { sha: string; branch: string } | null): Promise<Head | null> {
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  const heads = await headsOf(db, repo, top);
  const writers: HeadWriter[] = [];
  for (const head of heads) {
    const facts = { ...head, web: false };
    if (headWriter(facts) === "machine") facts.web = await madeOnGitHub(octokit, owner, name, head.sha);
    writers.push(headWriter(facts));
    if (writers.at(-1) !== "neutral") break;
  }
  return collectsWorkspace(mode, writers) ? null : heads[writers.length - 1]!;
}

/** What the portal's answer records when it is not `pushed`: its outcome, a failure with its reason. Exhaustive by type. */
function portalSettlement(answer: Exclude<CodespaceCollectionResult, { outcome: "pushed" }>): CollectionSettlement {
  switch (answer.outcome) {
    case "failed":
      return { outcome: "failed", reason: answer.reason };
    case "no_snapshot":
      return { outcome: answer.outcome };
    case "unchanged":
    case "too_large":
      return { outcome: answer.outcome, unreadable: answer.unreadable };
    default: {
      const unknown: never = answer;
      return unknown;
    }
  }
}

/**
 * One collection's frame: the settlement, recorded and audited once — only
 * by the run that settles the row first (§5); null for a run that lost.
 */
function settler(app: FastifyInstance, repo: RepoRow, project: ProjectRow, claim: string, deadline: Date) {
  return async (settlement: CollectionSettlement, branch: string | null = null, sha: string | null = null): Promise<CollectionSettlement["outcome"] | null> => {
    if (!(await settleCollection(app.db, claim, settlement, app.clock.now()))) return null;
    await audit(app.db, {
      ...SYSTEM_ACTOR,
      action: "project_repo.workspace_collected",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { projectId: project.id, outcome: settlement.outcome, reason: settlement.reason ?? null, branch, sha, deadlineAt: deadline.toISOString() },
    });
    return settlement.outcome;
  };
}

/**
 * One repository's collection: its outcome, or null when it was not due
 * any more (claimed by another job, reopened, locked meanwhile). A failure
 * is the outcome `failed`; the job locks anyway.
 */
async function collectRepository(app: FastifyInstance, config: AppConfig, octokit: Octokit, repoId: string): Promise<CollectionSettlement["outcome"] | null> {
  const db = app.db;
  const [row] = await repoWithProject(db).where(and(eq(projectRepos.id, repoId), LIVE, COLLECTION_DUE));
  if (!row) return null;
  const { repo, project } = row;
  const deadline = effectiveDeadline(repo, project);
  const claim = await claimCollection(db, repo.id, deadline, app.clock.now());
  if (claim === null) return null;
  const settle = settler(app, repo, project, claim, deadline);
  const last = await lastStudentPush(db, repo.githubRepoId!, null, deadline);
  const branch = collectionBranch(project.branches, last?.branch ?? null);
  const { owner, repo: name } = ownerRepo(repo.fullName!);

  // ADR-149 §2: in `hybrid` the last writer wins, judged on the branch's head now; elsewhere nothing is read.
  const weigh = weighsLastWriter(project.workMode);
  const machine = (top: { sha: string; branch: string } | null) => machineHead(db, octokit, repo, project.workMode, top);
  const local = (head: Head) => settle({ outcome: "last_push_local" }, head.branch, head.sha);
  let weighed: string | null = null;
  if (weigh) {
    try {
      if (branch !== null) weighed = await branchHead(octokit, owner, name, branch);
      const written = await machine(branch !== null && weighed !== null ? { sha: weighed, branch } : null);
      if (written !== null) return local(written);
    } catch (err) {
      app.log.warn({ repo: repo.id, status: githubStatus(err) }, "the last writer could not be read on GitHub");
      return settle({ outcome: "failed", reason: "github_failed" }, branch);
    }
  }
  if (collectionTooLate(deadline, app.clock.now())) return settle({ outcome: "too_late" });
  if (branch === null) return settle({ outcome: "branch_not_handed_out" });
  await recordCollectionCommit(db, claim, branch, null);

  const ref = collectionRef(repo.id, deadline);
  let unreadable: number | null = null;
  const failed = (reason: CollectionFailureReason) => settle({ outcome: "failed", reason, unreadable }, branch);
  try {
    const base = await branchHead(octokit, owner, name, branch);
    if (base === null) return failed("github_failed");
    // The bound again, right before the order, on the clock that dates its token (§5).
    const now = app.clock.now();
    if (collectionTooLate(deadline, now)) return settle({ outcome: "too_late" }, branch);
    const answer = await orderCollection(config, now, project.id, {
      userId: repo.userId,
      repository: repo.fullName!,
      base,
      target: last?.branch === branch ? last.sha : null,
      keep: project.protectedFiles,
      ref,
    });
    if (answer === null) return failed("portal_unavailable");
    if (answer.outcome !== "pushed") return settle(portalSettlement(answer), branch);
    unreadable = answer.unreadable;

    const kept = collectionKeptPaths(project.protectedFiles);
    // The machine's head the commit met (an object: the callback writes it).
    const refused = { by: null as Head | null };
    if (!(await pushedCommitIs(octokit, owner, name, ref, base, answer.tree))) return failed("check_refused");
    const outcome = await commitOnBranch({
      octokit,
      org: owner,
      repo: name,
      branch,
      message: `Collected from the online workspace at the deadline — ${project.name} (${zonedIso(deadline)})`,
      // Checked against the head it goes on, every try: the base first, a new head after a 422 — which, in
      // `hybrid`, is weighed again when it is not the one weighed (ADR-149 §2): a machine's, and nothing is signed.
      treeFor: async (head) => {
        if (weigh && head !== weighed) {
          refused.by = await machine({ sha: head, branch });
          if (refused.by !== null) return null;
        }
        return (await keptEntriesHold(octokit, owner, name, answer.tree, head, kept)) ? answer.tree : null;
      },
      // The commit and its receipt before the move (§6): the push's webhook then reads it as the collection.
      beforeMove: async (sha) => {
        await db.transaction(async (tx) => {
          await recordCollectionCommit(tx, claim, branch, sha);
          await recordCollectedReceipt(tx, { githubRepoId: repo.githubRepoId!, branch, sha, deadline });
        });
      },
      notMoved: async (sha) => {
        await db.transaction(async (tx) => {
          await dropCollectedReceipt(tx, repo.githubRepoId!, sha);
          await recordCollectionCommit(tx, claim, branch, null);
        });
      },
      tries: MOVE_TRIES,
    });
    if (outcome === "refused") return refused.by === null ? failed("check_refused") : local(refused.by);
    if (outcome === null) return failed("github_failed");
    const settled = await settle({ outcome: "collected", unreadable }, branch, outcome);
    if (settled === null) {
      // Another run settled the row meanwhile and may have withdrawn the receipt (§5): what is
      // on the branch decides — the commit landed, so its receipt stands, whatever the row says.
      await recordCollectedReceipt(db, { githubRepoId: repo.githubRepoId!, branch, sha: outcome, deadline });
      app.log.warn({ repo: repo.id, sha: outcome }, "collection landed after another run settled it");
    }
    return settled;
  } catch (err) {
    app.log.warn({ repo: repo.id, status: githubStatus(err) }, "collection failed on GitHub");
    return failed("github_failed");
  } finally {
    await deleteCollectionRef(octokit, owner, name, ref);
  }
}

/**
 * The collections a crash left unsettled on `projectId` (§4.3), claimed
 * more than `COLLECTION_ALIVE_MS` ago: with a commit recorded, `collected`
 * when it is in its branch's history (a student's push relayed on top
 * included), else its receipt withdrawn and `failed` (`interrupted`);
 * without one, `interrupted`. Their temporary refs deleted: a crash skips
 * the order's own deletion. A GitHub read that fails leaves the row for the
 * next run; a repository without a name on GitHub is settled without one.
 */
async function settleInterrupted(app: FastifyInstance, octokit: Octokit, projectId: string): Promise<void> {
  for (const row of await unsettledCollections(app.db, projectId, app.clock.now())) {
    const [found] = await repoWithProject(app.db).where(eq(projectRepos.id, row.repoId));
    if (!found) continue;
    const { repo, project } = found;
    const settle = settler(app, repo, project, row.id, row.deadlineAt);
    const drop = async () => {
      if (row.sha !== null && repo.githubRepoId !== null) await dropCollectedReceipt(app.db, repo.githubRepoId, row.sha);
    };
    if (repo.fullName === null) {
      await drop();
      await settle({ outcome: "failed", reason: "interrupted" }, row.branch);
      continue;
    }
    const { owner, repo: name } = ownerRepo(repo.fullName);
    let landed = false;
    if (row.sha !== null && row.branch !== null) {
      try {
        landed = await collectionLanded(octokit, owner, name, row.sha, row.branch);
      } catch (err) {
        app.log.warn({ repo: repo.id, status: githubStatus(err) }, "an interrupted collection could not be read: left for the next run");
        continue;
      }
    }
    if (landed) {
      await settle({ outcome: "collected" }, row.branch, row.sha);
    } else {
      await drop();
      await settle({ outcome: "failed", reason: "interrupted" }, row.branch);
    }
    await deleteCollectionRef(octokit, owner, name, collectionRef(repo.id, row.deadlineAt));
  }
}

/**
 * The deadline job's first step on `projectId` (ADR-130 §5): the
 * interrupted collections settled, then every repository due collected,
 * {@link COLLECTION_CONCURRENCY} at a time, through the job's `each` — the
 * lease renewed after each repository, the work stopped once it is lost.
 * The number collected, for the job's tally.
 */
export async function collectDue(app: FastifyInstance, config: AppConfig, octokit: Octokit, projectId: string, each: LeasedRun["each"]): Promise<number> {
  await settleInterrupted(app, octokit, projectId);
  const due = await app.db
    .select({ id: projectRepos.id, fullName: projectRepos.fullName })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(eq(projectRepos.projectId, projectId), LIVE, COLLECTION_DUE));
  let collected = 0;
  await each(
    due,
    async ({ id }) => {
      const outcome = await collectRepository(app, config, octokit, id).catch((err: unknown) => {
        app.log.error({ err, repo: id }, "collection crashed");
        return null;
      });
      if (outcome === "collected") collected += 1;
    },
    COLLECTION_CONCURRENCY,
  );
  return collected;
}
