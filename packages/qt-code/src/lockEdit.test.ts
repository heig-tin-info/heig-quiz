import { describe, expect, it } from "vitest";

import { splitTemplate, templateMarkerIssues } from "@quiz/domain/lockedTemplate";

import { isLockedLineRange, lockedLineNumbers, lockLines, selectedLines, unlockLines } from "./lockEdit.js";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const PLAIN = lines("#include <stdio.h>", "int main(void) {", "    return 0;", "}");

/** Every template this file writes must be free of marker issues. */
const clean = (template: string, language: "c" | "python" = "c") => {
  expect(templateMarkerIssues(template, language)).toEqual([]);
  return template;
};

describe("lockLines", () => {
  it("wraps editable lines in markers of the language's comment syntax", () => {
    expect(clean(lockLines(PLAIN, "c", 2, 2))).toBe(
      lines("#include <stdio.h>", "// @@lock", "int main(void) {", "// @@endlock", "    return 0;", "}"),
    );
    expect(clean(lockLines(lines("import sys", "x = 1"), "python", 1, 1), "python")).toBe(
      lines("# @@lock", "import sys", "# @@endlock", "x = 1"),
    );
  });

  it("locks the whole file, and keeps a template without a final line break so", () => {
    expect(lockLines(PLAIN, "c", 1, 4)).toBe(`// @@lock\n${PLAIN}// @@endlock\n`);
    expect(lockLines("a\nb", "c", 1, 2)).toBe("// @@lock\na\nb\n// @@endlock");
  });

  it("merges with a region it touches instead of stacking a second one", () => {
    const template = lines("a", "// @@lock", "b", "// @@endlock", "c");
    // `c` follows the region: the close moves below it.
    expect(clean(lockLines(template, "c", 5, 5))).toBe(lines("a", "// @@lock", "b", "c", "// @@endlock"));
    // `a` precedes it: the open moves above it.
    expect(clean(lockLines(template, "c", 1, 1))).toBe(lines("// @@lock", "a", "b", "// @@endlock", "c"));
  });

  it("merges two regions when the selection spans the gap between them", () => {
    const template = lines("// @@lock", "a", "// @@endlock", "b", "// @@lock", "c", "// @@endlock");
    expect(clean(lockLines(template, "c", 2, 6))).toBe(lines("// @@lock", "a", "b", "c", "// @@endlock"));
  });

  it("keeps the spelling of the markers it keeps, and leaves distant ones alone", () => {
    const template = lines("/* @@lock */", "a", "// @@unlock", "b", "c", "// @@lock", "d", "// @@unlock");
    expect(clean(lockLines(template, "c", 4, 4))).toBe(
      lines("/* @@lock */", "a", "b", "// @@unlock", "c", "// @@lock", "d", "// @@unlock"),
    );
  });

  it("changes nothing when the lines are already locked", () => {
    const template = lines("// @@lock", "a", "b", "// @@endlock", "c");
    expect(lockLines(template, "c", 2, 3)).toBe(template);
  });

  it("changes nothing for a selection of marker lines only, or past the end", () => {
    const template = lines("// @@lock", "a", "// @@endlock");
    expect(lockLines(template, "c", 1, 1)).toBe(template);
    expect(lockLines(template, "c", 9, 12)).toBe(template);
  });

  it("drops a stray marker inside the selection rather than letting it start to count", () => {
    const template = lines("a", "// @@endlock", "b");
    expect(clean(lockLines(template, "c", 1, 3))).toBe(lines("// @@lock", "a", "b", "// @@endlock"));
  });

  it("keeps unknown words and @@next as ordinary lines", () => {
    const template = lines("a", "// @@unlok", "b");
    expect(lockLines(template, "c", 1, 3)).toBe(lines("// @@lock", "a", "// @@unlok", "b", "// @@endlock"));
  });

  it("produces exactly the split the server reads", () => {
    const locked = lockLines(PLAIN, "c", 3, 4);
    expect(splitTemplate(locked, "c").map((s) => s.kind)).toEqual(["editable", "locked"]);
    expect(lockedLineNumbers(locked, "c")).toEqual([3, 4, 5, 6]);
  });
});

describe("unlockLines", () => {
  const REGION = lines("// @@lock", "a", "b", "c", "// @@endlock", "d");

  it("removes a whole region", () => {
    expect(clean(unlockLines(REGION, "c", 2, 4))).toBe(lines("a", "b", "c", "d"));
    // Selecting the markers too makes no difference.
    expect(clean(unlockLines(REGION, "c", 1, 5))).toBe(lines("a", "b", "c", "d"));
  });

  it("splits a region when the selection sits in its middle", () => {
    expect(clean(unlockLines(REGION, "c", 3, 3))).toBe(
      lines("// @@lock", "a", "// @@endlock", "b", "// @@lock", "c", "// @@endlock", "d"),
    );
  });

  it("shrinks a region from either end", () => {
    expect(clean(unlockLines(REGION, "c", 2, 2))).toBe(lines("a", "// @@lock", "b", "c", "// @@endlock", "d"));
    expect(clean(unlockLines(REGION, "c", 4, 4))).toBe(lines("// @@lock", "a", "b", "// @@endlock", "c", "d"));
  });

  it("unlocks the tail of a region left open to the end of the file", () => {
    expect(clean(unlockLines(lines("x", "// @@lock", "a", "b"), "c", 4, 4))).toBe(
      lines("x", "// @@lock", "a", "// @@endlock", "b"),
    );
  });

  it("round-trips with lockLines", () => {
    const locked = lockLines(PLAIN, "c", 2, 3);
    expect(unlockLines(locked, "c", 3, 4)).toBe(PLAIN);
  });

  it("leaves editable lines as they are", () => {
    expect(unlockLines(PLAIN, "c", 1, 4)).toBe(PLAIN);
  });
});

describe("isLockedLineRange", () => {
  const TEMPLATE = lines("a", "// @@lock", "b", "c", "// @@endlock", "d");

  it("is true only when every content line of the range is locked", () => {
    expect(isLockedLineRange(TEMPLATE, "c", 3, 4)).toBe(true);
    expect(isLockedLineRange(TEMPLATE, "c", 2, 5)).toBe(true);
    expect(isLockedLineRange(TEMPLATE, "c", 1, 3)).toBe(false);
    expect(isLockedLineRange(TEMPLATE, "c", 6, 6)).toBe(false);
  });

  it("is false for markers alone or past the end", () => {
    expect(isLockedLineRange(TEMPLATE, "c", 2, 2)).toBe(false);
    expect(isLockedLineRange(TEMPLATE, "c", 10, 11)).toBe(false);
  });

  it("reads @@unlock as a close", () => {
    const template = lines("// @@lock", "a", "// @@unlock", "b");
    expect(isLockedLineRange(template, "c", 2, 2)).toBe(true);
    expect(isLockedLineRange(template, "c", 4, 4)).toBe(false);
  });
});

describe("lockedLineNumbers", () => {
  it("counts the markers of a region and nothing of the editable lines", () => {
    expect(lockedLineNumbers(lines("a", "# @@lock", "b", "# @@unlock", "c"), "python")).toEqual([2, 3, 4]);
    expect(lockedLineNumbers(PLAIN, "c")).toEqual([]);
  });
});

describe("selectedLines", () => {
  const text = "ab\ncd\nef";

  it("maps offsets to 1-based lines", () => {
    expect(selectedLines(text, 0, 1)).toEqual({ from: 1, to: 1 });
    expect(selectedLines(text, 1, 4)).toEqual({ from: 1, to: 2 });
    expect(selectedLines(text, 6, 8)).toEqual({ from: 3, to: 3 });
  });

  it("does not take the line a selection ends at the very start of", () => {
    expect(selectedLines(text, 0, 3)).toEqual({ from: 1, to: 1 });
    expect(selectedLines(text, 0, 6)).toEqual({ from: 1, to: 2 });
  });

  it("is null for an empty selection", () => {
    expect(selectedLines(text, 2, 2)).toBeNull();
  });
});
