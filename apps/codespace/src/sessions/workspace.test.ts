/**
 * Workspace seeding — the 2026-09-17 fix.
 *
 * These tests are **unit tests**: the engine is faked, `git` is the real one,
 * and the "forge" is a local bare repository. They fit in a `pnpm test`,
 * without Podman nor Forgejo, because what is checked here is the portal's
 * logic: loud failure, empty target repository allowed in lab mode, re-seeding
 * on resumption, working branch with tracking — and the staff's review
 * session, read-only and ephemeral (ADR-129).
 *
 * What the portal used to do, and what cost the production trial: anonymous
 * `git fetch` on a private repository, failure swallowed, session opened on an
 * empty directory.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, type Db, type DbHandle } from "../db/client.js";
import { assignments, users, type AssignmentRow, type UserRow } from "../db/schema.js";
import type { ContainerInfo, Engine, RunRequest } from "../engine/index.js";
import { ForgeOriginError, ForgeRefusedError, ForgeUnconfiguredError, git, gitBare, refSnapshot, type ForgeOwner } from "../git/index.js";
import { FIXTURE_ENV, makeSourceRepo } from "../git/fixtures.js";
import { causeText } from "../web/i18n.js";

import {
  REVIEW_WIPE_ARGV,
  sessionUpdateOf,
  createSessionManager,
  defaultBranchOf,
  forgeOwnerOf,
  repoRefFromUrl,
  shortCauseOf,
  WorkspaceBootstrapError,
  type ManagerDeps,
} from "./manager.js";
import { completionScript, identityScript, remoteUrl, shellQuote } from "./workspace.js";
import { findAnySession } from "./store.js";

/** Fake engine: it does not apply `:U`, the permissions are set by hand. */
class FakeEngine implements Engine {
  readonly containers = new Map<string, ContainerInfo>();
  readonly execs: Array<{ name: string; argv: string[] }> = [];
  runs = 0;
  private next = 10;

  containerName(sessionId: string): string {
    return `cs-test-${sessionId}`;
  }
  runArgs(): string[] {
    return [];
  }
  async run(req: RunRequest): Promise<ContainerInfo> {
    this.runs += 1;
    const info: ContainerInfo = {
      id: `ctr-${this.runs}`,
      name: req.name,
      sessionId: req.sessionId,
      state: "running",
      ip: `10.77.0.${this.next++}`,
    };
    this.containers.set(req.name, info);
    return info;
  }
  async inspect(name: string): Promise<ContainerInfo | null> {
    return this.containers.get(name) ?? null;
  }
  async stop(): Promise<void> {}
  async rm(name: string): Promise<void> {
    this.containers.delete(name);
  }
  async listSessions(): Promise<ContainerInfo[]> {
    return [...this.containers.values()];
  }
  async waitHealthy(): Promise<number> {
    return 1;
  }
  async exec(name: string, argv: string[]): Promise<string> {
    this.execs.push({ name, argv });
    return "";
  }
  kill(name: string): void {
    this.containers.delete(name);
  }
}

const LOG = { info: () => undefined, warn: () => undefined, error: () => undefined };

const IDENTITY = identityScript({ name: "Sacha Student", email: "student@heig-vd.ch" });

/**
 * Plays a script the manager sent to the container with real git, on the
 * host: `/work` is `work`, and `origin` the staging repository by its path
 * (the portal's channel does not exist here).
 */
async function playInWork(script: string, work: string, stagingGitDir: string): Promise<void> {
  await git(["-C", work, "remote", "set-url", "origin", stagingGitDir]).catch(() => "");
  await new Promise<void>((resolve, reject) =>
    execFile(
      "sh",
      ["-c", script.replace("cd /work", `cd ${shellQuote(work)}`)],
      { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", ...FIXTURE_ENV } },
      (err) => (err ? reject(err) : resolve()),
    ),
  );
}

let handle: DbHandle;
let db: Db;
let root: string;
let engine: FakeEngine;
let user: UserRow;

function makeManager(extra: Partial<ManagerDeps> = {}) {
  return createSessionManager({
    ...extra,
    db,
    engine,
    volumesRoot: root,
    graceMs: 60_000,
    gcIntervalMs: 60_000,
    healthTimeoutMs: 1000,
    gitRemoteHost: "portal.internal",
    gitRemotePort: 9418,
    log: extra.log ?? LOG,
  });
}

async function insertAssignment(patch: Partial<AssignmentRow> = {}): Promise<AssignmentRow> {
  const row = {
    id: "tp",
    title: "TP",
    mode: "lab" as const,
    image: "codespace/c-dev:4.137.0",
    uploadPack: true,
    templateRepo: null,
    targetRepo: null,
    targetRepoPattern: null,
    opensAt: null,
    closesAt: null,
    beks: [],
    createdAt: new Date(),
    ...patch,
  };
  db.insert(assignments).values(row).run();
  return row as AssignmentRow;
}

beforeEach(async () => {
  handle = openDb(":memory:");
  db = handle.db;
  root = await mkdtemp(join(tmpdir(), "v1-workspace-"));
  engine = new FakeEngine();
  const [row] = db
    .insert(users)
    .values({
      id: "u1",
      oidcSub: "sub-1",
      login: "student",
      email: "student@heig-vd.ch",
      displayName: "Sacha Student",
      role: "student",
      createdAt: new Date(),
    })
    .returning()
    .all();
  user = row as UserRow;
});

afterEach(async () => {
  handle.close();
  await rm(root, { recursive: true, force: true });
});

/** Bare repository used as a local "forge": `<root>/forge/<owner>/<name>.git`. */
function forgePath(owner: string, name: string): string {
  return join(root, "forge", owner, `${name}.git`);
}
const localForgeUrl = (repo: { owner: string; name: string }): string =>
  forgePath(repo.owner, repo.name);

describe("loud failure of the seeding", () => {
  it("an unreachable target repository refuses the session, without launching a container", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    const seen: Array<{ owner: string; name: string }> = [];
    const manager = makeManager({
      // Port 1: connection refused immediately, no real network access.
      forgeUrlOf: (repo) => `http://127.0.0.1:1/${repo.owner}/${repo.name}.git`,
      forgeAuthorization: async (repo) => {
        seen.push(repo);
        return "Bearer ghs_token";
      },
    });

    await expect(manager.start(user, assignment)).rejects.toBeInstanceOf(WorkspaceBootstrapError);
    expect(engine.runs).toBe(0);
    expect(findAnySession(db, "student", "tp")?.state).toBe("failed");
    // The authorization was indeed requested for the **source** repository.
    expect(seen).toEqual([{ owner: "org", name: "tp-student" }]);
  });

  it("an unconfigured forge stays a named cause for the student", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    const manager = makeManager({
      forgeUrlOf: (repo) => `http://127.0.0.1:1/${repo.owner}/${repo.name}.git`,
      forgeAuthorization: async () => {
        throw new ForgeUnconfiguredError("no App");
      },
    });
    const err = await manager.start(user, assignment).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceBootstrapError);
    expect((err as WorkspaceBootstrapError).shortCause).toEqual({
      key: "causeNoAccess",
      repo: "org/tp-student",
    });
    expect(engine.runs).toBe(0);
  });

  it("a target repository with no branch at all is allowed in lab mode", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    // What classroom has just provisioned: a bare repository, without a commit.
    await git(["init", "--bare", "-q", forgePath("org", "tp-student")]);
    const manager = makeManager({ forgeUrlOf: localForgeUrl });

    const { session } = await manager.start(user, assignment);
    expect(engine.runs).toBe(1);
    expect(await refSnapshot(join(session.volumeDir, "staging.git"))).toEqual(new Map());
  });

  it("in exam mode, a template without a branch refuses the session", async () => {
    await git(["init", "--bare", "-q", forgePath("org", "template")]);
    const assignment = await insertAssignment({
      id: "exam",
      mode: "exam",
      templateRepo: forgePath("org", "template"),
    });
    const manager = makeManager();
    const err = await manager.start(user, assignment).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceBootstrapError);
    expect((err as WorkspaceBootstrapError).shortCause.key).toBe("causeEmptyTemplate");
    expect(engine.runs).toBe(0);
  });
});

describe("resumption: empty staging repository, workspace to be completed", () => {
  /** The state left by the first real trial: everything is there, but everything is empty. */
  async function sessionWithoutRepo(): Promise<{
    assignment: AssignmentRow;
    sessionId: string;
    volumeDir: string;
  }> {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    await git(["init", "--bare", "-q", forgePath("org", "tp-student")]);
    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    const { session } = await manager.start(user, assignment);
    // The student wrote a file into an empty workspace.
    await writeFile(join(session.volumeDir, "work", "test"), "Excellent", "utf8");
    return { assignment, sessionId: session.id, volumeDir: session.volumeDir };
  }

  /** The student's repository, as it should have been fetched. */
  async function fillTheForge(branch = "master"): Promise<void> {
    const src = await makeSourceRepo({
      dir: join(root, "amont"),
      branch,
      files: { "quadratic.c": "int main(void){return 0;}\n", "Makefile": "all:\n\t@true\n" },
      message: "lab statement",
    });
    await git(["push", "--mirror", forgePath("org", "tp-student")], {
      env: { GIT_DIR: src.gitDir },
    });
  }

  it("re-seeds the staging repository, and completes the workspace in the container, never from the host", async () => {
    const { assignment, sessionId, volumeDir } = await sessionWithoutRepo();
    await fillTheForge("master");
    engine.kill(engine.containerName(sessionId));

    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    await manager.start(user, assignment);

    const work = join(volumeDir, "work");
    const staging = join(volumeDir, "staging.git");
    expect([...(await refSnapshot(staging)).keys()]).toEqual(["refs/heads/master"]);
    // `work/.git` existed: the host runs no git in it (audit L23), even while
    // it could still write there. The container completes it, then sets the
    // identity.
    const completion = completionScript(remoteUrl("portal.internal", 9418, sessionId), "master");
    expect(engine.execs.map((e) => e.argv[2])).toEqual([completion, IDENTITY]);
    expect((await git(["-C", work, "ls-files"])).trim()).toBe("");

    // What the container does with it, with real git.
    await playInWork(completion, work, staging);
    // Argument-less `git pull` and `git push` must work inside the container.
    expect((await git(["-C", work, "branch", "--show-current"])).trim()).toBe("master");
    expect(
      (
        await git(["-C", work, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
      ).trim(),
    ).toBe("origin/master");
    expect((await git(["-C", work, "ls-files"])).split("\n").filter(Boolean).sort()).toEqual([
      "Makefile",
      "quadratic.c",
    ]);
    // The file the student had written is still there, untracked.
    expect((await git(["-C", work, "status", "--porcelain"])).trim()).toBe("?? test");
  });

  it("the live container is not relaunched, but the staging repository is re-seeded", async () => {
    const { assignment, volumeDir } = await sessionWithoutRepo();
    await fillTheForge("master");

    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    const again = await manager.start(user, assignment);
    expect(again.launched).toBe(false);
    expect(engine.runs).toBe(1);
    expect([...(await refSnapshot(join(volumeDir, "staging.git"))).keys()]).toEqual([
      "refs/heads/master",
    ]);
  });

  it.each([
    ["live", false],
    ["resumed", true],
  ])("an update ref of the portal's never passes for a seeding: the missed one is repaired (%s)", async (_label, resumed) => {
    const { assignment, sessionId, volumeDir } = await sessionWithoutRepo();
    await fillTheForge("master");
    const staging = join(volumeDir, "staging.git");
    const sha = (await git(["--git-dir", forgePath("org", "tp-student"), "rev-parse", "refs/heads/master"])).trim();
    await gitBare(staging, ["fetch", "-q", forgePath("org", "tp-student"), `+${sha}:refs/quiz/update/master`]);
    if (resumed) engine.kill(engine.containerName(sessionId));

    await makeManager({ forgeUrlOf: localForgeUrl }).start(user, assignment);
    expect((await refSnapshot(staging)).get("refs/heads/master")).toBe(sha);
  });

  it("when work/ belongs to the container, completion goes through podman exec", async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions: the case cannot be simulated.
    const { assignment, volumeDir } = await sessionWithoutRepo();
    await fillTheForge("master");
    const work = join(volumeDir, "work");
    // What `:U` does: `work/` no longer belongs to the portal.
    await chmod(work, 0o555);
    try {
      engine.kill(engine.containerName(findAnySession(db, "student", "tp")!.id));
      const manager = makeManager({ forgeUrlOf: localForgeUrl });
      await manager.start(user, assignment);
    } finally {
      await chmod(work, 0o755);
    }

    const exec = engine.execs.find((e) => e.argv[2]?.includes("git fetch"));
    expect(exec?.argv[0]).toBe("sh");
    const sessionId = findAnySession(db, "student", "tp")!.id;
    expect(exec?.argv[2]).toBe(completionScript(remoteUrl("portal.internal", 9418, sessionId), "master"));
    expect(exec?.argv[2]).toContain("git fetch -q origin");
    expect(exec?.argv[2]).toContain("git checkout -q -B 'master' 'origin/master'");
    expect(exec?.argv[2]).toContain("--set-upstream-to='origin/master'");
    // No secret enters the container (invariant 1).
    expect(exec?.argv[2]).not.toMatch(/Authorization|ghs_|token/);
  });

  it("a working repository that already carries commits is never touched again", async () => {
    const { assignment, volumeDir } = await sessionWithoutRepo();
    const work = join(volumeDir, "work");
    await git(["-C", work, "add", "-A"], { env: FIXTURE_ENV });
    await git(["-C", work, "commit", "-q", "-m", "the student's work"], { env: FIXTURE_ENV });
    const sha = (await git(["-C", work, "rev-parse", "HEAD"])).trim();

    await fillTheForge("master");
    engine.kill(engine.containerName(findAnySession(db, "student", "tp")!.id));
    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    await manager.start(user, assignment);

    expect((await git(["-C", work, "rev-parse", "HEAD"])).trim()).toBe(sha);
    // The container's completion sees the commit and stops there.
    const completion = engine.execs.find((e) => e.argv[2]?.includes("git fetch"))!.argv[2]!;
    await playInWork(completion, work, join(volumeDir, "staging.git"));
    expect((await git(["-C", work, "rev-parse", "HEAD"])).trim()).toBe(sha);
    expect((await git(["-C", work, "branch", "--show-current"])).trim()).toBe("main");
    expect((await git(["-C", work, "ls-files"])).trim()).toBe("test");
  });
});

describe("the student's git identity in work/.git/config", () => {
  async function config(work: string, key: string): Promise<string> {
    return (await git(["-C", work, "config", "--local", "--get", key]).catch(() => "")).trim();
  }

  it("is set at seeding time, from the host, before the podman run", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");
    expect(await config(work, "user.name")).toBe("Sacha Student");
    expect(await config(work, "user.email")).toBe("student@heig-vd.ch");
    // Nothing went through the container: the host could still write.
    expect(engine.execs).toEqual([]);
  });

  it("never overwrites the identity the student set themselves", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");
    await git(["-C", work, "config", "--local", "user.name", "Pseudonym"]);
    engine.kill(engine.containerName(session.id));
    await makeManager().start(user, assignment);
    expect(await config(work, "user.name")).toBe("Pseudonym");
    // An existing repository: its identity goes through the container's
    // script, which overwrites nothing (below).
    expect(engine.execs.map((e) => e.argv[2])).toContain(IDENTITY);
  });

  it("goes through podman exec when work/ already belongs to the container", async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions.
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");
    await chmod(work, 0o555);
    try {
      engine.kill(engine.containerName(session.id));
      await makeManager().start(user, assignment);
    } finally {
      await chmod(work, 0o755);
    }
    const exec = engine.execs.find((e) => e.argv[2]?.includes("user.email"));
    expect(exec?.argv[0]).toBe("sh");
    expect(exec?.argv[2]).toBe(identityScript({ name: "Sacha Student", email: "student@heig-vd.ch" }));
    // No secret enters the container (invariant 1).
    expect(exec?.argv[2]).not.toMatch(/Authorization|ghs_|token/);
  });

  it("the script overwrites nothing, exits quietly outside a repository, and quotes properly", () => {
    const script = identityScript({ name: "Jean-Luc D'Arc", email: "j@heig-vd.ch" });
    expect(script).toContain("git rev-parse --git-dir >/dev/null 2>&1 || exit 0");
    expect(script).toContain("git config --local --get user.name >/dev/null 2>&1 ||");
    expect(script).toContain(`user.name 'Jean-Luc D'\\''Arc'`);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("repoRefFromUrl and shortCauseOf", () => {
  it("splits a clone URL", () => {
    expect(repoRefFromUrl("https://github.com/org/depot.git")).toEqual({
      owner: "org",
      name: "depot",
    });
    expect(repoRefFromUrl("https://github.com/org/depot")).toEqual({ owner: "org", name: "depot" });
    // A local path is not a forge repository: no authorization to set.
    expect(repoRefFromUrl("/srv/codespace/volumes/e/d/source.git")).toBeUndefined();
  });

  it("names the cause without git jargon, in both languages", () => {
    const repo = { owner: "org", name: "depot" };
    const text = (err: Error, lang: "en" | "fr" = "fr") => causeText(lang, shortCauseOf(err, repo));
    expect(text(new ForgeUnconfiguredError("x"))).toBe("le portail n'a pas les accès à org/depot");
    expect(text(new Error("remote: Repository not found"))).toBe("dépôt org/depot introuvable");
    expect(text(new Error("fatal: Authentication failed"))).toBe("accès refusé au dépôt org/depot");
    expect(text(new Error("Connection refused"))).toBe("récupération de org/depot impossible");
    expect(text(new Error("remote: Repository not found"), "en")).toBe("repository org/depot not found");
    expect(causeText("en", shortCauseOf(new Error("x"), undefined))).toBe(
      "the source repository could not be fetched",
    );
  });
});

describe("default branch", () => {
  it("follows what classroom announces, not the first branch that comes", () => {
    const lab = { mode: "lab", sourceRepo: null } as unknown as AssignmentRow;
    expect(
      defaultBranchOf({ targetRepo: { fullName: "o/d", defaultBranch: "master" } }, lab),
    ).toBe("master");
    // Invariant 6: in an exam, the branch of the teacher's template.
    const exam = {
      mode: "exam",
      sourceRepo: { fullName: "o/modele", defaultBranch: "trunk" },
    } as unknown as AssignmentRow;
    expect(
      defaultBranchOf({ targetRepo: { fullName: "o/d", defaultBranch: "master" } }, exam),
    ).toBe("trunk");
    expect(defaultBranchOf({ targetRepo: null }, lab)).toBe("main");
  });

  it("the repository has `grading` before `master`: it is `master` that is set, with its tracking", async () => {
    const assignment = await insertAssignment({
      targetRepoPattern: "org/tp-{student}",
      sourceRepo: { fullName: "org/tp-student", defaultBranch: "master" },
    });
    // What classroom's CI leaves in a student repository: a `grading` branch
    // that sorts before `master` and that is not the work.
    const src = await makeSourceRepo({
      dir: join(root, "amont"),
      branch: "master",
      files: { "quadratic.c": "int main(void){return 0;}\n" },
      message: "statement",
    });
    await git(["branch", "grading", "master"], { env: { GIT_DIR: src.gitDir } });
    await git(["init", "--bare", "-q", forgePath("org", "tp-student")]);
    await git(["push", "--mirror", forgePath("org", "tp-student")], {
      env: { GIT_DIR: src.gitDir },
    });

    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");

    expect(
      (await gitBare(join(session.volumeDir, "staging.git"), ["symbolic-ref", "HEAD"])).trim(),
    ).toBe("refs/heads/master");
    expect((await git(["-C", work, "branch", "--show-current"])).trim()).toBe("master");
    expect(
      (
        await git(["-C", work, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
      ).trim(),
    ).toBe("origin/master");
  });
});

/**
 * A staff member's review session (ADR-129 §10): read-only, no shadow.git, its
 * directory removed when it closes and swept at startup.
 */
describe("review session (ADR-129 §10)", () => {
  const REVIEW_OF = { projectId: "p-1", projectRepoId: "r-1" };
  const reviewAssignment = (id = "review-r-1") =>
    insertAssignment({ id, title: "org/tp-sacha", reviewOf: REVIEW_OF, teacherId: "t-holder", maxActiveSessions: 4 });
  const exists = (path: string) => lstat(path).then(() => true, () => false);

  it("its staging repository refuses pushes, and the git channel learns it is read-only", async () => {
    const review = await reviewAssignment();
    const lab = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, review);
    const own = await manager.start(user, lab);
    const receivepack = (dir: string) => gitBare(join(dir, "staging.git"), ["config", "http.receivepack"]);
    expect((await receivepack(session.volumeDir)).trim()).toBe("false");
    expect((await receivepack(own.session.volumeDir)).trim()).toBe("true");
    expect((await manager.lookup.bySessionId(session.id))?.readOnly).toBe(true);
    expect((await manager.lookup.bySessionId(own.session.id))?.readOnly).toBe(false);
    // Should a row ever name it, the relay finds no destination for it.
    expect(manager.repoOfEvent({ sessionId: session.id, student: "student", assignment: review.id })).toBeUndefined();
  });

  it("the forge owner of a review carries the reviewed project and repository", async () => {
    expect(forgeOwnerOf({ student: "u-sam" }, { id: "review-r-1", reviewOf: REVIEW_OF })).toEqual({
      assignment: "review-r-1",
      student: "u-sam",
      review: { projectId: "p-1", projectRepoId: "r-1" },
    });
    expect(forgeOwnerOf({ student: "u-sam" }, { id: "tp", reviewOf: null })).toEqual({ assignment: "tp", student: "u-sam" });

    // And the seeding asks with it.
    const review = await reviewAssignment();
    const owners: ForgeOwner[] = [];
    const manager = makeManager({
      forgeUrlOf: (repo) => `http://127.0.0.1:1/${repo.owner}/${repo.name}.git`,
      forgeAuthorization: async (_repo, owner) => {
        owners.push(owner);
        return "Bearer ghs_token";
      },
    });
    await expect(
      manager.start(user, review, { targetRepo: { fullName: "org/tp-sacha", defaultBranch: "main" } }),
    ).rejects.toThrow();
    expect(owners).toEqual([{ assignment: "review-r-1", student: "student", review: REVIEW_OF }]);
  });

  it("closing empties the work tree in its container and removes the directory", async () => {
    const review = await reviewAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, review);
    await writeFile(join(session.volumeDir, "work", "notes.txt"), "read", "utf8");
    await manager.close(session.id, "test");
    expect(engine.execs).toContainEqual({ name: engine.containerName(session.id), argv: [...REVIEW_WIPE_ARGV] });
    expect(await exists(session.volumeDir)).toBe(false);
    expect(findAnySession(db, "student", review.id)?.state).toBe("closed");
  });

  it("the idle collection removes it too, and the next launch fetches afresh", async () => {
    const review = await reviewAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, review);
    manager.touch(session.id, new Date(Date.now() - 120_000));
    expect((await manager.collect()).closed).toBe(1);
    expect(await exists(session.volumeDir)).toBe(false);
    const again = await manager.start(user, review);
    expect(await exists(join(again.session.volumeDir, "staging.git"))).toBe(true);
  });

  it("removing never follows a link out of the directory", async () => {
    const review = await reviewAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, review);
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep", "utf8");
    await symlink(outside, join(session.volumeDir, "work", "escape"));
    await manager.close(session.id, "test");
    expect(await exists(session.volumeDir)).toBe(false);
    expect(await exists(join(outside, "keep.txt"))).toBe(true);
  });

  it("what the host may not unlink is emptied through a container of the same hardened run", async () => {
    const review = await reviewAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, review);
    // A directory the portal may not write in, as `:U` leaves the work tree,
    // and a container already gone: the session's own exec cannot help.
    const locked = join(session.volumeDir, "work", "locked");
    await mkdir(locked);
    await writeFile(join(locked, "a.txt"), "a", "utf8");
    await chmod(locked, 0o555);
    engine.kill(engine.containerName(session.id));
    const wipes: string[] = [];
    engine.exec = async (name, argv) => {
      if (argv.join(" ") === REVIEW_WIPE_ARGV.join(" ") && engine.containers.has(name)) {
        wipes.push(name);
        await chmod(locked, 0o755);
      }
      return "";
    };
    await manager.close(session.id, "test");
    expect(wipes).toHaveLength(1);
    expect(wipes[0]).toMatch(/^cs-test-wipe-/);
    // The throwaway container is gone, and so is the directory.
    expect(engine.containers.has(wipes[0] as string)).toBe(false);
    expect(await exists(session.volumeDir)).toBe(false);
  });

  it("the startup sweep removes review directories and rows without a live session, and nothing else", async () => {
    const live = await reviewAssignment("review-live");
    const dead = await reviewAssignment("review-dead");
    const lab = await insertAssignment();
    // A synchronized project whose id merely looks like a review (an old
    // portal accepted it): its student's volume is never swept.
    const lookalike = await insertAssignment({ id: "review-x" });
    const manager = makeManager();
    const kept = await manager.start(user, live);
    const gone = await manager.start(user, dead);
    const own = await manager.start(user, lab);
    const student = await manager.start(user, lookalike);
    await manager.close(gone.session.id, "test");
    await manager.close(own.session.id, "test");
    await manager.close(student.session.id, "test");
    // Leftovers: the dead review's directory back on disk, and one whose row is gone.
    await mkdir(join(gone.session.volumeDir, "work"), { recursive: true });
    await mkdir(join(root, "u-other", "review-orphan", "work"), { recursive: true });

    expect(await manager.sweepReviews()).toEqual({ directories: 2, assignments: 1 });
    expect(await exists(kept.session.volumeDir)).toBe(true);
    expect(await exists(gone.session.volumeDir)).toBe(false);
    expect(await exists(join(root, "u-other", "review-orphan"))).toBe(false);
    // A student's volume is kept after its close, as always.
    expect(await exists(own.session.volumeDir)).toBe(true);
    expect(await exists(join(student.session.volumeDir, "work"))).toBe(true);
    expect(findAnySession(db, "student", "review-dead")).toBeUndefined();
    expect(findAnySession(db, "student", "review-x")?.state).toBe("closed");
    expect(db.select().from(assignments).all().map((a) => a.id).sort()).toEqual(["review-live", "review-x", "tp"]);
  });
});

describe("the teacher's update (ADR-132 §11)", () => {
  const MESSAGE = { text: "README fixed.", at: "2026-11-17T20:00:00.000Z" };
  const UPDATE_REF = "refs/quiz/update/main";
  const NOT_FETCHED = "teacher's update not fetched: tried again at the next opening or sync";

  /** The student's repository on the local forge, and `sync(text)`: the platform's sync pushing `sync/main`; its sha. */
  async function studentRepo(): Promise<{ sync: (text: string) => Promise<string> }> {
    const dist = join(root, "dist-work");
    await git(["init", "-q", "--initial-branch=main", dist], { env: FIXTURE_ENV });
    await writeFile(join(dist, "README.md"), "v1\n", "utf8");
    await git(["-C", dist, "add", "README.md"], { env: FIXTURE_ENV });
    await git(["-C", dist, "commit", "-qm", "hand-out"], { env: FIXTURE_ENV });
    await git(["clone", "-q", "--bare", dist, forgePath("org", "tp-student")], { env: FIXTURE_ENV });
    return {
      async sync(text) {
        await writeFile(join(dist, "README.md"), text, "utf8");
        await git(["-C", dist, "commit", "-qam", "Project update"], { env: FIXTURE_ENV });
        await git(["-C", dist, "push", "-q", "--force", forgePath("org", "tp-student"), "HEAD:refs/heads/sync/main"], { env: FIXTURE_ENV });
        return (await git(["-C", dist, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();
      },
    };
  }
  const setUpdate = (sha: string) =>
    db.update(assignments).set({ workspaceUpdate: { heads: [{ branch: "main", sha }], message: MESSAGE } }).run();
  const theAssignment = (): AssignmentRow => db.select().from(assignments).all()[0]!;
  const updateRefOf = async (volumeDir: string) => (await refSnapshot(join(volumeDir, "staging.git"))).get(UPDATE_REF);
  const branchesOf = async (volumeDir: string) =>
    [...(await refSnapshot(join(volumeDir, "staging.git")))].filter(([ref]) => ref.startsWith("refs/heads/"));

  it("is fetched at the start, at a sync for a running session, and at the next opening of a closed one — never moving a branch; the lookup announces it", async () => {
    const forge = await studentRepo();
    const first = await forge.sync("v2\n");
    await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    setUpdate(first);
    const owners: ForgeOwner[] = [];
    const manager = makeManager({
      forgeUrlOf: localForgeUrl,
      forgeAuthorization: async (_repo, owner) => {
        owners.push(owner);
        return "basic token";
      },
    });

    const { session } = await manager.start(user, theAssignment());
    await vi.waitFor(async () => expect(await updateRefOf(session.volumeDir)).toBe(first));
    const branches = await branchesOf(session.volumeDir);
    expect(await manager.lookup.bySessionId(session.id)).toMatchObject({ update: { branch: "main", sha: first, message: MESSAGE } });
    // The seeding mirrored sync/main: set locally, no token asked.
    expect(owners).toEqual([]);

    // The platform's sync: every running session, one after the other.
    const second = await forge.sync("v3\n");
    setUpdate(second);
    await manager.refreshUpdates("tp");
    // Fetched with the student's own grant on their repository, as the relay's.
    expect(owners).toEqual([{ assignment: "tp", student: "student" }]);
    expect(await updateRefOf(session.volumeDir)).toBe(second);
    expect(await branchesOf(session.volumeDir)).toEqual(branches);

    // Closed: nothing at the sync; at the next opening.
    await manager.close(session.id, "test");
    const third = await forge.sync("v4\n");
    setUpdate(third);
    await manager.refreshUpdates("tp");
    expect(await updateRefOf(session.volumeDir)).toBe(second);
    await manager.start(user, theAssignment());
    await vi.waitFor(async () => expect(await updateRefOf(session.volumeDir)).toBe(third));
    expect(await branchesOf(session.volumeDir)).toEqual(branches);
  });

  it("never holds a start: Quiz's refusal (closed) or GitHub down leaves the session usable, nothing fetched, and the next occasion tries again", async () => {
    const forge = await studentRepo();
    await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    const warnings: string[] = [];
    let refuse = false;
    const manager = makeManager({
      log: { ...LOG, warn: (_o: object, m: string) => void warnings.push(m) },
      forgeUrlOf: localForgeUrl,
      forgeAuthorization: async () => {
        if (refuse) throw new ForgeRefusedError("closed");
        return "basic token";
      },
    });
    // Seeded before the sync: the staging repository does not hold its commit.
    const { session } = await manager.start(user, theAssignment());
    const sha = await forge.sync("v2\n");
    setUpdate(sha);

    // Quiz refuses the grant (`closed`): nothing fetched, not even anonymously.
    refuse = true;
    await manager.refreshUpdates("tp");
    expect(warnings).toEqual([NOT_FETCHED]);
    expect(await updateRefOf(session.volumeDir)).toBeUndefined();
    expect((await manager.lookup.bySessionId(session.id))?.update).toMatchObject({ sha });

    // GitHub down — the student's repository unreachable: the opening goes on, nothing fetched.
    refuse = false;
    await rm(forgePath("org", "tp-student"), { recursive: true, force: true });
    warnings.length = 0;
    await manager.close(session.id, "test");
    await manager.start(user, theAssignment());
    expect(engine.runs).toBe(2);
    await vi.waitFor(() => expect(warnings).toContain(NOT_FETCHED));
    expect(await updateRefOf(session.volumeDir)).toBeUndefined();
  });

  it("needs no GitHub nor a grant when the staging repository already holds the commit (a seeding after the sync mirrored sync/main)", async () => {
    const forge = await studentRepo();
    const sha = await forge.sync("v2\n");
    await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    setUpdate(sha);
    let asked = 0;
    const manager = makeManager({
      forgeUrlOf: localForgeUrl,
      forgeAuthorization: async () => {
        asked += 1;
        throw new ForgeRefusedError("closed");
      },
    });
    const { session } = await manager.start(user, theAssignment());
    await vi.waitFor(async () => expect(await updateRefOf(session.volumeDir)).toBe(sha));
    // GitHub down, the grant closed: still set from the staging repository's own objects.
    await rm(forgePath("org", "tp-student"), { recursive: true, force: true });
    await gitBare(join(session.volumeDir, "staging.git"), ["update-ref", "-d", UPDATE_REF]);
    await manager.refreshUpdates("tp");
    expect(await updateRefOf(session.volumeDir)).toBe(sha);
    // A local forge's seeding asks no token; the update asked none either.
    expect(asked).toBe(0);
  });

  it("forgets a credential GitHub refused, and asks nothing of a forge that refuses the origin", async () => {
    const forge = await studentRepo();
    await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    // A forge that refuses every credential, as GitHub a revoked token.
    let requests = 0;
    const refusing = createServer((_req, res) => {
      requests += 1;
      res.writeHead(401, { "www-authenticate": 'Basic realm="forge"' }).end();
    });
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
    const port = (refusing.address() as { port: number }).port;
    let http = false;
    let origin = false;
    const invalidated: ForgeOwner[] = [];
    const manager = makeManager({
      forgeUrlOf: (repo) => (http ? `http://127.0.0.1:${port}/${repo.owner}/${repo.name}.git` : localForgeUrl(repo)),
      forgeAuthorization: async () => {
        if (origin) throw new ForgeOriginError("http://elsewhere");
        return "basic token";
      },
      forgeInvalidate: (_repo, owner) => void invalidated.push(owner),
    });
    try {
      const { session } = await manager.start(user, theAssignment());
      setUpdate(await forge.sync("v2\n"));
      http = true;
      await manager.refreshUpdates("tp");
      expect(invalidated).toEqual([{ assignment: "tp", student: "student" }]);
      expect(requests).toBeGreaterThan(0);

      // A misconfigured origin: no anonymous attempt, nothing asked of the forge.
      requests = 0;
      origin = true;
      await manager.refreshUpdates("tp");
      expect(requests).toBe(0);
      expect(await updateRefOf(session.volumeDir)).toBeUndefined();
    } finally {
      refusing.close();
    }
  });

  it("is a student's lab's only: an exam, a review, a session on another branch, or no update announces nothing", () => {
    const workspaceUpdate = { heads: [{ branch: "main", sha: "a".repeat(40) }], message: null };
    const lab = { mode: "lab" as const, sourceRepo: null, workspaceUpdate, reviewOf: null };
    expect(sessionUpdateOf({ targetRepo: null }, lab)).toEqual({ branch: "main", sha: "a".repeat(40), message: null });
    expect(sessionUpdateOf({ targetRepo: null }, { ...lab, mode: "exam" })).toBeUndefined();
    expect(sessionUpdateOf({ targetRepo: null }, { ...lab, reviewOf: { projectId: "p", projectRepoId: "r" } })).toBeUndefined();
    expect(sessionUpdateOf({ targetRepo: { fullName: "org/tp", defaultBranch: "master" } }, lab)).toBeUndefined();
    expect(sessionUpdateOf({ targetRepo: null }, { ...lab, workspaceUpdate: null })).toBeUndefined();
  });
});
