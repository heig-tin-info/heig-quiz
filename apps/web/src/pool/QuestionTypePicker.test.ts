import { describe, expect, it } from "vitest";
import { CREATABLE_TYPE_IDS } from "../questionTypes";
import { columnsFor, groupTypes, pickerLayout } from "./QuestionTypePicker";

describe("columnsFor", () => {
  it("keeps a pair on two columns", () => {
    expect(columnsFor(1)).toBe(2);
    expect(columnsFor(2)).toBe(2);
  });

  it("picks the count that leaves the fewest empty cells, four on a tie", () => {
    expect([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(columnsFor)).toEqual([3, 4, 3, 3, 4, 4, 3, 4, 4, 4]);
  });
});

describe("pickerLayout", () => {
  it("shows up to a dozen types flat on a large screen", () => {
    expect(pickerLayout(12, 2, true)).toBe("grid");
    expect(pickerLayout(13, 2, true)).toBe("tabs");
  });

  it("files the types under tabs on a small screen, whatever their count", () => {
    expect(pickerLayout(4, 2, false)).toBe("tabs");
    expect(pickerLayout(12, 2, false)).toBe("tabs");
  });

  it("never draws tabs for one family", () => {
    expect(pickerLayout(2, 1, false)).toBe("grid");
    expect(pickerLayout(20, 1, true)).toBe("grid");
  });
});

describe("groupTypes", () => {
  it("files each type under its own family, in the caller's order", () => {
    expect(groupTypes(CREATABLE_TYPE_IDS)).toEqual([
      { group: "basics", types: ["mcq", "short", "cloze", "rich", "categorize", "math"] },
      { group: "engineering", types: ["code", "circuit", "logic", "codeimage", "diagram", "blocks"] },
    ]);
  });

  it("leaves an empty family out", () => {
    expect(groupTypes(["mcq", "short"])).toEqual([{ group: "basics", types: ["mcq", "short"] }]);
  });
});
