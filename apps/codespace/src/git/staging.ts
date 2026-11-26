/**
 * The staging repository (analyse.md 3.1): one bare repo per (student,
 * assignment) pair, next to the student's volume, that decouples the
 * submission from the availability of the forge. The student's push lands
 * here in milliseconds and *is* the timestamped proof; the relay comes after.
 *
 * Layout (analyse.md D6):
 *
 *     <VOLUMES_ROOT>/<student>/<assignment>/
 *       work/         bind-mounted into the container
 *       staging.git/  this module; invisible from the container
 *       shadow.git/   snapshots (V1, not here)
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { WORKSPACE_PUSH_MAX_BYTES } from "@quiz/domain";

import { gitBare, git, gitAuthEnv } from "./gitRunner.js";

/**
 * Where the staging repository is seeded from. The distinction is invariant
 * 6, not a convenience: in exam mode the source is the teacher's template
 * and never the student's own repository, which is the simplest way around
 * the whole apparatus (analyse.md 4.2).
 */
export type StagingSource =
  /** Lab: mirror of the student's target repository, re-synced on demand. */
  | { mode: "lab"; mirrorFrom: string }
  /** Exam: the teacher's template only. Later pushes on it propagate here. */
  | { mode: "exam"; templateFrom: string }
  /** No source at all: an empty repository the student fills. */
  | { mode: "empty" };

export interface StagingOptions {
  volumesRoot: string;
  student: string;
  assignment: string;
  source: StagingSource;
  /** `http.uploadpack`; true by default (analyse.md 3.2). */
  uploadPack?: boolean;
  /** Default branch of a fresh repository. */
  defaultBranch?: string;
  /**
   * `http.receivepack false`: a staff member's review session (ADR-129
   * §10), which never pushes. The per-request check of `serviceAllowed` is
   * the authority; this is the repository's own lock behind it.
   */
  readOnly?: boolean;
  /**
   * `Authorization` header value for the seeding `git fetch`. A student
   * repository provisioned by classroom is **private**: without it the fetch
   * is refused and the workspace opens empty (observed in production on
   * 2026-09-17). It never goes through argv nor through a configuration file:
   * `gitAuthEnv` carries it in the process environment, exactly like the
   * relay. Absent = anonymous fetch, which is enough for a public repository.
   */
  authorization?: string;
}

/** The largest pack one push may send, `receive.maxInputSize` (audit M11; the rest of the disk: deploy/RUNBOOK.md, Disk). */
export const RECEIVE_MAX_INPUT_BYTES = WORKSPACE_PUSH_MAX_BYTES;

export interface StagingPaths {
  /** `<VOLUMES_ROOT>/<student>/<assignment>` */
  dir: string;
  /** `<dir>/staging.git` */
  gitDir: string;
  /** `<dir>/work`, the only part the container ever sees. */
  workDir: string;
}

/**
 * A student or assignment identifier must not be able to walk out of
 * `VOLUMES_ROOT` (`..`, an absolute path, a NUL). The identifiers come from
 * the IdP and the assignment file, so this is a belt on top of braces.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function stagingPaths(volumesRoot: string, student: string, assignment: string): StagingPaths {
  for (const [label, value] of [
    ["student", student],
    ["assignment", assignment],
  ] as const) {
    if (!SAFE_ID.test(value) || value === "." || value === "..") {
      throw new Error(`invalid ${label} identifier for a path: ${JSON.stringify(value)}`);
    }
  }
  const dir = join(volumesRoot, student, assignment);
  return { dir, gitDir: join(dir, "staging.git"), workDir: join(dir, "work") };
}

const REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];

/**
 * The portal's own refs in a staging repository (the teacher's update,
 * ADR-132 §11, `projectUpdate.ts`): never a branch, never relayed, never a
 * student's to push.
 */
export const PORTAL_REFS = "refs/quiz";

/**
 * Refuses every student push to {@link PORTAL_REFS} — an update, a
 * deletion, a name that would block one (`receive.hideRefs`: git answers
 * "deny updating a hidden ref"). Fetches still see them: the workspace
 * takes its update from there.
 */
export async function guardPortalRefs(gitDir: string): Promise<void> {
  await gitBare(gitDir, ["config", "receive.hideRefs", PORTAL_REFS]);
}

async function isBareRepo(gitDir: string): Promise<boolean> {
  try {
    const entries = await readdir(gitDir);
    return entries.includes("HEAD") && entries.includes("objects");
  } catch {
    return false;
  }
}

/** First branch that exists, so `clone` checks something out. */
async function pickHead(gitDir: string, preferred: string): Promise<void> {
  const out = await gitBare(gitDir, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
  const branches = out.split("\n").filter(Boolean);
  if (branches.length === 0) return;
  const target = branches.includes(`refs/heads/${preferred}`)
    ? `refs/heads/${preferred}`
    : (branches[0] as string);
  await gitBare(gitDir, ["symbolic-ref", "HEAD", target]);
}

/**
 * Creates the staging repository if needed and (re-)seeds it from its
 * source. Idempotent: called at every session start, and again when the
 * teacher pushes a fix to the exam template.
 *
 * `http.receivepack` is true for every student — the student must be able to
 * push even when the forge is down — and false for a review session. `http.uploadpack` follows the assignment, and is
 * also enforced per request in httpBackend.ts, because the repository config
 * is not the authority on a policy that can change mid-session.
 */
export interface StagingResult extends StagingPaths {
  /** The bare repository did not exist before this call. */
  created: boolean;
  /** A `fetch` was attempted (non-empty source) and succeeded. */
  fetched: boolean;
  /**
   * Number of refs after seeding. **Zero is information, not an error**: a
   * student repository freshly created by classroom has no branch at all, and
   * in lab-work mode the workspace then legitimately opens empty. It is
   * `sessions/manager.ts` that decides (see `seedStaging`), because it alone
   * knows the mode of the assignment.
   */
  refs: number;
}

export async function ensureStagingRepo(opts: StagingOptions): Promise<StagingResult> {
  const paths = stagingPaths(opts.volumesRoot, opts.student, opts.assignment);
  const defaultBranch = opts.defaultBranch ?? "main";
  await mkdir(paths.workDir, { recursive: true });

  const existed = await isBareRepo(paths.gitDir);
  if (!existed) {
    await mkdir(paths.gitDir, { recursive: true });
    await git(["init", "--bare", `--initial-branch=${defaultBranch}`, paths.gitDir]);
  }
  await gitBare(paths.gitDir, ["config", "http.receivepack", String(opts.readOnly !== true)]);
  await gitBare(paths.gitDir, [
    "config",
    "http.uploadpack",
    String(opts.uploadPack ?? true),
  ]);
  // The relay reads the reflog to bound its work; a bare repo has none by
  // default and `for-each-ref` snapshots would be the only history.
  await gitBare(paths.gitDir, ["config", "core.logAllRefUpdates", "true"]);
  await gitBare(paths.gitDir, [
    "config",
    "receive.maxInputSize",
    String(RECEIVE_MAX_INPUT_BYTES),
  ]);
  await guardPortalRefs(paths.gitDir);

  const from = sourceUrl(opts.source);
  let fetched = false;
  if (from) {
    await gitBare(
      paths.gitDir,
      ["fetch", "--prune", "--no-tags", from, ...REFSPECS],
      // The authorization touches neither argv (`ps`, `/proc/<pid>/cmdline`)
      // nor the disk; `gitRunner.redactSecrets` strips it from error messages.
      opts.authorization ? { env: gitAuthEnv(opts.authorization, from) } : {},
    );
    fetched = true;
  }
  await pickHead(paths.gitDir, defaultBranch);
  return { ...paths, created: !existed, fetched, refs: await seededRefCount(paths.gitDir) };
}

/** Where {@link refreshStagingRepo} fetches the forge's branches: the portal's own refs, gone once it is done. */
const FORGE_REFS = `${PORTAL_REFS}/forge`;

/** What a refresh did, per branch: created, fast-forwarded, or left because it diverged from the forge. */
export interface StagingRefresh {
  created: string[];
  advanced: string[];
  diverged: string[];
}

/**
 * Brings a seeded `lab` staging repository up to its forge, for a project
 * whose students may also push from their own machines (ADR-149 §7): the
 * forge's branches fetched into the portal's own refs ({@link FORGE_REFS},
 * hidden from every push, deleted afterwards), then each branch of the
 * staging repository created when it is missing, moved when it is an
 * ancestor of the forge's — a compare-and-swap, so a student's push landing
 * meanwhile wins — and left as it is otherwise: **never forced**, never
 * deleted, no tag. Nothing here is relayed (no `PushEvent`); the student's
 * work tree takes it with a pull. The caller refreshes only when nothing
 * of the workspace waits for the relay. The authorization travels as for
 * the seeding, in the environment only.
 */
export async function refreshStagingRepo(gitDir: string, from: string, authorization?: string): Promise<StagingRefresh> {
  const done: StagingRefresh = { created: [], advanced: [], diverged: [] };
  await gitBare(
    gitDir,
    ["fetch", "--no-tags", from, `+refs/heads/*:${FORGE_REFS}/*`],
    authorization ? { env: gitAuthEnv(authorization, from) } : {},
  );
  try {
    const refs = await refSnapshot(gitDir);
    for (const [ref, forgeSha] of refs) {
      if (!ref.startsWith(`${FORGE_REFS}/`)) continue;
      const branch = ref.slice(FORGE_REFS.length + 1);
      const local = refs.get(`refs/heads/${branch}`);
      if (local === forgeSha) continue;
      if (local === undefined) {
        await gitBare(gitDir, ["update-ref", `refs/heads/${branch}`, forgeSha, ""]);
        done.created.push(branch);
      } else if (await isAncestor(gitDir, local, forgeSha)) {
        await gitBare(gitDir, ["update-ref", `refs/heads/${branch}`, forgeSha, local]);
        done.advanced.push(branch);
      } else {
        done.diverged.push(branch);
      }
    }
  } finally {
    const leftovers = [...(await refSnapshot(gitDir)).keys()].filter((ref) => ref.startsWith(`${FORGE_REFS}/`));
    for (const ref of leftovers) await gitBare(gitDir, ["update-ref", "-d", ref]);
  }
  return done;
}

/** Whether `ancestor` is `descendant` or behind it. */
async function isAncestor(gitDir: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitBare(gitDir, ["merge-base", "--is-ancestor", ancestor, descendant]).then(
    () => true,
    () => false,
  );
}

/** Default branch of the staging repository: what `HEAD` points at, or nothing. */
export async function stagingHeadBranch(gitDir: string): Promise<string | null> {
  const head = await gitBare(gitDir, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => "");
  const ref = head.trim();
  if (!ref.startsWith("refs/heads/")) return null;
  const branch = ref.slice("refs/heads/".length);
  // `symbolic-ref` yields a branch even when it does not exist yet (brand new
  // bare repository); only a branch that is **present** is usable.
  const exists = await gitBare(gitDir, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
  return exists.trim() === "" ? null : branch;
}

/**
 * The single point where the exam invariant is enforced: an exam staging
 * repository is only ever fetched from the template.
 */
function sourceUrl(source: StagingSource): string | null {
  switch (source.mode) {
    case "lab":
      return source.mirrorFrom;
    case "exam":
      return source.templateFrom;
    case "empty":
      return null;
  }
}

/** `refs/heads/main` → sha, for every ref. Used before/after receive-pack. */
export async function refSnapshot(gitDir: string): Promise<Map<string, string>> {
  const out = await gitBare(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp > 0) refs.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return refs;
}

/**
 * How many refs the seeding or the student put there — every ref but the
 * portal's own {@link PORTAL_REFS}, which never tell that a repository was
 * seeded. Zero for a repository that does not exist.
 */
export async function seededRefCount(gitDir: string): Promise<number> {
  const refs = await refSnapshot(gitDir).catch(() => new Map<string, string>());
  return [...refs.keys()].filter((ref) => !ref.startsWith(`${PORTAL_REFS}/`)).length;
}
