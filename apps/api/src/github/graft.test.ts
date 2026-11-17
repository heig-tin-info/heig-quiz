/**
 * The graded commit (ADR-132 §2) against local bare repositories standing
 * for GitHub: deterministic, on its own one-component ref, the branch
 * untouched, the student's links, gitlinks and non-UTF-8 paths kept, a
 * target that is not the branch's tip pushed from a shallow fetch, the work
 * directory removed on every exit and swept after a crash, the budget
 * ending a call. The composition itself is the domain's (`overlayTree`,
 * tested there).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setRemoteBaseForTests } from "./git.js";
import { buildGradedCommit, GRAFT_MESSAGE, gradeRef, sweepGraftDirs, type GraftOrder } from "./graft.js";

const dir = mkdtempSync(join(tmpdir(), "quiz-graftest-"));
const bare = (name: string) => join(dir, "org", `${name}.git`);
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (repo: string, args: string[], input?: string) => execFileSync("git", ["--git-dir", bare(repo), ...args], { input, env: ENV }).toString().trim();
/** A path that is not UTF-8 (one byte 0xE9), as git stores it. */
const LATIN1_PATH = "src/café.c";

/** A commit of `entries` (mode, content or a commit id for a gitlink, path read as bytes) on `main` of `repo`. */
function commit(repo: string, entries: [string, string, string][], parent?: string): string {
  const lines = entries.map(([mode, content, path]) => {
    const sha = mode === "160000" ? content : git(repo, ["hash-object", "-w", "--stdin"], content);
    return `${mode} ${sha}\t${path}\0`;
  });
  const env = { ...ENV, GIT_INDEX_FILE: join(dir, `index-${repo}`) };
  execFileSync("git", ["--git-dir", bare(repo), "update-index", "-z", "--index-info"], { input: Buffer.from(lines.join(""), "latin1"), env });
  const tree = execFileSync("git", ["--git-dir", bare(repo), "write-tree"], { env }).toString().trim();
  rmSync(env.GIT_INDEX_FILE, { force: true });
  const sha = git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "c"]);
  git(repo, ["update-ref", "refs/heads/main", sha]);
  return sha;
}
const read = (repo: string, ref: string, path: string) => {
  try {
    return git(repo, ["cat-file", "blob", `${ref}:${path}`]);
  } catch {
    return null;
  }
};
const grafts = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`quiz-graft-${process.pid}-`));

const STUDENT: [string, string, string][] = [
  ["100644", "schema_version: 3 # mine\n", "criteria.yml"],
  ["100644", "exit 0 # mine\n", "tests/check.sh"],
  ["100644", "echo 1/1\n", "tests/extra.sh"],
  ["100644", "# My lab\n", "README.md"],
  ["100644", "int main(){}\n", "src/main.c"],
  ["100644", "int cafe;\n", LATIN1_PATH],
  ["120000", "src/main.c", "link"],
  ["160000", "a".repeat(40), "vendor/lib"],
];

let order: GraftOrder;
/** The milestone's target, the final pass's target, and a push received after it (the branch's tip). */
let milestone: string;
let target: string;
let late: string;

beforeAll(() => {
  mkdirSync(join(dir, "org"), { recursive: true });
  for (const name of ["student", "dist"]) execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare(name)]);
  const distribution = commit("dist", [
    ["100644", "schema_version: 3\n", "criteria.yml"],
    ["100644", "exit 0\n", "tests/check.sh"],
    ["100644", "# Lab\n", "README.md"],
  ]);
  milestone = commit("student", STUDENT.slice(0, 5));
  target = commit("student", STUDENT, milestone);
  late = commit("student", [...STUDENT, ["100644", "late\n", "src/late.c"]], target);
  setRemoteBaseForTests(`file://${dir}`);
  order = {
    token: "ghs_FAKEFAKEFAKE",
    studentRepo: "org/student",
    distributionRepo: "org/dist",
    target,
    distributionSha: distribution,
    paths: ["criteria.yml", "tests", ".github/workflows"],
    passId: "p1",
    at: new Date("2026-11-17T10:00:00Z"),
  };
});

afterAll(() => {
  setRemoteBaseForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("buildGradedCommit", () => {
  it("pushes a target behind the branch's tip, with the distribution's graded paths, to its own ref; the branch untouched, the rest of the tree kept", async () => {
    const before = grafts().length;
    const graft = await buildGradedCommit(order);
    expect(graft!.paths).toEqual(["criteria.yml", "tests/check.sh", "tests/extra.sh"]);
    expect(gradeRef("p1")).toBe("refs/quiz-grade-p1/graded");
    expect(git("student", ["rev-parse", "refs/quiz-grade-p1/graded"])).toBe(graft!.sha);
    expect(git("student", ["rev-parse", "refs/heads/main"])).toBe(late);
    expect(git("student", ["rev-parse", `${graft!.sha}^`])).toBe(target);
    expect(git("student", ["log", "-1", "--format=%s %aI %an", graft!.sha])).toBe(`${GRAFT_MESSAGE} 2026-11-17T10:00:00Z heig-quiz`);
    expect(read("student", graft!.sha, "criteria.yml")).toBe("schema_version: 3");
    expect(read("student", graft!.sha, "tests/check.sh")).toBe("exit 0");
    expect(read("student", graft!.sha, "tests/extra.sh")).toBeNull();
    // Not a protected path: the student's own, links, gitlinks and a path that is not UTF-8 included.
    expect(read("student", graft!.sha, "README.md")).toBe("# My lab");
    expect(git("student", ["ls-tree", graft!.sha, "link", "vendor/lib"])).toBe(
      `120000 blob ${git("student", ["rev-parse", `${target}:link`])}\tlink\n160000 commit ${"a".repeat(40)}\tvendor/lib`,
    );
    const listing = (sha: string) => execFileSync("git", ["--git-dir", bare("student"), "ls-tree", "-r", "-z", sha, "src"], { env: ENV });
    expect(listing(graft!.sha).equals(listing(target))).toBe(true);
    expect(listing(graft!.sha).includes(Buffer.from(LATIN1_PATH, "latin1"))).toBe(true);
    expect(grafts().length).toBe(before);

    // A retry builds the same commit; the ref stays.
    expect(await buildGradedCommit(order)).toEqual(graft);
  });

  it("pushes a milestone's target, deeper in the history, from a shallow fetch too", async () => {
    const graft = await buildGradedCommit({ ...order, target: milestone, passId: "p2" });
    expect(git("student", ["rev-parse", "refs/quiz-grade-p2/graded"])).toBe(graft!.sha);
    expect(git("student", ["rev-parse", `${graft!.sha}^`])).toBe(milestone);
    expect(git("student", ["fsck", "--connectivity-only", "--no-dangling"])).toBe("");
  });

  it("stops at its budget and leaves no work directory", async () => {
    const before = grafts().length;
    await expect(buildGradedCommit({ ...order, passId: "p3", budgetMs: 1 })).rejects.toThrow();
    expect(grafts().length).toBe(before);
  });
});

describe("sweepGraftDirs", () => {
  it("removes this process's and a dead process's directories, never a live one's", async () => {
    const dead = 2 ** 22 + 17;
    const live = process.ppid;
    for (const pid of [process.pid, dead, live]) mkdirSync(join(tmpdir(), `quiz-graft-${pid}-left`), { recursive: true });
    await sweepGraftDirs();
    const left = readdirSync(tmpdir());
    expect(left).not.toContain(`quiz-graft-${process.pid}-left`);
    expect(left).not.toContain(`quiz-graft-${dead}-left`);
    expect(left).toContain(`quiz-graft-${live}-left`);
    rmSync(join(tmpdir(), `quiz-graft-${live}-left`), { recursive: true, force: true });
  });
});
