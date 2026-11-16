import { describe, expect, it } from "vitest";

import {
  COLLECTION_MAX_BYTES,
  COLLECTION_MAX_FILE_BYTES,
  collectionBranch,
  collectionKeptPaths,
  collectionRef,
  collectionTooLarge,
  composeCollectionTree,
  isCollectionRef,
  isSafeBranchName,
  isSafeRepoPath,
  isSha1,
  staleSnapshot,
  type CollectionTreeEntry,
} from "./workspaceCollection.js";

const sha = (c: string) => c.repeat(40);
const blob = (path: string, c: string, mode = "100644"): CollectionTreeEntry => ({ mode, sha: sha(c), path });

describe("the order's values", () => {
  it("names a temporary ref under refs/quiz/collect/, one component, no dot", () => {
    const ref = collectionRef("0b8e2f0a-6c1e-4c55-9a43-2f1e0c9d8a11", new Date("2026-11-16T13:40:00Z"));
    expect(ref).toBe("refs/quiz/collect/0b8e2f0a-6c1e-4c55-9a43-2f1e0c9d8a11-1794836400");
    expect(isCollectionRef(ref)).toBe(true);
    for (const bad of [
      "refs/heads/main",
      "refs/quiz/collect/",
      "refs/quiz/collect/a/b",
      "refs/quiz/collect/..",
      "refs/quiz/collect/a..b",
      "refs/quiz/collect/x.lock",
      "refs/quiz/collect/-x",
      "refs/quiz/collect/a b",
      "refs/quiz/collect/a\nb",
      "+refs/quiz/collect/a",
    ]) {
      expect(isCollectionRef(bad), bad).toBe(false);
    }
  });

  it("takes a full SHA-1 only", () => {
    expect(isSha1(sha("a"))).toBe(true);
    for (const bad of [sha("A"), "a".repeat(39), "a".repeat(64), `-${"a".repeat(39)}`, "HEAD", "main"]) expect(isSha1(bad), bad).toBe(false);
  });

  it("takes a relative path of plain segments only", () => {
    for (const ok of ["criteria.yml", ".github/workflows", "src/main.c", "a b/c", ".gitignore"]) expect(isSafeRepoPath(ok), ok).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/", "-n", "a\\b", "a\nb", "a\u0000b", ".git", "x/.git/config", ".GIT/HEAD"]) {
      expect(isSafeRepoPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes a branch name git would take, narrowed", () => {
    for (const ok of ["main", "lab-2", "release/1.0", "a_b"]) expect(isSafeBranchName(ok), ok).toBe(true);
    for (const bad of ["", "-f", "a..b", "a//b", "a/.hidden", "x.lock", "a.", "/a", "a/", "HEAD@{1}", "a b", "refs/../x"]) {
      expect(isSafeBranchName(bad), bad).toBe(false);
    }
  });
});

describe("collectionBranch", () => {
  it("is the last push's branch when it was handed out", () => {
    expect(collectionBranch(["main", "part-2"], "part-2")).toBe("part-2");
  });

  it("is the first handed-out branch when the student never pushed", () => {
    expect(collectionBranch(["main", "part-2"], null)).toBe("main");
  });

  it("is none when the last push went elsewhere, or nothing was handed out", () => {
    expect(collectionBranch(["main"], "feature")).toBeNull();
    expect(collectionBranch([], null)).toBeNull();
  });
});

describe("collectionKeptPaths", () => {
  it("adds the workflows to the protected files, once", () => {
    expect(collectionKeptPaths(["grading.h"])).toEqual(["grading.h", ".github/workflows"]);
    expect(collectionKeptPaths([".github/workflows", "criteria.yml"])).toEqual([".github/workflows", "criteria.yml"]);
  });
});

describe("composeCollectionTree", () => {
  const kept = collectionKeptPaths(["tests"]);

  it("takes the workspace, except what is kept, which is the base's", () => {
    const base = [blob("main.c", "1"), blob("tests/t.c", "2"), blob(".github/workflows/ci.yml", "3")];
    const snapshot = [
      blob("main.c", "4"),
      blob("tests/t.c", "5"), // changed in the workspace
      blob("tests/mine.c", "6"), // added under a kept directory
      blob("notes.md", "7"),
      // `.github/workflows/ci.yml` deleted in the workspace
    ];
    expect(composeCollectionTree(snapshot, base, kept)).toEqual([
      blob(".github/workflows/ci.yml", "3"),
      blob("main.c", "4"),
      blob("notes.md", "7"),
      blob("tests/t.c", "2"),
    ]);
  });

  it("drops a kept path the base does not have", () => {
    expect(composeCollectionTree([blob("main.c", "1"), blob(".github/workflows/evil.yml", "2")], [blob("main.c", "1")], kept)).toEqual([blob("main.c", "1")]);
  });

  it("keeps a symbolic link as an entry, and drops a gitlink", () => {
    const link = blob("link", "8", "120000");
    expect(composeCollectionTree([link, blob("vendor/lib", "9", "160000")], [], kept)).toEqual([link]);
  });

  it("drops a workspace file where a kept entry needs a directory", () => {
    const keepDeep = ["tests/data/in.txt"];
    const base = [blob("tests/data/in.txt", "1")];
    const snapshot = [blob("tests", "2"), blob("main.c", "3")];
    expect(composeCollectionTree(snapshot, base, keepDeep)).toEqual([blob("main.c", "3"), blob("tests/data/in.txt", "1")]);
  });
});

describe("staleSnapshot", () => {
  const at = new Date("2026-11-16T13:40:00Z");
  it("is stale when older than the last push, never without one", () => {
    expect(staleSnapshot(at, new Date("2026-11-16T13:40:01Z"))).toBe(true);
    expect(staleSnapshot(at, at)).toBe(false);
    expect(staleSnapshot(at, null)).toBe(false);
  });
});

describe("collectionTooLarge", () => {
  it("refuses one file over GitHub's limit, or too much in all", () => {
    expect(collectionTooLarge([COLLECTION_MAX_FILE_BYTES + 1])).toBe(true);
    expect(collectionTooLarge([COLLECTION_MAX_BYTES / 2, COLLECTION_MAX_BYTES / 2 + 1])).toBe(true);
    expect(collectionTooLarge([COLLECTION_MAX_FILE_BYTES])).toBe(false);
    expect(collectionTooLarge([])).toBe(false);
  });
});
