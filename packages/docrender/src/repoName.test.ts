import { GITHUB_REPO_NAME_MAX } from "@quiz/domain";
import { describe, expect, it } from "vitest";

import { assetContentType, journalAssetUrl } from "./assets.js";
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

describe("assets", () => {
  it("are served under the classroom, each segment encoded", () => {
    expect(journalAssetUrl("c1", "010-basics/images/a b#1.png")).toBe(
      "/app/api/classrooms/c1/journal/assets/010-basics/images/a%20b%231.png",
    );
  });

  it("take their content type from the extension, octet-stream otherwise", () => {
    expect(assetContentType("images/P.SVG")).toBe("image/svg+xml");
    expect(assetContentType("handout.pdf")).toBe("application/pdf");
    expect(assetContentType("archive.tar.xz")).toBe("application/octet-stream");
    expect(assetContentType("Makefile")).toBe("application/octet-stream");
  });
});
