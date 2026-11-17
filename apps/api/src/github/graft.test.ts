/**
 * The graded commit (ADR-132 §2) against local bare repositories standing
 * for GitHub: deterministic, on its own ref, the branch untouched, the
 * student's links and gitlinks kept, the work directory removed on every
 * exit, the budget ending a call. The composition itself is the domain's
 * (`overlayTree`, tested there).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setRemoteBaseForTests } from "./git.js";
import { buildGradedCommit, GRAFT_MESSAGE, type GraftOrder } from "./graft.js";

const dir = mkdtempSync(join(tmpdir(), "quiz-graft-test-"));
const bare = (name: string) => join(dir, "org", `${name}.git`);
const git = (repo: string, args: string[], input?: string) =>
  execFileSync("git", ["--git-dir", bare(repo), ...args], {
    input,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
  })
    .toString()
    .trim();
/** A commit of `entries` (mode, content or a commit id for a gitlink, path) on `main` of `repo`. */
function commit(repo: string, entries: [string, string, string][], parent?: string): string {
  const lines = entries.map(([mode, content, path]) => {
    const sha = mode === "160000" ? content : git(repo, ["hash-object", "-w", "--stdin"], content);
    return `${mode} ${sha}\t${path}\0`;
  });
  const index = join(dir, `index-${repo}`);
  execFileSync("git", ["--git-dir", bare(repo), "update-index", "-z", "--index-info"], { input: lines.join(""), env: { ...process.env, GIT_INDEX_FILE: index } });
  const tree = execFileSync("git", ["--git-dir", bare(repo), "write-tree"], { env: { ...process.env, GIT_INDEX_FILE: index } }).toString().trim();
  rmSync(index, { force: true });
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
const grafts = () => readdirSync(tmpdir()).filter((name) => name.startsWith("quiz-graft-") && !name.startsWith("quiz-graft-test-"));

let order: GraftOrder;
let target: string;

beforeAll(() => {
  mkdirSync(join(dir, "org"), { recursive: true });
  for (const name of ["student", "dist"]) execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare(name)]);
  const distribution = commit("dist", [
    ["100644", "schema_version: 3\n", "criteria.yml"],
    ["100644", "exit 0\n", "tests/check.sh"],
    ["100644", "# Lab\n", "README.md"],
  ]);
  target = commit("student", [
    ["100644", "schema_version: 3 # mine\n", "criteria.yml"],
    ["100644", "exit 0 # mine\n", "tests/check.sh"],
    ["100644", "echo 1/1\n", "tests/extra.sh"],
    ["100644", "# My lab\n", "README.md"],
    ["100644", "int main(){}\n", "src/main.c"],
    ["120000", "src/main.c", "link"],
    ["160000", "a".repeat(40), "vendor/lib"],
  ]);
  setRemoteBaseForTests(`file://${dir}`);
  order = {
    token: "ghs_FAKEFAKEFAKE",
    studentRepo: "org/student",
    distributionRepo: "org/dist",
    target,
    distributionSha: distribution,
    paths: ["criteria.yml", "tests"],
    passId: "p1",
    at: new Date("2026-11-17T10:00:00Z"),
  };
});

afterAll(() => {
  setRemoteBaseForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("buildGradedCommit", () => {
  it("pushes the target with the distribution's graded paths to its own ref, the branch untouched, the rest of the tree kept", async () => {
    const before = grafts().length;
    const graft = await buildGradedCommit(order);
    expect(graft!.paths).toEqual(["criteria.yml", "tests/check.sh", "tests/extra.sh"]);
    expect(git("student", ["rev-parse", "refs/quiz/grade/p1"])).toBe(graft!.sha);
    expect(git("student", ["rev-parse", "refs/heads/main"])).toBe(target);
    expect(git("student", ["rev-parse", `${graft!.sha}^`])).toBe(target);
    expect(git("student", ["log", "-1", "--format=%s %aI %an", graft!.sha])).toBe(`${GRAFT_MESSAGE} 2026-11-17T10:00:00Z heig-quiz`);
    expect(read("student", graft!.sha, "criteria.yml")).toBe("schema_version: 3");
    expect(read("student", graft!.sha, "tests/check.sh")).toBe("exit 0");
    expect(read("student", graft!.sha, "tests/extra.sh")).toBeNull();
    // Not a protected path: the student's own, links and gitlinks included.
    expect(read("student", graft!.sha, "README.md")).toBe("# My lab");
    expect(git("student", ["ls-tree", graft!.sha, "link", "vendor/lib"])).toBe(
      `120000 blob ${git("student", ["rev-parse", `${target}:link`])}\tlink\n160000 commit ${"a".repeat(40)}\tvendor/lib`,
    );
    expect(grafts().length).toBe(before);

    // A retry builds the same commit; the ref stays.
    expect(await buildGradedCommit(order)).toEqual(graft);
  });

  it("builds nothing when the target holds the distribution's graded paths", async () => {
    expect(await buildGradedCommit({ ...order, paths: ["README.md-missing-nowhere"], passId: "p2" })).toBeNull();
    expect(() => git("student", ["rev-parse", "--verify", "--quiet", "refs/quiz/grade/p2"])).toThrow();
  });

  it("stops at its budget and leaves no work directory", async () => {
    const before = grafts().length;
    await expect(buildGradedCommit({ ...order, passId: "p3", budgetMs: 1 })).rejects.toThrow();
    expect(grafts().length).toBe(before);
  });
});
