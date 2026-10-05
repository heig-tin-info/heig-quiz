/**
 * The source's sync (F-PROJ-12 as amended 2026-10-05; merge task M3-07,
 * ADR-073), ported from heig-classroom's `sync.ts` and the source-push and
 * `pull_request` duties of its `modules/webhooks.ts` (sync point `ab98cc0`),
 * on the leases of `lease.ts`.
 *
 * - **The source ahead** ({@link sourcePush}): a push to a handed-out branch
 *   of a project's SOURCE repository marks every non-archived project of
 *   that source — drafts included, so Publish never hands out a stale
 *   distribution — with the push's sha and the server's receipt, and how
 *   many commits the branch holds past the sha handed out (`source_heads`,
 *   written at the build and at each sync; GitHub's compare counts them, in
 *   the background). Nothing reaches a student: the staff see "ahead" and
 *   decide.
 * - **The request** ({@link requestSync}): takes the project's `sync_job_at`
 *   lease (held: `409 sync_in_progress`), updates the distribution
 *   repository in the request — seconds, on the asynchronous git runner,
 *   like the build (ADR-062) — so that a rewritten source under the `whole`
 *   strategy is refused there and then (`409 source_rewritten`, audited),
 *   records the source's shas now handed out, and sends ONE `project.sync`
 *   job. A draft syncs its distribution and nothing else; an archived
 *   project nothing (`409 project_archived`). Never refused for a source
 *   that is not ahead: a retry reaches the repositories that failed.
 * - **The pass** ({@link runSyncJob}), in the leased frame: every student
 *   repository, four at a time, each re-read just before its push —
 *   skipped when it is not live, past its EFFECTIVE deadline (locked or
 *   not) or locked (`syncSkipReason`, `@quiz/domain`) —, the distribution's
 *   branch force-pushed to its `sync/<branch>` (the one ref the App ever
 *   forces), its head recorded in `bot_commits(sync)` BEFORE the ref moves
 *   (N-SEC-21; the ref is left where it is when it already is at that
 *   head: a retry pushes nothing again), then GitHub's compare: no file
 *   differs → up to date, no pull request; else ONE pull request per branch
 *   — the stored one reused while it is open, else the open one found by
 *   its head, else opened — commented on when the update moved its head.
 *   The outcome per repository is stored;
 *   a failure is recorded, the pass goes on, and the frame backdates the
 *   lease (a retry a few seconds on). `source_ahead_sha` is cleared only
 *   when no repository failed and it still is a sha the pass synced.
 * - **The pull requests** ({@link pullRequest}): GitHub's `pull_request`
 *   events keep each row's state, for the App's own pull requests from
 *   `sync/<branch>` only; a replay about an older pull request than the
 *   row's changes nothing.
 *
 * What the students receive never names the source (N-SEC-20): the
 * distribution's commit, the pull request's title and comments carry the
 * DISTRIBUTION's sha. Every text written into GitHub is English (D12).
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Octokit } from "octokit";
import { z } from "zod";

import type { ProjectRepoSync, ProjectSyncAccepted, ProjectSyncState, SyncOutcome, SyncPrState } from "@quiz/contracts";
import { syncSkipReason } from "@quiz/domain";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import { iso, isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { botCommits, classrooms, projectRepos, projects, projectSyncPrs } from "../../db/schema.js";
import { githubStatus, installationClient, isZeroSha, ownerRepo } from "../../github/app.js";
import { openSyncWorkspace, SourceRewritten, updateSquashedRepo, type SyncWorkspace } from "../../github/sync.js";
import { PROJECT_SYNC_QUEUE } from "../../jobs.js";
import { projectInstallation, pushedBy, type WebhookHandler } from "../github/service.js";
import { isLive } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { claimLeases, LEASE_MS, releaseLease, runLeased, type ProjectJob } from "./lease.js";
import { hintProjectStaff, hintRepo, markRepoDeleted, repoContext, studentRepos, type RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

const BRANCH_REF = /^refs\/heads\/(.+)$/;
/** The App's refs on a student repository: `sync/<branch>`. */
const SYNC_REF = /^sync\/(.+)$/;
/** The pull request lists this many changed files at most. */
const FILES_SHOWN = 50;

// ---------------------------------------------------------------- the source ahead

const SourcePushEvent = z.object({
  ref: z.string(),
  after: z.string(),
  repository: z.object({ id: z.number().int() }),
});

/**
 * The commits `branch` of the source holds past the sha handed out, by
 * GitHub's compare; null when GitHub cannot tell (the App gone, a rewritten
 * source, a rate limit): "ahead" then shows no number.
 */
async function commitsAhead(
  app: FastifyInstance,
  config: AppConfig,
  project: Pick<ProjectRow, "id" | "orgId" | "sourceFullName">,
  handed: string,
  after: string,
): Promise<number | null> {
  try {
    const org = await projectInstallation(app.db, project.orgId);
    if (!org) return null;
    const { octokit } = await installationClient(config, org.installationId);
    const { owner, repo } = ownerRepo(project.sourceFullName);
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner,
      repo,
      basehead: `${handed}...${after}`,
      request: { retries: 0 },
    });
    return data.ahead_by;
  } catch (err) {
    app.log.warn({ err, project: project.id }, "source sync: the commits ahead could not be counted");
    return null;
  }
}

/**
 * A push to a SOURCE repository (F-PROJ-12): every non-archived project
 * handing out the pushed branch from it — drafts included — is marked
 * ahead, by the push's sha and the server's receipt of it, with the count
 * of commits past the sha it hands out. A push whose head already is the
 * handed-out sha (a sync fetched it before the delivery was handled) marks
 * nothing. The source needs no receipt: `tracksRepo` stays the student
 * repositories'.
 */
export const sourcePush: WebhookHandler = async (app, config, delivery) => {
  const event = SourcePushEvent.safeParse(delivery.payload);
  if (!event.success) return;
  const { ref, after, repository } = event.data;
  const branch = BRANCH_REF.exec(ref)?.[1];
  if (!branch || isZeroSha(after)) return;
  const affected = await app.db
    .select({ id: projects.id, orgId: projects.orgId, sourceFullName: projects.sourceFullName, sourceHeads: projects.sourceHeads })
    .from(projects)
    .where(and(eq(projects.sourceRepoId, repository.id), isNull(projects.archivedAt), sql`${branch} = ANY(${projects.branches})`));
  const marked: string[] = [];
  for (const project of affected) {
    const handed = project.sourceHeads?.[branch];
    if (handed === after) continue;
    const ahead = handed === undefined ? null : await commitsAhead(app, config, project, handed, after);
    await app.db
      .update(projects)
      .set({
        sourceAheadSha: after,
        sourcePushedAt: delivery.receivedAt,
        sourceAhead: sql`coalesce(${projects.sourceAhead}, '{}'::jsonb) || ${JSON.stringify({ [branch]: ahead })}::jsonb`,
      })
      .where(eq(projects.id, project.id));
    marked.push(project.id);
  }
  await hintProjectStaff(app.db, marked);
};

// ---------------------------------------------------------------- the request

/**
 * `POST /app/api/projects/:id/sync` (F-PROJ-12). The project was loaded under
 * `staffAccess` by the route (invariant 6). Takes the lease, updates the
 * distribution repository here, records the source's shas handed out, audits
 * `project.sync_requested`, sends the job — or runs it in the request without
 * a queue (`JOBS_DISABLED=1`). Refused `project_archived`,
 * `distribution_missing`, `app_not_installed`, `sync_in_progress`,
 * `source_rewritten` (audited `project.sync_failed`), `sync_failed` (502).
 */
export async function requestSync(
  app: FastifyInstance,
  config: AppConfig,
  project: ProjectRow,
  actor: AuditActor,
  now: Date,
  log: FastifyBaseLogger,
): Promise<ProjectSyncAccepted> {
  if (project.archivedAt !== null) throw new ProjectError("project_archived", "An archived project syncs nothing");
  if (project.distributionFullName === null) {
    throw new ProjectError("distribution_missing", "The project's distribution repository is not built");
  }
  const org = await projectInstallation(app.db, project.orgId);
  if (!org) throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");
  const [job] = await claimLeases(app.db, "syncJobAt", now, sql`true`, project.id);
  if (!job) throw new ProjectError("sync_in_progress", "A sync of the project is under way");

  const subject = { subjectType: "project" as const, subjectId: project.id };
  let update;
  try {
    const { token } = await installationClient(config, org.installationId);
    update = await updateSquashedRepo({
      token,
      org: org.login,
      sourceRepo: ownerRepo(project.sourceFullName).repo,
      squashedRepo: ownerRepo(project.distributionFullName).repo,
      strategy: project.sourceStrategy,
      branches: project.branches,
    });
  } catch (err) {
    await releaseLease(app.db, "syncJobAt", job);
    const rewritten = err instanceof SourceRewritten;
    log.error({ err, project: project.id }, "source sync: the distribution repository could not be updated");
    await audit(app.db, { ...actor, action: "project.sync_failed", ...subject, payload: { reason: rewritten ? "source_rewritten" : "github" } });
    if (rewritten) throw new ProjectError("source_rewritten", "The source's history was rewritten: the distribution cannot fast-forward");
    throw new ProjectError("sync_failed", "Updating the distribution repository failed: try again");
  }
  await app.db.update(projects).set({ sourceHeads: update.sourceHeads }).where(eq(projects.id, project.id));
  await audit(app.db, {
    ...actor,
    action: "project.sync_requested",
    ...subject,
    payload: { changed: update.changed, sourceHeads: update.sourceHeads },
  });
  if (app.boss) await app.boss.send(PROJECT_SYNC_QUEUE, job);
  else await runSyncJob(app, config, job).catch((err: unknown) => log.error({ err, project: project.id }, "project sync job failed"));
  return { requestedAt: iso(now) };
}

// ---------------------------------------------------------------- the pass

type BranchOutcome = "opened" | "updated" | "up_to_date";

/** `- \`path\` (status)` per file, the first {@link FILES_SHOWN}. */
function fileList(files: { filename: string; status: string }[]): string {
  const shown = files.slice(0, FILES_SHOWN).map((f) => `- \`${f.filename}\` (${f.status})`);
  const more = files.length > shown.length ? `\n… and ${files.length - shown.length} more files.` : "";
  return `${shown.join("\n")}${more}`;
}

/** The state of pull request `number` on GitHub, or null when it is gone. */
async function prState(octokit: Octokit, owner: string, repo: string, number: number): Promise<SyncPrState | null> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: number,
      request: { retries: 0 },
    });
    return data.state === "open" ? "open" : data.merged ? "merged" : "closed";
  } catch (err) {
    if (githubStatus(err) === 404) return null;
    throw err;
  }
}

/** The one row of (repository, branch): its pull request and state as last known. */
async function storePr(db: Db, repoId: string, branch: string, prNumber: number, state: SyncPrState, now: Date): Promise<void> {
  await db
    .insert(projectSyncPrs)
    .values({ repoId, branch, prNumber, state, updatedAt: now })
    .onConflictDoUpdate({ target: [projectSyncPrs.repoId, projectSyncPrs.branch], set: { prNumber, state, updatedAt: now } });
}

/**
 * The sync pull request of a branch (F-PROJ-12): never two — the stored one
 * while GitHub says it is open, else the open one from `sync/<branch>`
 * found by its head (a row lost, a pull request opened by hand), else a new
 * one. An open one is commented on when the update `moved` its head (a
 * retry says nothing again). Titles, bodies and comments name the
 * DISTRIBUTION's commit (`head`), never the source (N-SEC-20), in English
 * (D12).
 */
async function upsertSyncPr(
  db: Db,
  octokit: Octokit,
  repo: RepoRow,
  branch: string,
  head: string,
  moved: boolean,
  files: { filename: string; status: string }[],
  now: Date,
): Promise<"opened" | "updated"> {
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  const short = head.slice(0, 7);
  const list = fileList(files);
  const [known] = await db
    .select()
    .from(projectSyncPrs)
    .where(and(eq(projectSyncPrs.repoId, repo.id), eq(projectSyncPrs.branch, branch)));
  let open: number | null = null;
  if (known) {
    const state = await prState(octokit, owner, name, known.prNumber);
    if (state === "open") open = known.prNumber;
    else if (state !== null && state !== known.state) await storePr(db, repo.id, branch, known.prNumber, state, now);
  }
  if (open === null) {
    const { data: found } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo: name,
      state: "open",
      head: `${owner}:sync/${branch}`,
      base: branch,
      per_page: 1,
    });
    open = found[0]?.number ?? null;
  }
  if (open !== null) {
    if (moved) {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo: name,
        issue_number: open,
        body: `Updated to \`${short}\`. Files now included:\n\n${list}`,
      });
    }
    await storePr(db, repo.id, branch, open, "open", now);
    return "updated";
  }
  const { data: created } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner,
    repo: name,
    title: `Project update (${short})`,
    head: `sync/${branch}`,
    base: branch,
    body:
      `Your teacher updated the project. Merge this pull request to receive the update:\n\n${list}\n\n` +
      `If GitHub reports conflicts, resolve them keeping your own work where it matters. ` +
      `Your score never depends on this pull request until you merge it.`,
  });
  await storePr(db, repo.id, branch, created.number, "open", now);
  return "opened";
}

/** The head of the repository's `sync/<branch>` on GitHub, or null when the App never pushed it. */
async function syncRefHead(octokit: Octokit, owner: string, repo: string, branch: string): Promise<string | null> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner,
      repo,
      ref: `heads/sync/${branch}`,
      request: { retries: 0 },
    });
    return data.object.sha;
  } catch (err) {
    if (githubStatus(err) === 404) return null;
    throw err;
  }
}

/** The repository's outcome, and when (the server's clock). */
async function recordOutcome(db: Db, repoId: string, outcome: SyncOutcome, now: Date): Promise<void> {
  await db.update(projectRepos).set({ syncOutcome: outcome, syncOutcomeAt: now }).where(eq(projectRepos.id, repoId));
}

/** Whether GitHub no longer has the repository: a failed push probed, so that a deleted repository is terminal, not failed. */
async function gone(octokit: Octokit, owner: string, repo: string): Promise<boolean> {
  try {
    await octokit.request("GET /repos/{owner}/{repo}", { owner, repo, request: { retries: 0 } });
    return false;
  } catch (err) {
    return githubStatus(err) === 404;
  }
}

/**
 * One repository of the pass: re-read just before anything is pushed —
 * skipped when no longer live, past its effective deadline or locked —,
 * then, per handed-out branch, the distribution's head recorded as a bot
 * commit, `sync/<branch>` forced to it, and the pull request when a file
 * differs. The repository's outcome is the strongest of its branches'
 * (opened over updated over up to date); a failure records `failed` and
 * throws, for the frame to count and retry. A repository GitHub lost is
 * marked deleted and skipped.
 */
async function syncRepo(app: FastifyInstance, octokit: Octokit, ws: SyncWorkspace, repoId: string): Promise<SyncOutcome> {
  const db = app.db;
  const [row] = await db
    .select({ repo: projectRepos, project: projects, courseId: classrooms.courseId })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(eq(projectRepos.id, repoId));
  if (!row) return "skipped";
  const { repo, project } = row;
  const now = app.clock.now();
  if (!isLive(repo, project) || syncSkipReason(repo, project, now) !== null) {
    await recordOutcome(db, repo.id, "skipped", now);
    return "skipped";
  }
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  const outcomes: BranchOutcome[] = [];
  try {
    for (const branch of project.branches) {
      const head = await ws.headOf(branch);
      await db.insert(botCommits).values({ repoId: repo.id, sha: head, kind: "sync", createdAt: now }).onConflictDoNothing();
      // The ref moves only when the distribution did (a retry pushes nothing again, and comments on nothing).
      const moved = (await syncRefHead(octokit, owner, name, branch)) !== head;
      if (moved) await ws.pushSyncRef(name, branch);
      const { data: cmp } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner,
        repo: name,
        basehead: `${branch}...sync/${branch}`,
      });
      const files = (cmp.files ?? []).map((f) => ({ filename: f.filename, status: f.status }));
      // No file differs: the student has everything already, no pull request (F-PROJ-12).
      outcomes.push(files.length === 0 ? "up_to_date" : await upsertSyncPr(db, octokit, repo, branch, head, moved, files, now));
    }
  } catch (err) {
    if (await gone(octokit, owner, name)) {
      await markRepoDeleted(db, repo.id, now, "sync");
      await recordOutcome(db, repo.id, "skipped", now);
      return "skipped";
    }
    await recordOutcome(db, repo.id, "failed", now);
    throw err;
  }
  const outcome: SyncOutcome = outcomes.includes("opened") ? "opened" : outcomes.includes("updated") ? "updated" : "up_to_date";
  await recordOutcome(db, repo.id, outcome, now);
  await hintRepo(db, row);
  return outcome;
}

/**
 * The `project.sync` job, in the leased frame (`runLeased`): the pass over
 * every student repository of the project, four at a time; then
 * `synced_at`, the source no longer ahead when nothing failed and no push
 * landed meanwhile, and `project.synced` audited with the counts.
 */
export async function runSyncJob(app: FastifyInstance, config: AppConfig, job: ProjectJob): Promise<void> {
  const db = app.db;
  await runLeased(app, config, "syncJobAt", job, "project sync", async ({ project, octokit, token, lost, each }) => {
    if (project.archivedAt !== null || project.distributionFullName === null) return;
    const { owner, repo: squashedRepo } = ownerRepo(project.distributionFullName);
    const tally: Record<SyncOutcome, number> = { opened: 0, updated: 0, up_to_date: 0, failed: 0, skipped: 0 };
    const repos = await studentRepos(db, project);
    const ws = await openSyncWorkspace({ token, org: owner, squashedRepo });
    let failedRepos: string[];
    try {
      failedRepos = await each(repos, async (repo) => {
        tally[await syncRepo(app, octokit, ws, repo.id)] += 1;
      });
    } finally {
      ws.dispose();
    }
    if (lost()) return;
    tally.failed = failedRepos.length;
    const now = app.clock.now();
    await db.update(projects).set({ syncedAt: now }).where(eq(projects.id, project.id));
    const handed = Object.values(project.sourceHeads ?? {});
    if (failedRepos.length === 0 && handed.length > 0) {
      // Still the sha this pass synced: a push landing meanwhile keeps the source ahead.
      await db
        .update(projects)
        .set({ sourceAheadSha: null, sourcePushedAt: null, sourceAhead: null })
        .where(and(eq(projects.id, project.id), inArray(projects.sourceAheadSha, handed)));
    }
    await audit(db, {
      ...SYSTEM_ACTOR,
      action: "project.synced",
      subjectType: "project",
      subjectId: project.id,
      payload: { opened: tally.opened, updated: tally.updated, upToDate: tally.up_to_date, failed: tally.failed, skipped: tally.skipped, failedRepos },
    });
    await hintProjectStaff(db, [project.id]);
  });
}

// ---------------------------------------------------------------- the pull requests

const PullRequestEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number().int() }),
  pull_request: z.object({
    number: z.number().int(),
    state: z.string(),
    merged: z.boolean().nullish(),
    head: z.object({ ref: z.string() }),
    user: z.object({ login: z.string() }).nullish(),
  }),
});

/**
 * `pull_request` on a student's repository (F-PROJ-12): the state of the
 * App's own sync pull request of a branch — open, merged or closed —, kept
 * on its row. Accepted only for a pull request the App authored from
 * `sync/<branch>`; a replay about an older pull request than the row's
 * changes nothing.
 */
export const pullRequest: WebhookHandler = async (app, config, delivery) => {
  const event = PullRequestEvent.safeParse(delivery.payload);
  if (!event.success) return;
  const { action, repository, pull_request: pr } = event.data;
  const branch = SYNC_REF.exec(pr.head.ref)?.[1];
  if (!branch || pushedBy(config, pr.user?.login) !== "app") return;
  const ctx = await repoContext(app.db, repository.id);
  if (!ctx) return;
  const state: SyncPrState = action === "closed" || pr.state === "closed" ? (pr.merged ? "merged" : "closed") : "open";
  await app.db
    .insert(projectSyncPrs)
    .values({ repoId: ctx.repo.id, branch, prNumber: pr.number, state, updatedAt: delivery.receivedAt })
    .onConflictDoUpdate({
      target: [projectSyncPrs.repoId, projectSyncPrs.branch],
      set: { prNumber: pr.number, state, updatedAt: delivery.receivedAt },
      setWhere: sql`${projectSyncPrs.prNumber} <= ${pr.number}`,
    });
  await hintRepo(app.db, ctx);
};

// ---------------------------------------------------------------- the page

/** The sync as the project page states it (`ProjectSyncState`), from the project's row and its student repositories. */
export function projectSyncState(project: ProjectRow, repos: readonly RepoRow[], now: Date): ProjectSyncState {
  const counts = Object.values(project.sourceAhead ?? {});
  const outcomes = repos.map((r) => r.syncOutcome).filter((o): o is SyncOutcome => o !== null);
  const count = (outcome: SyncOutcome) => outcomes.filter((o) => o === outcome).length;
  return {
    ahead:
      project.sourceAheadSha === null || project.sourcePushedAt === null
        ? null
        : {
            pushedAt: iso(project.sourcePushedAt),
            commits: counts.length > 0 && counts.every((n) => n !== null) ? counts.reduce((a, n) => a + n!, 0) : null,
          },
    inProgress: project.syncJobAt !== null && now.getTime() - project.syncJobAt.getTime() < LEASE_MS,
    syncedAt: isoOrNull(project.syncedAt),
    last:
      outcomes.length === 0
        ? null
        : { opened: count("opened"), updated: count("updated"), upToDate: count("up_to_date"), failed: count("failed"), skipped: count("skipped") },
  };
}

/**
 * The sync of each repository as its row states it (`ProjectRepoSync`), by
 * repository id: the pull request of its default branch (the project's
 * first handed-out branch), and its last outcome.
 */
export async function repoSyncViews(db: Db, project: ProjectRow, repos: readonly RepoRow[]): Promise<Map<string, ProjectRepoSync>> {
  const prs =
    repos.length === 0
      ? []
      : await db
          .select()
          .from(projectSyncPrs)
          .where(
            inArray(
              projectSyncPrs.repoId,
              repos.map((r) => r.id),
            ),
          );
  return new Map(
    repos.map((repo) => {
      const branch = repo.defaultBranch ?? project.branches[0];
      const pr = prs.find((p) => p.repoId === repo.id && p.branch === branch);
      return [repo.id, { pr: pr ? { number: pr.prNumber, state: pr.state } : null, outcome: repo.syncOutcome, at: isoOrNull(repo.syncOutcomeAt) }];
    }),
  );
}
