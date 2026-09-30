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
  safeJournalPath,
} from "./journal.js";

const SHA = "a".repeat(40);
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
  blobSha: SHA,
  warnings: [{ code: "raw_html" }],
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
  ])("refuses %j (%s)", (raw) => {
    expect(safeJournalPath(raw)).toBeNull();
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
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("warnings");
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("draft");
    expectTypeOf<JournalPageStudent>().not.toHaveProperty("visibleFrom");
    expectTypeOf<JournalStudent>().not.toHaveProperty("hiddenPaths");
    expectTypeOf<JournalStudent>().not.toHaveProperty("warningCount");
    expectTypeOf<JournalStudent>().not.toHaveProperty("repository");
  });

  it("accept the student fields", () => {
    expect(JournalPageStudent.parse(studentPage)).toEqual(studentPage);
  });

  it("refuse a staff page, and any staff field smuggled into a student one", () => {
    expect(JournalPageStudent.safeParse(staffPage).success).toBe(false);
    for (const key of ["markdown", "blobSha", "warnings", "draft", "visibleFrom", "hidden"] as const) {
      const smuggled = { ...studentPage, [key]: staffPage[key] };
      expect(JournalPageStudent.safeParse(smuggled).success, key).toBe(false);
    }
  });

  it("refuse the hidden paths and counts in the navigation payload", () => {
    const student: JournalStudent = { view: "student", nav: [], homePath: null };
    expect(JournalStudent.parse(student)).toEqual(student);
    for (const extra of [{ hiddenPaths: ["a.md"] }, { warningCount: 1 }, { repository: null }]) {
      expect(JournalStudent.safeParse({ ...student, ...extra }).success).toBe(false);
    }
  });

  it("the union routes on the view", () => {
    expect(JournalPage.parse(staffPage).view).toBe("staff");
    expect(JournalPage.parse(studentPage).view).toBe("student");
    expect(JournalPage.safeParse({ ...staffPage, view: "student" }).success).toBe(false);
    const staff: JournalStaff = {
      view: "staff",
      repository: null,
      nav: [{ path: "010-a", title: "A", pagePath: null, children: [] }],
      homePath: null,
      hiddenPaths: [],
      warningCount: 0,
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
