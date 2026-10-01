import { describe, expect, expectTypeOf, it } from "vitest";

import {
  Journal,
  JournalPage,
  JournalPageParams,
  JournalPageStaff,
  JournalPageStudent,
  JournalStaff,
  JournalStudent,
  JournalViewQuery,
  JournalRepository,
  JournalWarning,
  encodeJournalPath,
  safeJournalPath,
  GitRef,
  GithubRepoName,
  isSafeGitRef,
  JOURNAL_MARKDOWN_MAX,
  JOURNAL_PATH_MAX,
  JournalErrorCode,
  JournalCreate,
  JournalPageSave,
  JournalRefusal,
  JournalRemoveQuery,
  JournalRootPath,
  JournalUploadHeaders,
  assetContentType,
} from "./journal.js";

const ID = "018f0000-0000-7000-8000-000000000000";

const staffPage: JournalPageStaff = {
  view: "staff",
  path: "010-basics/020-pointers.md",
  title: "Pointers",
  html: "<p>x</p>",
  toc: [{ id: "pointers", depth: 1, text: "Pointers" }],
  updatedAt: "2026-09-30T08:00:00.000Z",
  draft: true,
  visibleFrom: null,
  hidden: true,
  markdown: "# Pointers\n",
  version: 3,
  warnings: [{ code: "raw_html" }],
  editUrl: "https://github.com/heig-prg/prg1-journal/edit/main/010-basics/020-pointers.md",
};

const studentPage: JournalPageStudent = {
  view: "student",
  path: staffPage.path,
  title: staffPage.title,
  html: staffPage.html,
  toc: staffPage.toc,
  updatedAt: staffPage.updatedAt,
};

describe("safeJournalPath (N-SEC-15)", () => {
  it("accepts a plain relative path", () => {
    expect(safeJournalPath("010-basics/images/p.svg")).toBe("010-basics/images/p.svg");
  });

  it.each([
    ["", "empty"],
    ["../secret.md", "a climbing segment"],
    ["a/../../b.md", "a climbing segment inside"],
    ["./a.md", "a dot segment"],
    ["a//b.md", "an empty segment"],
    ["/etc/passwd", "a leading slash"],
    ["a\\b.md", "a backslash"],
    ["a\u0000.md", "a NUL"],
    ["a\nb.md", "a newline"],
    ["x".repeat(401), "over 400 characters"],
    ["%2e%2e/secret.md", "an escaped climb"],
    ["a/%2E%2e/b.md", "an escaped climb, any case"],
    ["a%2fb.md", "an escaped slash"],
    ["a%5Cb.md", "an escaped backslash"],
    [".github/workflows/x.yml", "repository furniture"],
    ["docs/.gitignore", "a dot file"],
  ])("refuses %j (%s)", (raw) => {
    expect(safeJournalPath(raw)).toBeNull();
  });
});

describe("encodeJournalPath", () => {
  it("encodes each segment on its own and keeps the slashes", () => {
    expect(encodeJournalPath("20-semaine 2 été/10-tableaux #1.md")).toBe(
      "20-semaine%202%20%C3%A9t%C3%A9/10-tableaux%20%231.md",
    );
    expect(encodeJournalPath("README.md")).toBe("README.md");
  });

  it("round-trips through a per-segment decode", () => {
    const path = "a b/c?d/é%.md";
    expect(encodeJournalPath(path).split("/").map(decodeURIComponent).join("/")).toBe(path);
  });
});

describe("path parameters", () => {
  it("takes a page path and refuses an asset path, and the reverse", () => {
    expect(JournalPageParams.safeParse({ id: ID, "*": "README.md" }).success).toBe(true);
    expect(JournalPageParams.safeParse({ id: ID, "*": "images/p.svg" }).success).toBe(false);
    expect(JournalPageParams.safeParse({ id: ID, "*": "../README.md" }).success).toBe(false);
  });
});

describe("the student payloads (N-SEC-12)", () => {
  it("are distinct types from the staff ones", () => {
    expectTypeOf<JournalPageStaff>().not.toMatchTypeOf<JournalPageStudent>();
    expectTypeOf<JournalStaff>().not.toMatchTypeOf<JournalStudent>();
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("markdown");
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("blobSha");
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("version");
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("warnings");
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("draft");
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("visibleFrom");
    expectTypeOf<JournalStudent>().not.toHaveProperty("hiddenPaths");
    expectTypeOf<JournalStudent>().not.toHaveProperty("warningCount");
    expectTypeOf<JournalStudent>().not.toHaveProperty("repository");
    // A student never learns where the journal lives (ADR-057).
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("editUrl");
    expectTypeOf<JournalStudent>().not.toHaveProperty("mode");
  });

  it("accept the student fields", () => {
    expect(JournalPageStudent.parse(studentPage)).toEqual(studentPage);
  });

  it("refuse a staff page, and any staff field smuggled into a student one", () => {
    expect(JournalPageStudent.safeParse(staffPage).success).toBe(false);
    for (const key of ["markdown", "version", "warnings", "draft", "visibleFrom", "hidden", "editUrl"] as const) {
      const smuggled = { ...studentPage, [key]: staffPage[key] };
      expect(JournalPageStudent.safeParse(smuggled).success, key).toBe(false);
    }
  });

  it("refuse the hidden paths and counts in the navigation payload", () => {
    const student: JournalStudent = { view: "student", nav: [], homePath: null };
    expect(JournalStudent.parse(student)).toEqual(student);
    for (const extra of [{ hiddenPaths: ["a.md"] }, { warningCount: 1 }, { pageCount: 2 }, { repository: null }, { mode: "github" }]) {
      expect(JournalStudent.safeParse({ ...student, ...extra }).success).toBe(false);
    }
  });

  it("the union routes on the view", () => {
    expect(JournalPage.parse(staffPage).view).toBe("staff");
    expect(JournalPage.parse(studentPage).view).toBe("student");
    expect(JournalPage.safeParse({ ...staffPage, view: "student" }).success).toBe(false);
    const staff: JournalStaff = {
      view: "staff",
      mode: "quiz",
      repository: null,
      nav: [{ path: "010-a", title: "A", pagePath: null, children: [] }],
      homePath: null,
      hiddenPaths: [],
      warningCount: 0,
      pageCount: 0,
      proposedName: "prg1-2026-journal",
    };
    expect(Journal.parse(staff)).toEqual(staff);
  });

  it("?view can only narrow", () => {
    expect(JournalViewQuery.parse({ view: "student" })).toEqual({ view: "student" });
    expect(JournalViewQuery.parse({})).toEqual({});
    expect(JournalViewQuery.safeParse({ view: "staff" }).success).toBe(false);
  });
});

describe("warnings (J5)", () => {
  it("are codes with parameters, and a closed list", () => {
    expect(JournalWarning.safeParse({ code: "raw_html" }).success).toBe(true);
    expect(JournalWarning.safeParse({ code: "made_up" }).success).toBe(false);
    expect(
      JournalWarning.safeParse({ code: "raw_html", message: "Raw HTML is shown as text" }).success,
    ).toBe(false);
  });
});

describe("the repository state (invariant 1)", () => {
  const repo = {
    fullName: "heig-prg/notes",
    ref: "main",
    rootPath: "",
    htmlUrl: "https://github.com/heig-prg/notes",
    syncStatus: "error",
    syncError: "ref_not_found",
    lastSyncedAt: null,
    lastCommitSha: null,
    editable: false,
  };

  it("says why a synchronisation failed as a code, never a sentence", () => {
    expect(JournalRepository.parse(repo)).toEqual(repo);
    expect(JournalRepository.safeParse({ ...repo, syncError: "Branch main not found" }).success).toBe(false);
  });
});

describe("the writes' inputs (M4-03)", () => {
  it("a branch: what git accepts, and nothing that reads as an option or a path trick", () => {
    for (const ok of ["main", "course/2026", "release-1.2", "feature_x"]) expect(isSafeGitRef(ok), ok).toBe(true);
    for (const bad of ["", "-main", "a..b", "a//b", "/a", "a/", ".a", "a/.b", "a/./b", ".", "x.lock", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "a@{1}", "a\u0001", "x".repeat(256)]) {
      expect(isSafeGitRef(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(GitRef.safeParse("-x").success).toBe(false);
  });

  it("a root folder: trimmed, inside the repository, capped", () => {
    expect(JournalRootPath.parse("/docs/")).toBe("docs");
    expect(JournalRootPath.parse("")).toBe("");
    expect(JournalRootPath.parse("a/b")).toBe("a/b");
    for (const bad of ["../x", "a/../b", "a\\b", "a//b", ".github", "x".repeat(JOURNAL_PATH_MAX + 1)]) {
      expect(JournalRootPath.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("a repository name: GitHub's characters, never . nor ..", () => {
    expect(GithubRepoName.safeParse("prg1-2026.journal_x").success).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "é", "x".repeat(101)]) expect(GithubRepoName.safeParse(bad).success, bad).toBe(false);
  });

  it("a save: the version it was opened at, a capped page, nothing else", () => {
    expect(JournalPageSave.safeParse({ markdown: "# a", baseVersion: 4 }).success).toBe(true);
    expect(JournalPageSave.safeParse({ markdown: "# a", baseVersion: 1.5 }).success).toBe(false);
    expect(JournalPageSave.safeParse({ markdown: "# a", baseSha: "a".repeat(40) }).success).toBe(false);
    expect(JournalPageSave.safeParse({ markdown: "a".repeat(JOURNAL_MARKDOWN_MAX + 1), baseVersion: 0 }).success).toBe(false);
    expect(JournalPageSave.safeParse({ markdown: "", baseVersion: 0, extra: 1 }).success).toBe(false);
  });

  it("a removal's confirmation is the one parameter it takes", () => {
    expect(JournalRemoveQuery.parse({ confirm: "PRG1" })).toEqual({ confirm: "PRG1" });
    expect(JournalRemoveQuery.parse({})).toEqual({});
    expect(JournalRemoveQuery.safeParse({ force: "1" }).success).toBe(false);
  });

  it("a creation names its mode; only GitHub mode takes a name", () => {
    expect(JournalCreate.parse({ mode: "quiz" })).toEqual({ mode: "quiz" });
    expect(JournalCreate.parse({ mode: "github", name: "prg1" })).toEqual({ mode: "github", name: "prg1" });
    expect(JournalCreate.parse({ mode: "github" })).toEqual({ mode: "github" });
    for (const bad of [{}, { name: "prg1" }, { mode: "quiz", name: "prg1" }, { mode: "local" }]) {
      expect(JournalCreate.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("an upload declares the type of its extension, parameters dropped", () => {
    expect(assetContentType("images/P.SVG")).toBe("image/svg+xml");
    expect(assetContentType("handout.pdf")).toBe("application/pdf");
    expect(assetContentType("archive.tar.xz")).toBe("application/octet-stream");
    expect(assetContentType("Makefile")).toBe("application/octet-stream");
    expect(JournalUploadHeaders.parse({ "content-type": "Image/PNG; charset=binary" })["content-type"]).toBe("image/png");
    expect(JournalUploadHeaders.parse({})["content-type"]).toBe("");
  });

  it("a refusal is a code of the closed list", () => {
    expect(JournalRefusal.safeParse({ error: "conflict", message: "conflict" }).success).toBe(true);
    expect(JournalRefusal.safeParse({ error: "The file moved", message: "" }).success).toBe(false);
    expect(JournalErrorCode.options).toContain("github_unavailable");
  });
});
