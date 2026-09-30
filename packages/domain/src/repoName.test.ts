import { describe, expect, it } from "vitest";

import { GITHUB_REPO_NAME_MAX, repoName, SLUG_MAX, slugify } from "./repoName.js";

describe("slugify", () => {
  it("folds accents and collapses everything else to single dashes", () => {
    expect(slugify("Labo 1 — Liste chaînée")).toBe("labo-1-liste-chainee");
    expect(slugify("  Été / 2026  ")).toBe("ete-2026");
  });

  it("returns an empty slug when nothing is usable", () => {
    expect(slugify("—?!")).toBe("");
  });

  it("caps the slug", () => {
    expect(slugify("x".repeat(200))).toHaveLength(SLUG_MAX);
  });
});

describe("repoName", () => {
  it("returns the stem untouched when it fits", () => {
    expect(repoName("labo-01-group-1")).toBe("labo-01-group-1");
  });

  it("appends the disambiguator", () => {
    expect(repoName("labo-01-group-1", "a1b2c3d4")).toBe("labo-01-group-1-a1b2c3d4");
  });

  it("keeps the disambiguator whole and shortens the stem", () => {
    const name = repoName("x".repeat(200), "a1b2c3d4");
    expect(name).toHaveLength(GITHUB_REPO_NAME_MAX);
    expect(name.endsWith("-a1b2c3d4")).toBe(true);
  });

  it("never ends on the dash left by the cut", () => {
    // 92 characters then a dash: the cut lands exactly on it.
    const stem = `${"x".repeat(91)}-`;
    expect(repoName(stem, "a1b2c3d4")).toBe(`${"x".repeat(91)}-a1b2c3d4`);
  });
});
