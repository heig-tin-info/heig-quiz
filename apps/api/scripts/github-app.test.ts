/**
 * `pnpm github:app` writes the App's private key and secrets only outside a
 * git working tree (invariant 15, ADR-010): this repository, a worktree of
 * it (a `.git` file), or any other.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { insideGitTree } from "./github-app.js";

describe("insideGitTree", () => {
  const dir = mkdtempSync(join(tmpdir(), "quiz-github-app-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses this repository, at any depth", () => {
    expect(insideGitTree(fileURLToPath(new URL("./app.pem", import.meta.url)))).toBe(true);
    expect(insideGitTree(fileURLToPath(new URL("../../../secrets/app.pem", import.meta.url)))).toBe(true);
  });

  it("refuses a worktree, whose .git is a file, and any other repository", () => {
    mkdirSync(join(dir, "worktree", "deep"), { recursive: true });
    writeFileSync(join(dir, "worktree", ".git"), "gitdir: /elsewhere\n");
    expect(insideGitTree(join(dir, "worktree", "deep", "app.pem"))).toBe(true);
  });

  it("accepts a directory no repository holds", () => {
    expect(insideGitTree(join(dir, "app.pem"))).toBe(false);
  });
});
