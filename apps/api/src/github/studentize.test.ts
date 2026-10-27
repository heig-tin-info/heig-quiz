import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handoutTree, parseStudentIgnore } from "@quiz/domain";

import { applyStudentHandout } from "./studentize.js";

/*
 * The linked-list lab of 2026-09-23 reached students with its solution: the
 * repository carried a `student/` overlay and a studentize workflow that
 * nothing triggered. The squash now applies the overlay itself.
 */

let dir: string;
const write = (rel: string, content: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
};
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");
const has = (rel: string) => existsSync(join(dir, rel));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quiz-studentize-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// `parseStudentIgnore` itself is tested in `@quiz/domain`.
describe("applyStudentHandout", () => {
  it("replaces the solution with the overlay and drops teacher-only paths", () => {
    write("main.cpp", "// solution");
    write("tests/test_main.py", "tests");
    write("student/main.cpp", "// TODO");
    write("scripts/studentize.sh", "#!/bin/sh");
    write(".github/workflows/studentize.yml", "on: workflow_dispatch");
    write(".github/workflows/grading.yml", "on: push");
    write(".studentignore", "scripts/\n.github/workflows/studentize.yml\n");

    const res = applyStudentHandout(dir);

    expect(res.overlaid).toBe(true);
    expect(read("main.cpp")).toBe("// TODO");
    expect(read("tests/test_main.py")).toBe("tests");
    expect(read(".github/workflows/grading.yml")).toBe("on: push");
    for (const gone of ["student", "scripts", ".github/workflows/studentize.yml", ".studentignore"]) {
      expect(has(gone)).toBe(false);
    }
  });

  it("leaves a repository without conventions untouched", () => {
    write("main.cpp", "// starter");
    expect(applyStudentHandout(dir)).toEqual({ overlaid: false, removed: [] });
    expect(read("main.cpp")).toBe("// starter");
  });

  it("merges nested overlay directories instead of replacing them", () => {
    write("src/a.c", "solution a");
    write("src/b.c", "given b");
    write("student/src/a.c", "stub a");
    applyStudentHandout(dir);
    expect(read("src/a.c")).toBe("stub a");
    expect(read("src/b.c")).toBe("given b");
  });

  it("keeps committed symlinks relative", () => {
    write("student/lib/real.h", "h");
    symlinkSync("real.h", join(dir, "student/lib/link.h"));
    applyStudentHandout(dir);
    expect(readlinkSync(join(dir, "lib/link.h"))).toBe("real.h");
  });

  it("never follows a symlink out of the tree to delete something", () => {
    const outside = mkdtempSync(join(tmpdir(), "quiz-studentize-outside-"));
    try {
      writeFileSync(join(outside, "precious"), "keep");
      symlinkSync(outside, join(dir, "escape"));
      write(".studentignore", "escape/precious\n");
      applyStudentHandout(dir);
      expect(readFileSync(join(outside, "precious"), "utf8")).toBe("keep");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores a `student` symlink: it is not an overlay", () => {
    const outside = mkdtempSync(join(tmpdir(), "quiz-studentize-outside-"));
    try {
      writeFileSync(join(outside, "main.cpp"), "foreign");
      write("main.cpp", "// starter");
      symlinkSync(outside, join(dir, "student"));
      expect(applyStudentHandout(dir).overlaid).toBe(false);
      expect(read("main.cpp")).toBe("// starter");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/** Every path under `root`, as a tree listing: a directory is a `tree`, anything else a `blob`. */
function listing(root: string): { path: string; type: "blob" | "tree" }[] {
  const out: { path: string; type: "blob" | "tree" }[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      out.push({ path, type: entry.isDirectory() ? "tree" : "blob" });
      if (entry.isDirectory()) walk(path);
    }
  };
  walk("");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ADR-119 §9: the creation's preview computes the handout on paths (`handoutTree`); it is the one the build makes on disk.
describe("handoutTree, the same handout on paths", () => {
  it("lists what applyStudentHandout leaves: the overlay over a root directory, the ignored paths and the ignore file gone", () => {
    write("README.md", "# Lab");
    write("criteria.yml", "schema_version: 3");
    write("src/main.c", "// solution");
    write("src/util.c", "// kept");
    write("student/src/main.c", "// TODO");
    write("student/src/extra/hint.md", "hint");
    write("student/NOTES.md", "notes");
    write("solution/answer.c", "42");
    write("scripts/build.sh", "#!/bin/sh");
    write("scripts/keep.sh", "#!/bin/sh");
    write(".github/workflows/grading.yml", "on: push");
    write(".studentignore", "# staff\nsolution/\nscripts/build.sh\nmissing/\n");
    const expected = handoutTree(listing(dir), parseStudentIgnore(read(".studentignore"))).map(({ path, type }) => ({ path, type }));
    applyStudentHandout(dir);
    expect(listing(dir)).toEqual(expected);
    const paths = expected.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["src/main.c", "src/util.c", "src/extra/hint.md", "NOTES.md", "scripts/keep.sh"]));
    for (const gone of ["solution", "solution/answer.c", "scripts/build.sh", "student", ".studentignore"]) expect(paths).not.toContain(gone);
    expect(read("src/main.c")).toBe("// TODO");
  });
});
