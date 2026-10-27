/**
 * The evidence run of a project graded by criteria (ADR-106 §3) and the
 * automatic criteria's rows it proposes (§2, §4): `collectEvidence` tests
 * a repository at its target commit in the runner, `runEvidence` — the
 * `project.evidence` job — writes the rows. The tarball is fetched through
 * the App, never cloned, and travels in memory and to the runner only; its
 * `codeload` redirect's `token=` never reaches a log, a row or an error
 * (invariant 15). Beside it, the commits of the handed-out branch up to the
 * target (author, e-mail, message), which grade the identity criterion
 * (ADR-106 §2): never logged, never sent to the model. The final pass (`jobs.ts`), a milestone pass
 * (`milestone.ts`) and a Regrade (`regrade.ts`) enqueue the job; its review
 * follows (`reviewPass.ts`).
 */
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type { FastifyInstance } from "fastify";
import { and, eq, inArray, not, or, isNotNull, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { criterionSettings, effectiveCommand, PROJECT_CRITERIA_DEFAULTS } from "@quiz/contracts";
import {
  PROJECT_ARCHIVE_MAX_BYTES,
  PROJECT_OUTPUTS_MAX,
  PROJECT_TIME_MAX_MS,
  projectPathProblem,
  RunnerBusy,
  RunnerUnavailable,
  type ProjectRunRefusal,
  type ProjectRunResult,
} from "@quiz/core/server";
import { readTar, writeTar, type CleanEntry } from "@quiz/core/tar";
import {
  automaticPoints,
  classifyCriterion,
  commitIdentityPoints,
  commitIdentityRationale,
  effectiveDeadline,
  parseJunit,
  plainSources,
  proratedByTests,
  REPORT_FILE,
  stripTarballRoot,
  type CriteriaLeaf,
  type CriterionSettings,
  type EvidenceCommit,
  type EvidenceStatus,
} from "@quiz/domain";

import { readCapped } from "../../cappedBody.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { botCommits, projectCriteria, projectEvidence, projectRepos, projects } from "../../db/schema.js";
import { branchHead, CODELOAD_HOST, githubStatus, installationClient, ownerRepo } from "../../github/app.js";
import { referenceBlob } from "../../github/revert.js";
import { redactTokens } from "../../redact.js";
import { projectInstallation } from "../github/service.js";
import { heldCriteria, writeCriterionGrades, type CriterionGradeInput } from "./criterionGrades.js";
import { releasedBefore, type RepoRow } from "./repos.js";
import { CI_SNAPSHOT, passScope } from "./milestone.js";
import { lastStudentPush } from "./review.js";
import type { ProjectRow } from "./views.js";

/** The `project.evidence` job's data. */
export interface EvidenceJob {
  repoId: string;
  /** The pass this evidence is for (ADR-106 §4, §6): its review follows once the evidence is stored. */
  passId?: string;
  /** A milestone pass's checkpoint (§5): the evidence at its date, its tagged criteria only, their rows locked. */
  checkpointId?: string | undefined;
}

/**
 * Evidence jobs a process runs at once: the runner admits ONE project run at
 * a time (`POST /project`, ADR-106 §3), so a second job was refused (429); a
 * pass never fills the runner's queue (ADR-101).
 */
export const EVIDENCE_CONCURRENCY = 1;
/**
 * A project run refused with 429 is resent after the runner's `Retry-After`
 * (30 s at most): another process's run, or a code question's burst, is over
 * in minutes, and a pass must not be lost to it. The wait is bounded by the
 * wall clock and by the attempts (a `Retry-After` of 0 must end too); past
 * either bound the evidence is stored `timed_out` / `runner_busy`. A run the
 * client gave up on (`RunnerBusy(null)`, its timeout) is never resent.
 */
export const BUSY_WAIT_MAX_MS = 10 * 60_000;
export const BUSY_ATTEMPTS_MAX = 40;
/**
 * The evidence job's expiry, past which pg-boss fails it and its worker takes
 * the next one — two runs at once. It covers the busy wait (10 min), two
 * client waits on the run (`PROJECT_TIME_MAX_MS` 10 min + the 1 min queue
 * allowance, twice: the client resends a 5xx once) and the tarball's
 * download and composition with slack (8 min): 40 min.
 */
export const EVIDENCE_EXPIRY_SECONDS = (BUSY_WAIT_MAX_MS + 2 * PROJECT_TIME_MAX_MS + 10 * 60_000) / 1000;

/** A decompressed tarball past this cannot compose an archive under the runner's cap. */
const UNPACKED_MAX_BYTES = 2 * PROJECT_ARCHIVE_MAX_BYTES;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** A refusal's entries kept in the row's reason. */
const REASON_MAX = 2_000;

export type EvidenceRow = typeof projectEvidence.$inferSelect;
type EvidenceValues = Pick<typeof projectEvidence.$inferInsert, "status" | "reason" | "build" | "test" | "cases" | "files" | "commits">;

export interface EvidenceOutcome {
  evidenceId: string;
  status: EvidenceStatus;
  /** The `auto` rows written. */
  rows: number;
}

/** A tarball that could not be fetched; its message passes through `redactTokens`, never carrying the redirect's token. */
export class TarballUnavailable extends Error {
  constructor(what: string) {
    super(redactTokens(`the repository's tarball could not be fetched: ${what}`));
    this.name = "TarballUnavailable";
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The redirect's target, only when it is GitHub's `codeload` over HTTPS. */
function codeloadUrl(location: string | undefined): string {
  let url: URL;
  try {
    url = new URL(location ?? "");
  } catch {
    throw new TarballUnavailable("no redirect to follow");
  }
  if (url.protocol !== "https:" || url.host !== CODELOAD_HOST) throw new TarballUnavailable(`a redirect to ${url.host}`);
  return url.href;
}

/** The archive at `url`, without credentials (the URL carries its own) and without following further. */
async function download(url: string): Promise<ReadableStream<Uint8Array>> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new TarballUnavailable(messageOf(err));
  }
  if (res.ok && res.body !== null) return res.body;
  await res.body?.cancel().catch(() => undefined);
  throw new TarballUnavailable(`the download answered ${res.status}`);
}

/** The repository's gzipped tarball at `sha`, read up to the runner's cap, or why there is none. */
async function fetchTarball(octokit: Octokit, fullName: string, sha: string): Promise<Uint8Array | "repo_missing" | "archive_too_large"> {
  const { owner, repo } = ownerRepo(fullName);
  let location: string | undefined;
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
      owner,
      repo,
      ref: sha,
      request: { redirect: "manual", parseSuccessResponseBody: false, retries: 0 },
    });
    await (res.data as unknown as ReadableStream | null)?.cancel().catch(() => undefined);
    location = res.headers.location;
  } catch (err) {
    if (githubStatus(err) === 404) return "repo_missing";
    throw new TarballUnavailable(`GitHub answered ${githubStatus(err) ?? messageOf(err)}`);
  }
  const body = await download(codeloadUrl(location));
  const bytes = await readCapped(new Response(body), PROJECT_ARCHIVE_MAX_BYTES).catch((err: unknown) => {
    throw new TarballUnavailable(messageOf(err));
  });
  return bytes ?? "archive_too_large";
}

/** The tarball decompressed, or null past {@link UNPACKED_MAX_BYTES}. */
function unpack(gzipped: Uint8Array): Uint8Array | null {
  try {
    return gunzipSync(gzipped, { maxOutputLength: UNPACKED_MAX_BYTES });
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw new TarballUnavailable(messageOf(err));
  }
}

/** Regular files: `0`, the old `\0`, `7`. Anything else but a directory is dropped (a committed link included). */
const FILE_TYPES = new Set(["0", "\0", "7"]);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The text files of the repository at `sha`, by path, for a schema-3
 * pass's LLM material (ADR-119 §7): the tarball the platform fetches
 * itself, its top-level `<owner>-<repo>-<sha>/` stripped (it names the
 * student), regular files that are UTF-8 only. Nothing of a commit's
 * metadata. Or why there are none; GitHub failing throws
 * {@link TarballUnavailable}.
 */
export async function fetchSourceFiles(octokit: Octokit, fullName: string, sha: string): Promise<Record<string, string> | "repo_missing" | "archive_too_large"> {
  const tarball = await fetchTarball(octokit, fullName, sha);
  if (typeof tarball === "string") return tarball;
  const tar = unpack(tarball);
  if (tar === null) return "archive_too_large";
  const files: Record<string, string> = {};
  for (const entry of stripTarballRoot(readTar(tar))) {
    if (!FILE_TYPES.has(entry.typeflag) || !entry.utf8) continue;
    try {
      files[entry.path] = strictUtf8.decode(entry.data);
    } catch {
      // A binary file: nothing the model reads.
    }
  }
  return files;
}

/**
 * The archive the runner receives (§3): the tarball's tree without its
 * top-level `<owner>-<repo>-<sha>/`, regular files and directories only,
 * `overlay` (the distribution's protected files) in place of the student's
 * copies or added back. Null past the runner's cap. `now`: the mtime, in
 * seconds, of what the overlay adds.
 */
export function composeArchive(tar: Uint8Array, overlay: ReadonlyMap<string, Uint8Array>, now: number): Uint8Array | null {
  const entries: CleanEntry[] = [];
  const dirs = new Set<string>();
  const files = new Set<string>();
  const directory = (path: string, mtime: number) => {
    dirs.add(path);
    entries.push({ path, type: "directory", mode: 0o755, mtime, data: new Uint8Array() });
  };
  for (const entry of stripTarballRoot(readTar(tar))) {
    const path = entry.path.replace(/\/$/, "");
    if (entry.typeflag === "5") directory(path, entry.mtime);
    if (!FILE_TYPES.has(entry.typeflag)) continue;
    files.add(path);
    const mode = entry.mode & 0o111 ? 0o755 : 0o644;
    entries.push({ path, type: "file", mode, mtime: entry.mtime, data: overlay.get(path) ?? entry.data });
  }
  for (const [path, data] of overlay) {
    if (files.has(path)) continue;
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      const dir = segments.slice(0, i).join("/");
      if (!dirs.has(dir)) directory(dir, now);
    }
    entries.push({ path, type: "file", mode: 0o644, mtime: now, data });
  }
  const archive = writeTar(entries);
  return archive.length > PROJECT_ARCHIVE_MAX_BYTES ? null : archive;
}

/** The distribution's protected files at `sha`, as a restore reads them (ADR-062 addendum 1). */
async function protectedFiles(octokit: Octokit, project: ProjectRow, sha: string): Promise<Map<string, Uint8Array>> {
  const { owner, repo } = ownerRepo(project.distributionFullName!);
  const files = new Map<string, Uint8Array>();
  for (const path of project.protectedFiles) {
    const blob = await referenceBlob(octokit, owner, repo, path, sha);
    if (blob) files.set(path, Buffer.from(blob.content, "base64"));
  }
  return files;
}

/** The runner's answer as the row's values. */
function fromRun(outcome: ProjectRunResult | ProjectRunRefusal): EvidenceValues {
  if ("refused" in outcome) {
    const entries = outcome.entries?.length ? `: ${outcome.entries.join(", ")}` : "";
    return { status: "refused", reason: `${outcome.refused}${entries}`.slice(0, REASON_MAX) };
  }
  const files: Record<string, { content: string; truncated: boolean }> = {};
  for (const file of outcome.files) if ("content" in file) files[file.path] = { content: file.content, truncated: file.truncated };
  const report = files[REPORT_FILE];
  return { status: "ok", build: outcome.build, test: outcome.test, cases: report ? parseJunit(report.content).cases : [], files };
}

/** The archive run on the `lab-c` image with the project's commands, or why it was not. */
async function run(app: FastifyInstance, project: ProjectRow, archive: Uint8Array, sources: readonly string[]): Promise<EvidenceValues> {
  const { plain, wildcards } = plainSources(sources);
  // The sources first (ADR-106 §4), then the project's outputs; a path the runner would refuse is left out.
  const outputs = [...new Set([...plain, ...(project.evidenceOutputs ?? PROJECT_CRITERIA_DEFAULTS.evidenceOutputs)])]
    .filter((path) => projectPathProblem(path) === null)
    .slice(0, PROJECT_OUTPUTS_MAX);
  try {
    const values = fromRun(
      await projectRunPatiently(app, {
        archive: Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength).toString("base64"),
        image: "lab-c",
        commands: {
          build: effectiveCommand(project, "buildCommand"),
          test: effectiveCommand(project, "testCommand"),
        },
        outputs,
      }),
    );
    // A wildcard source names no path the runner can bring back: said in the staff's summary.
    return values.status === "ok" && wildcards.length > 0 ? { ...values, reason: `sources_skipped: ${wildcards.join(", ")}`.slice(0, REASON_MAX) } : values;
  } catch (err) {
    // The client turns a transport failure (refused, reset, timed out) into `RunnerUnavailable`.
    if (err instanceof RunnerUnavailable) return { status: "runner_unavailable", reason: err.reason };
    if (err instanceof RunnerBusy) return { status: "timed_out", reason: "runner_busy" };
    app.log.error({ err }, "evidence: the runner's call failed");
    throw err;
  }
}

/** The runner's project run, resent while the runner answers 429 (`BUSY_WAIT_MAX_MS`, `BUSY_ATTEMPTS_MAX`). */
async function projectRunPatiently(app: FastifyInstance, req: Parameters<FastifyInstance["runner"]["project"]>[0]): Promise<ProjectRunResult | ProjectRunRefusal> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await app.runner.project(req);
    } catch (err) {
      const wait = err instanceof RunnerBusy ? err.retryAfterMs : null;
      if (wait === null || attempt >= BUSY_ATTEMPTS_MAX || Date.now() + wait > startedAt + BUSY_WAIT_MAX_MS) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** The evidence of these commits, nulls equal. */
const sameCommits = (repoId: string, targetSha: string | null, distributionSha: string | null) =>
  and(
    eq(projectEvidence.repoId, repoId),
    sql`${projectEvidence.targetSha} IS NOT DISTINCT FROM ${targetSha}`,
    sql`${projectEvidence.distributionSha} IS NOT DISTINCT FROM ${distributionSha}`,
  );

/**
 * An evidence a later pass on the same commits reuses: `ok`, with its
 * commits read when the project has an identity criterion (one stored
 * before them, or whose listing GitHub failed, is run again).
 */
const reusable = (row: EvidenceRow, project: Pick<ProjectRow, "identityCriterion">): boolean =>
  row.status === "ok" && (project.identityCriterion === null || row.commits !== null);

/**
 * The evidence of these commits stored, under the repository row's lock: a
 * {@link reusable} row a concurrent job stored meanwhile is kept and
 * returned; any other is deleted and this one inserted, a new evidence
 * with a new id.
 */
async function store(
  db: Db,
  project: ProjectRow,
  repoId: string,
  targetSha: string | null,
  distributionSha: string | null,
  values: EvidenceValues,
  now: Date,
): Promise<EvidenceRow> {
  return db.transaction(async (tx) => {
    await tx.select({ id: projectRepos.id }).from(projectRepos).where(eq(projectRepos.id, repoId)).for("update");
    const [held] = await tx.select().from(projectEvidence).where(sameCommits(repoId, targetSha, distributionSha));
    // The race guard: a concurrent job on the same commits may have stored an ok row since
    // collectEvidence checked; that row wins and is never replaced.
    if (held && reusable(held, project)) return held;
    if (held) await tx.delete(projectEvidence).where(eq(projectEvidence.id, held.id));
    const [row] = await tx
      .insert(projectEvidence)
      .values({ id: randomUUID(), repoId, targetSha, distributionSha, ...values, createdAt: now })
      .returning();
    return row!;
  });
}

/** The installation's client of the project's organization. */
export async function projectOctokit(db: Db, config: AppConfig, project: ProjectRow): Promise<Octokit> {
  const org = await projectInstallation(db, project.orgId);
  if (!org) throw new Error("Quiz's GitHub App no longer acts on the project's organization");
  return (await installationClient(config, org.installationId)).octokit;
}

/** The commits the identity criterion reads: one page of GitHub's listing, the newest. */
const COMMITS_PAGE = 100;
/** A commit message's first line kept, at most. */
const SUBJECT_MAX = 200;
/**
 * The bots, by git name or GitHub account: heig-classroom's (`hgc-*`), any
 * GitHub App's (`…[bot]`, Quiz's and the workflows' included) and Quiz's
 * former git identity (`heig-quiz`, the root and sync commits of the
 * repositories built before #917, whose commits are GitHub-signed for the
 * App; its commits are in `bot_commits` too).
 */
const BOT_NAME = /^hgc-|^heig-quiz$|\[bot\]$/i;

/** A commit of GitHub's listing, as far as the identity criterion reads it. */
interface ListedCommit {
  sha: string;
  commit: { author?: { name?: string | null; email?: string | null } | null; message: string };
  author?: { login?: string } | null;
}

/** The commits of `fullName` reachable from `sha`, newest first, one page; `missing` on GitHub's 404, `unavailable` on any other failure. */
async function listCommits(octokit: Octokit, fullName: string, sha: string): Promise<ListedCommit[] | "missing" | "unavailable"> {
  const { owner, repo } = ownerRepo(fullName);
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/commits", { owner, repo, sha, per_page: COMMITS_PAGE, request: { retries: 0 } });
    return res.data as ListedCommit[];
  } catch (err) {
    return githubStatus(err) === 404 ? "missing" : "unavailable";
  }
}

/** What reading a repository's commits came to. */
type CommitsRead = { kind: "read"; commits: EvidenceCommit[] } | { kind: "repo_missing" } | { kind: "unavailable" };

/**
 * The student's commits of their repository up to `target` (ADR-106 §2),
 * without the bots' — one of Quiz's own commits on it (`bot_commits`) or a
 * {@link BOT_NAME} name or account — nor the handed-out ones, the commits
 * of the distribution's handed-out branch (the repository is provisioned
 * as its copy). A commit by a staff member's own account counts as the
 * repository's. Either listing failing is `unavailable` (the student's
 * repository gone, `repo_missing`); a database error propagates. Personal
 * data: never logged.
 */
async function readCommits(db: Db, octokit: Octokit, repoId: string, fullName: string, target: string, project: ProjectRow, distributionSha: string): Promise<CommitsRead> {
  const listed = await listCommits(octokit, fullName, target);
  if (listed === "missing") return { kind: "repo_missing" };
  if (listed === "unavailable") return { kind: "unavailable" };
  const handedOut = await listCommits(octokit, project.distributionFullName!, distributionSha);
  if (typeof handedOut === "string") return { kind: "unavailable" };
  const excluded = new Set([
    ...handedOut.map((c) => c.sha),
    ...(await db.select({ sha: botCommits.sha }).from(botCommits).where(eq(botCommits.repoId, repoId))).map((r) => r.sha),
  ]);
  const commits = listed
    .filter((c) => !excluded.has(c.sha) && !BOT_NAME.test(c.commit.author?.name ?? "") && !BOT_NAME.test(c.author?.login ?? ""))
    .map((c) => ({
      sha: c.sha,
      name: c.commit.author?.name ?? "",
      email: c.commit.author?.email ?? "",
      subject: (c.commit.message.split("\n")[0] ?? "").trim().slice(0, SUBJECT_MAX),
    }));
  return { kind: "read", commits };
}

/** GitHub's side of an evidence: an `ok` evidence of the same commits reused, a status without a run, or the archive to run. */
type Prepared = { distributionSha: string } & ({ reused: EvidenceRow } | { values: EvidenceValues } | { archive: Uint8Array; commits: EvidenceCommit[] | null });

/**
 * The distribution's head, a {@link reusable} evidence of the same commits,
 * else — for a project with an identity criterion — the student's commits
 * ({@link readCommits}: null when GitHub fails to list them, which never
 * blocks the tests), and the tarball fetched and composed with the
 * protected files.
 */
async function prepare(db: Db, config: AppConfig, repoId: string, fullName: string, project: ProjectRow, target: string, now: Date): Promise<Prepared> {
  const octokit = await projectOctokit(db, config, project);
  const { owner, repo: name } = ownerRepo(project.distributionFullName!);
  const distributionSha = await branchHead(octokit, owner, name, project.branches[0]!);
  if (distributionSha === null) throw new Error("the distribution repository has no handed-out branch");
  const [held] = await db
    .select()
    .from(projectEvidence)
    .where(and(sameCommits(repoId, target, distributionSha), eq(projectEvidence.status, "ok")));
  if (held && reusable(held, project)) return { distributionSha, reused: held };
  const read = project.identityCriterion === null ? null : await readCommits(db, octokit, repoId, fullName, target, project, distributionSha);
  if (read?.kind === "repo_missing") return { distributionSha, values: { status: "repo_missing" } };
  const commits = read?.kind === "read" ? read.commits : null;
  const tarball = await fetchTarball(octokit, fullName, target);
  if (typeof tarball === "string") return { distributionSha, values: { status: tarball, commits } };
  const tar = unpack(tarball);
  const overlay = tar && (await protectedFiles(octokit, project, distributionSha));
  const archive = tar && overlay && composeArchive(tar, overlay, Math.floor(now.getTime() / 1000));
  return archive ? { distributionSha, archive, commits } : { distributionSha, values: { status: "archive_too_large", commits } };
}

/**
 * The evidence of a repository at `deadline` (§3): the target commit (the
 * last student push on a handed-out branch, `lastStudentPush`), then
 * GitHub's side ({@link prepare}) — whatever fails there (the App, the
 * distribution's head, the tarball, a protected file) is stored as
 * `github_unavailable` with its redacted message, never thrown: the pass's
 * review still follows, and a Regrade tries again — then the run, which
 * brings back `sources` too.
 */
export async function collectEvidence(
  app: FastifyInstance,
  config: AppConfig,
  repo: RepoRow,
  project: ProjectRow,
  deadline: Date,
  sources: readonly string[] = [],
): Promise<EvidenceRow> {
  const db = app.db;
  const now = app.clock.now();
  const target = repo.githubRepoId === null ? null : await lastStudentPush(db, repo.githubRepoId, project.branches, deadline);
  if (target === null) return store(db, project, repo.id, null, null, { status: "no_commit" }, now);
  if (repo.deletedAt !== null || repo.fullName === null) return store(db, project, repo.id, target, null, { status: "repo_missing" }, now);
  let prepared: Prepared;
  try {
    prepared = await prepare(db, config, repo.id, repo.fullName, project, target, now);
  } catch (err) {
    return store(db, project, repo.id, target, null, { status: "github_unavailable", reason: failureReason(err) }, now);
  }
  if ("reused" in prepared) return prepared.reused;
  const values = "values" in prepared ? prepared.values : { ...(await run(app, project, prepared.archive, sources)), commits: prepared.commits };
  return store(db, project, repo.id, target, prepared.distributionSha, values, now);
}

/**
 * An automatic criterion's points from the evidence: the identity
 * criterion's from the commits, whatever the run came to
 * (`commitIdentityPoints`, its rationale the facts with the e-mail masked —
 * the student may read it after the freeze); any other's from the tests
 * (`automaticPoints`). Without what it reads, 0 with the evidence's status.
 */
function autoProposal(
  leaf: CriteriaLeaf,
  evidence: EvidenceRow,
  settings: CriterionSettings,
): Pick<CriterionGradeInput, "points" | "reason" | "rationale"> {
  if (leaf.id === settings.identityCriterion) {
    if (evidence.commits === null) return { points: 0, reason: evidence.status === "ok" ? "github_unavailable" : evidence.status };
    return { points: commitIdentityPoints(evidence.commits, leaf.maxPoints), reason: null, rationale: commitIdentityRationale(evidence.commits) };
  }
  if (evidence.status !== "ok") return { points: 0, reason: evidence.status };
  return { points: automaticPoints(leaf, evidence.cases ?? [], settings.testsCriterion), reason: null };
}

/** A failure's message as a row's reason: redacted, without any URL (a `codeload` one carries a `token=`), capped. */
const failureReason = (err: unknown): string =>
  redactTokens(messageOf(err))
    .replace(/https?:\/\/\S+/g, "<url>")
    .slice(0, REASON_MAX);

/**
 * The `project.evidence` job (§3, §4): the repository's evidence at its
 * effective deadline, then one `auto` proposal per automatic criterion
 * worth positive points ({@link autoProposal}) — 0 with the evidence's
 * status as its reason when there is none. For a milestone (`checkpointId`, §5): the evidence at the
 * checkpoint's date, the criteria it tags only, their rows locked. Null
 * when there is nothing to grade: the repository or the checkpoint gone,
 * its project not in `criteria` mode, without a snapshot, or whose
 * snapshot is schema 3 (ADR-119 §11: the CI's evidence, never the runner's).
 */
export async function runEvidence(app: FastifyInstance, config: AppConfig, repoId: string, checkpointId?: string): Promise<EvidenceOutcome | null> {
  const [row] = await app.db
    .select({ repo: projectRepos, project: projects, snapshot: projectCriteria.criteria })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(projectCriteria, eq(projectCriteria.projectId, projects.id))
    // A schema-3 snapshot's evidence is the CI's graded run (`ci.ts`, ADR-119 §6, §11): never the runner's.
    .where(and(eq(projectRepos.id, repoId), not(CI_SNAPSHOT)));
  if (!row || row.project.gradingMode !== "criteria" || !row.project.distributionFullName) return null;
  const { repo, project, snapshot } = row;
  const scope = await passScope(app.db, project.id, snapshot.leaves, checkpointId);
  if (!scope) return null;
  const evidence = await collectEvidence(app, config, repo, project, scope.dueAt ?? effectiveDeadline(repo, project), snapshot.grading.sources);
  // Schema 2 here: the project's settings classify (`snapshotSettings`).
  const settings = criterionSettings(project);
  const automatic = scope.leaves.filter((leaf) => classifyCriterion(leaf, settings) === "automatic" && proratedByTests(leaf));
  const now = app.clock.now();
  // Not held, nor already proposed from this evidence (`heldCriteria`); the writer checks again under its lock.
  const held = await heldCriteria(app.db, repo.id, evidence.id);
  const inputs = automatic.filter((leaf) => !held.has(leaf.id)).map(
    (leaf): CriterionGradeInput => ({
      criterionId: leaf.id,
      ...autoProposal(leaf, evidence, settings),
      max: leaf.maxPoints,
      source: "auto",
      state: "proposed",
      passId: evidence.id,
      ...scope.lock(now),
    }),
  );
  const rows = await writeCriterionGrades(app.db, repo.id, inputs, now);
  return { evidenceId: evidence.id, status: evidence.status, rows: rows.length };
}

/**
 * Retention (N-DATA-03, §3): the files, the commits and the steps' stdout and stderr of the
 * evidence of the projects released more than six months ago are dropped;
 * the cases and the statuses stay. Run by the daily `reconcile.repos`.
 */
export async function purgeEvidenceFiles(db: Db, now: Date): Promise<number> {
  const released = releasedBefore(db, now);
  const blank = (step: typeof projectEvidence.build | typeof projectEvidence.test) =>
    sql`CASE WHEN ${step} IS NULL THEN NULL ELSE ${step} || '{"stdout":"","stderr":""}'::jsonb END`;
  const output = (step: typeof projectEvidence.build | typeof projectEvidence.test) =>
    sql`coalesce(${step}->>'stdout', '') <> '' OR coalesce(${step}->>'stderr', '') <> ''`;
  const purged = await db
    .update(projectEvidence)
    .set({ files: null, commits: null, build: blank(projectEvidence.build), test: blank(projectEvidence.test) })
    .where(
      and(
        inArray(projectEvidence.repoId, released),
        or(isNotNull(projectEvidence.files), isNotNull(projectEvidence.commits), output(projectEvidence.build), output(projectEvidence.test)),
      ),
    )
    .returning({ id: projectEvidence.id });
  return purged.length;
}
