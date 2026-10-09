import { beforeEach, describe, expect, it } from "vitest";

import { forgetNotepadCopy, isFromNotepad, recordNotepadCopy } from "./clipboard";

/*
 * The exemption the integrity journal's paste step will read (ADR-090 §6,
 * ADR-088): only the LAST text copied out of the notepad, exactly.
 */
describe("the notepad's last copy", () => {
  beforeEach(() => forgetNotepadCopy());

  it("knows nothing before a copy", () => {
    expect(isFromNotepad("x = 3")).toBe(false);
  });

  it("matches the last copied text exactly, and nothing else", () => {
    recordNotepadCopy("x = 3");
    expect(isFromNotepad("x = 3")).toBe(true);
    expect(isFromNotepad("x = 3 ")).toBe(false);
    expect(isFromNotepad("x =")).toBe(false);
    recordNotepadCopy("y = 4");
    expect(isFromNotepad("x = 3")).toBe(false);
    expect(isFromNotepad("y = 4")).toBe(true);
  });

  it("ignores an empty selection, and forgets at the end of the attempt", () => {
    recordNotepadCopy("kept");
    recordNotepadCopy("");
    expect(isFromNotepad("kept")).toBe(true);
    expect(isFromNotepad("")).toBe(false);
    forgetNotepadCopy();
    expect(isFromNotepad("kept")).toBe(false);
  });
});
