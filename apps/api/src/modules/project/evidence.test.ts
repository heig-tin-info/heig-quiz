import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readTar } from "@quiz/core/tar";

import { composeArchive, TarballUnavailable } from "./evidence.js";

const NOW = 1_791_000_000;

/** The tar `tar -c` writes of `org-lab-alice-abc1234/` holding a file and a symbolic link. */
function githubLikeTar(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "quiz-tarball-"));
  try {
    const root = join(dir, "org-lab-alice-abc1234");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.c"), "int main(){}\n");
    writeFileSync(join(root, "test.py"), "student's copy\n");
    symlinkSync("/etc/passwd", join(root, "src", "link"));
    return execFileSync("tar", ["-cf", "-", "-C", dir, "org-lab-alice-abc1234"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("composeArchive (ADR-106 §3)", () => {
  it("strips the top directory, drops a link, overlays a protected file and adds back one the student deleted", () => {
    const overlay = new Map([
      ["test.py", Buffer.from("distribution's copy\n")],
      ["tests/test_lab.py", Buffer.from("def test(): pass\n")],
    ]);
    const entries = readTar(composeArchive(githubLikeTar(), overlay, NOW)!);
    const text = new Map(entries.map((e) => [e.path, Buffer.from(e.data).toString("utf8")]));
    expect([...text.keys()].sort()).toEqual(["src/", "src/main.c", "test.py", "tests/", "tests/test_lab.py"]);
    expect(text.get("test.py")).toBe("distribution's copy\n");
    expect(entries.find((e) => e.path === "tests/test_lab.py")!.mtime).toBe(NOW);
  });
});

describe("TarballUnavailable", () => {
  it("never carries the token of a codeload URL", () => {
    const err = new TarballUnavailable("connect ECONNRESET https://codeload.github.com/o/r/legacy.tar.gz/abc?token=SECRET123");
    expect(err.message).toContain("token=***");
    expect(err.message).not.toContain("SECRET123");
  });
});
