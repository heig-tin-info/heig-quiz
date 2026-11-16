import { describe, expect, it } from "vitest";

import { collectionKeptPaths, composeCollectionTree, staleSnapshot, type CollectionTreeEntry } from "./workspaceCollection.js";

const sha = (c: string) => c.repeat(40);
const blob = (path: string, c: string, mode = "100644"): CollectionTreeEntry => ({ mode, sha: sha(c), path });

describe("collectionKeptPaths", () => {
  it("adds the workflows to the protected files, once", () => {
    expect(collectionKeptPaths(["grading.h"])).toEqual(["grading.h", ".github/workflows"]);
    expect(collectionKeptPaths([".github/workflows", "criteria.yml"])).toEqual([".github/workflows", "criteria.yml"]);
    expect(collectionKeptPaths([])).toEqual([".github/workflows"]);
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
