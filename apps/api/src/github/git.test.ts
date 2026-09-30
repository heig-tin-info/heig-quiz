import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { authUrl, gitRunner } from "./git.js";

// The token patterns themselves are tested with `redactTokens` (redact.test.ts).
describe("gitRunner", () => {
  const dir = mkdtempSync(join(tmpdir(), "quiz-git-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("throws a redacted error on failure", () => {
    const { git } = gitRunner();
    let message = "";
    try {
      // Not a repository: git fails locally, without any network.
      git(dir, "push", authUrl("ghs_secret123", "none", "none"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("ghs_secret123");
  });

  it("commits as the bot when asked for an identity", () => {
    const { git } = gitRunner({ identity: true });
    git(dir, "init", "-q", "-b", "main");
    // No signing: a workstation's global config must not change the outcome.
    git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "empty");
    expect(git(dir, "log", "-1", "--format=%an <%ae>").trim()).toBe("heig-quiz <bot@heig-quiz.local>");
  });
});

describe("authUrl", () => {
  it("carries the installation token as the x-access-token user", () => {
    expect(authUrl("t0k", "org", "repo")).toBe("https://x-access-token:t0k@github.com/org/repo.git");
  });
});
