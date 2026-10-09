import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emptyNotes,
  endNotepad,
  loadNotes,
  MAX_PAGE_LENGTH,
  notepadKey,
  parseNotes,
  purgeAllNotepads,
  purgeStaleNotepads,
  saveNotes,
  STALE_MS,
} from "./store";

/* Where the notepad lives between two loads (ADR-090 §4): this device only, one key per attempt. */
const notes = (savedAt: number, pages = ["a"]) => ({ pages, page: 0, checkpoint: -1, savedAt });

afterEach(() => vi.restoreAllMocks());

describe("the notepad's storage", () => {
  it("keeps the notes of an attempt under its own key", () => {
    expect(notepadKey("att-1")).toBe("quiz.notepad.att-1");
    expect(saveNotes("att-1", notes(5, ["x", "y"]))).toBe(true);
    expect(JSON.parse(localStorage.getItem("quiz.notepad.att-1")!)).toEqual(notes(5, ["x", "y"]));
    expect(loadNotes("att-1")).toEqual(notes(5, ["x", "y"]));
  });

  it("reads anything malformed as nothing, and clamps what it reads", () => {
    expect(parseNotes("{")).toBeNull();
    expect(parseNotes(JSON.stringify({ pages: [], page: 0, checkpoint: -1, savedAt: 1 }))).toBeNull();
    expect(parseNotes(JSON.stringify({ pages: [1], page: 0, checkpoint: -1, savedAt: 1 }))).toBeNull();
    const long = parseNotes(JSON.stringify({ pages: ["z".repeat(MAX_PAGE_LENGTH + 5)], page: 9, checkpoint: 2, savedAt: 1 }));
    expect(long?.pages[0]).toHaveLength(MAX_PAGE_LENGTH);
    expect(long?.page).toBe(0);
  });

  it("says when the device refuses a write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(saveNotes("att-2", emptyNotes(-1))).toBe(false);
  });

  it("deletes an ended attempt's notes, and a late write does not bring them back", () => {
    saveNotes("att-3", notes(1));
    endNotepad("att-3");
    expect(localStorage.getItem(notepadKey("att-3"))).toBeNull();
    saveNotes("att-3", notes(2));
    expect(localStorage.getItem(notepadKey("att-3"))).toBeNull();
  });

  it("on a player's load, removes the stale notes only — never another recent attempt's", () => {
    const now = 10 * STALE_MS;
    saveNotes("old", notes(now - STALE_MS - 1));
    saveNotes("other-tab", notes(now - 60_000));
    localStorage.setItem(notepadKey("broken"), "nope");
    localStorage.setItem("quiz.theme", "dark");
    purgeStaleNotepads(now);
    expect(localStorage.getItem(notepadKey("old"))).toBeNull();
    expect(localStorage.getItem(notepadKey("broken"))).toBeNull();
    expect(loadNotes("other-tab")).not.toBeNull();
    expect(localStorage.getItem("quiz.theme")).toBe("dark");
  });

  it("at sign-out or on a station, removes every notepad and nothing else", () => {
    saveNotes("one", notes(1));
    saveNotes("two", notes(2));
    localStorage.setItem("quiz.theme", "dark");
    purgeAllNotepads();
    expect(Object.keys(localStorage).filter((k) => k.startsWith("quiz.notepad."))).toEqual([]);
    expect(localStorage.getItem("quiz.theme")).toBe("dark");
  });
});
