import { describe, expect, it } from "vitest";

import {
  collectionBranch,
  collectionKeptPaths,
  collectionRef,
  collectionTooLate,
  collectsWorkspace,
  composeCollectionTree,
  indexInfo,
  keptEntriesMatch,
  overlayTree,
  parseLsTree,
  treeDifference,
  storedCollection,
  withUnreadableKept,
  type CollectionTreeEntry,
} from "./workspaceCollection.js";

const sha = (c: string) => c.repeat(40);
const blob = (path: string, c: string, mode = "100644"): CollectionTreeEntry => ({ mode, sha: sha(c), path });

describe("collectionRef", () => {
  it("names one ref per repository and effective deadline, under refs/quiz/collect/", () => {
    expect(collectionRef("0b8e2f0a-6c1e-4c55-9a43-2f1e0c9d8a11", new Date("2026-11-16T13:40:00Z"))).toBe(
      "refs/quiz/collect/0b8e2f0a-6c1e-4c55-9a43-2f1e0c9d8a11-1794836400",
    );
  });
});

describe("collectsWorkspace (ADR-130 §2 as amended by ADR-149 §2)", () => {
  const RELAYED = { relayed: true };
  const LOCAL = { relayed: false };

  it("always collects where only the workspace writes", () => {
    for (const mode of ["online", "online_seb"] as const) {
      for (const last of [null, RELAYED, LOCAL]) expect(collectsWorkspace(mode, last)).toBe(true);
    }
  });

  it("lets the last writer win in hybrid: the workspace's push or none collects, a local push does not", () => {
    expect(collectsWorkspace("hybrid", null)).toBe(true);
    expect(collectsWorkspace("hybrid", RELAYED)).toBe(true);
    expect(collectsWorkspace("hybrid", LOCAL)).toBe(false);
  });
});

describe("collectionBranch", () => {
  it("is the last push's branch when handed out, the first handed-out one without a push, none otherwise", () => {
    expect(collectionBranch(["main", "part-2"], "part-2")).toBe("part-2");
    expect(collectionBranch(["main", "part-2"], null)).toBe("main");
    expect(collectionBranch(["main"], "feature")).toBeNull();
    expect(collectionBranch([], null)).toBeNull();
  });
});

describe("collectionTooLate", () => {
  const deadline = new Date("2026-11-16T13:40:00Z");
  it("allows an order up to 120 s after the deadline, on Quiz's clock", () => {
    expect(collectionTooLate(deadline, new Date("2026-11-16T13:42:00Z"))).toBe(false);
    expect(collectionTooLate(deadline, new Date("2026-11-16T13:42:00.001Z"))).toBe(true);
  });
});

describe("keptEntriesMatch", () => {
  const kept = collectionKeptPaths(["tests"]);
  const base = [blob("main.c", "1"), blob("tests/t.c", "2")];
  it("holds when every kept entry is the base's, and fails on a change, an addition or a removal", () => {
    expect(keptEntriesMatch([blob("main.c", "9"), blob("tests/t.c", "2")], base, kept)).toBe(true);
    expect(keptEntriesMatch([blob("main.c", "1"), blob("tests/t.c", "3")], base, kept)).toBe(false);
    expect(keptEntriesMatch([...base, blob(".github/workflows/x.yml", "4")], base, kept)).toBe(false);
    expect(keptEntriesMatch([blob("main.c", "1")], base, kept)).toBe(false);
    expect(keptEntriesMatch([blob("main.c", "1"), blob("tests/t.c", "2", "100755")], base, kept)).toBe(false);
  });

  it("fails on a kept file turned into a symbolic link, a file and a directory swapped, a kept file deleted", () => {
    expect(keptEntriesMatch([blob("main.c", "1"), blob("tests/t.c", "2", "120000")], base, kept)).toBe(false);
    // `tests` a file where the base has a directory, and a kept file where it had one.
    expect(keptEntriesMatch([blob("main.c", "1"), blob("tests", "2")], base, kept)).toBe(false);
    expect(keptEntriesMatch([blob("main.c", "1"), blob("tests/t.c/inner", "2")], base, kept)).toBe(false);
    expect(keptEntriesMatch([blob("main.c", "1")], [...base, blob(".github/workflows/ci.yml", "5")], kept)).toBe(false);
  });
});

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

describe("withUnreadableKept", () => {
  const reference = [blob("main.c", "1"), blob("secret/key.c", "2"), blob("secret/deep/x.c", "3"), blob("secretive.c", "4")];
  it("takes an unreadable file, or everything under an unreadable directory, from the reference", () => {
    const workspace = [blob("main.c", "5"), blob("notes.md", "6")];
    expect(withUnreadableKept(workspace, reference, ["secret"])).toEqual([
      blob("main.c", "5"),
      blob("notes.md", "6"),
      blob("secret/key.c", "2"),
      blob("secret/deep/x.c", "3"),
    ]);
    expect(withUnreadableKept(workspace, reference, ["main.c"])).toEqual([blob("notes.md", "6"), blob("main.c", "1")]);
  });

  it("leaves out an unreadable path the reference does not hold, and changes nothing without one", () => {
    const workspace = [blob("main.c", "5")];
    expect(withUnreadableKept(workspace, reference, ["new.c"])).toEqual(workspace);
    expect(withUnreadableKept(workspace, reference, [])).toEqual(workspace);
  });

  // The bounds below are loose on purpose (a slow runner under coverage): the quadratic form took over a minute.
  it("stays linear in the entries: 100 000 paths, half of them unreadable", () => {
    const many = Array.from({ length: 100_000 }, (_, i) => blob(`d${i % 100}/s${i % 7}/f${i}.c`, "1"));
    const unreadable = many.filter((_, i) => i % 2 === 0).map((e) => e.path);
    const started = performance.now();
    const out = withUnreadableKept(many, many, unreadable);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(out).toHaveLength(100_000);
  });

});

describe("the collection's rules stay linear", () => {
  it("composes 300 000 entries against 10 000 kept paths in linear time", () => {
    const snapshot = Array.from({ length: 300_000 }, (_, i) => blob(`src/d${i % 300}/f${i}.c`, "1"));
    const kept = Array.from({ length: 10_000 }, (_, i) => `tests/t${i}`);
    const base = kept.map((k) => blob(`${k}/in.txt`, "2"));
    const started = performance.now();
    const out = composeCollectionTree(snapshot, base, kept);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(out).toHaveLength(310_000);
  });
});

describe("storedCollection", () => {
  it("passes the current values through, null included", () => {
    expect(storedCollection("collected", null)).toEqual({ outcome: "collected", reason: null });
    expect(storedCollection("failed", "read_failed")).toEqual({ outcome: "failed", reason: "read_failed" });
    expect(storedCollection(null, null)).toEqual({ outcome: null, reason: null });
  });

  it("reads a value no list holds any more as failed, with no reason", () => {
    expect(storedCollection("stale_snapshot", null)).toEqual({ outcome: "failed", reason: null });
    expect(storedCollection("failed", "gone_reason")).toEqual({ outcome: "failed", reason: null });
  });
});

describe("overlayTree (the graded commit, ADR-132 §2)", () => {
  const target = [
    blob("src/main.c", "a"),
    blob("tests/check.sh", "b"),
    blob("tests/mine.sh", "c"),
    blob("criteria.yml", "d"),
    blob("vendor/lib", "e", "160000"),
    blob("docs", "f", "120000"),
  ];
  const distribution = [blob("tests/check.sh", "1"), blob("criteria.yml", "2"), blob("docs/README.md", "3"), blob("src/main.c", "9")];

  it("takes every kept entry from the base, a kept directory whole, and keeps the rest of the tree, gitlinks included", () => {
    expect(overlayTree(target, distribution, ["tests", "criteria.yml", "docs"])).toEqual([
      blob("criteria.yml", "2"),
      // A link standing where a kept directory goes is dropped; the directory comes from the base.
      blob("docs/README.md", "3"),
      blob("src/main.c", "a"),
      // The student's file added under a kept directory is gone.
      blob("tests/check.sh", "1"),
      blob("vendor/lib", "e", "160000"),
    ]);
  });

  it("drops a kept path the base lacks", () => {
    expect(overlayTree([blob("README.md", "a"), blob("x", "b")], [], ["README.md"])).toEqual([blob("x", "b")]);
  });

  it("is the collection's rule but for the gitlinks", () => {
    const kept = ["tests"];
    expect(composeCollectionTree(target, distribution, kept)).toEqual(overlayTree(target, distribution, kept).filter((e) => e.mode !== "160000"));
  });
});

describe("treeDifference", () => {
  it("lists the paths whose mode or object differs, or that one side lacks", () => {
    expect(treeDifference([blob("a", "1"), blob("b", "2"), blob("c", "3")], [blob("a", "1"), blob("b", "2", "100755"), blob("d", "4")])).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(treeDifference([blob("a", "1")], [blob("a", "1")])).toEqual([]);
  });
});

describe("parseLsTree and indexInfo", () => {
  it("read and write the NUL-separated listing, a path with a tab or a space included", () => {
    const out = `100644 blob ${sha("a")}\tsrc/a b.c\u0000120000 blob ${sha("b")}\tlink\u0000160000 commit ${sha("c")}\tsub\tx\u0000`;
    const entries = parseLsTree(out);
    expect(entries).toEqual([blob("src/a b.c", "a"), blob("link", "b", "120000"), blob("sub\tx", "c", "160000")]);
    expect(indexInfo(entries)).toBe(`100644 ${sha("a")}\tsrc/a b.c\u0000120000 ${sha("b")}\tlink\u0000160000 ${sha("c")}\tsub\tx\u0000`);
  });
});
