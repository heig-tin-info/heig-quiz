import { GITHUB_REPO_NAME_MAX } from "@quiz/domain";
import { describe, expect, it } from "vitest";

import { journalRepoName } from "./repoName.js";

describe("journalRepoName", () => {
  it("is the classroom's slug then the word journal", () => {
    expect(journalRepoName("PROG C 2026-2027")).toBe("prog-c-2026-2027-journal");
  });

  it("disambiguates with the suffix given", () => {
    expect(journalRepoName("prog-c", "0f1e2d3c")).toBe("prog-c-journal-0f1e2d3c");
  });

  it("names a classroom whose name has no usable character", () => {
    expect(journalRepoName("???")).toBe("classroom-journal");
  });

  it("stays inside GitHub's limit for a maximal classroom name", () => {
    expect(journalRepoName("c".repeat(300), "0f1e2d3c").length).toBeLessThanOrEqual(
      GITHUB_REPO_NAME_MAX,
    );
  });
});
