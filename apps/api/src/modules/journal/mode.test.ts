/**
 * The journal's modes as types (`mode.ts`, ADR-057): the narrowing to a
 * GitHub-mode row, and the github.com edit link of a page.
 */
import { describe, expect, it } from "vitest";

import { editUrl, githubJournal, type GithubJournal, type JournalRow } from "./mode.js";

const row = (over: Partial<JournalRow> = {}): JournalRow =>
  ({
    classroomId: "c",
    mode: "github",
    githubRepoId: 42,
    fullName: "heig-prg/prg1-journal",
    ref: "main",
    rootPath: "",
    ...over,
  }) as JournalRow;

describe("githubJournal", () => {
  it("narrows a GitHub-mode row, and refuses a Quiz-mode one", () => {
    expect(githubJournal(row())).not.toBeNull();
    expect(githubJournal(row({ mode: "quiz", githubRepoId: null, fullName: null, ref: null }))).toBeNull();
  });
});

describe("editUrl", () => {
  const journal = (over: Partial<JournalRow> = {}) => githubJournal(row(over)) as GithubJournal;

  it("opens github.com's editor of the file on the journal's branch", () => {
    expect(editUrl(journal(), "README.md")).toBe("https://github.com/heig-prg/prg1-journal/edit/main/README.md");
  });

  it("puts the page under the root folder, keeps a branch's slashes, encodes each segment", () => {
    expect(editUrl(journal({ ref: "prof/s1", rootPath: "notes" }), "010-semaine/010 été #1.md")).toBe(
      "https://github.com/heig-prg/prg1-journal/edit/prof/s1/notes/010-semaine/010%20%C3%A9t%C3%A9%20%231.md",
    );
  });
});
