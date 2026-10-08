import { describe, expect, it } from "vitest";

import {
  diffOutput,
  differsOnlyByWhitespace,
  missingFinalNewline,
  whitespaceKind,
  whitespaceSpans,
  type DiffLine,
} from "./outputDiff.js";

/** A diff line written as `op text`, changed characters in brackets. */
function show(lines: DiffLine[]): string[] {
  const mark = { equal: " ", removed: "-", added: "+" } as const;
  return lines.map(
    (l) => mark[l.op] + l.segments.map((s) => (s.changed ? `[${s.text}]` : s.text)).join(""),
  );
}

describe("whitespaceSpans", () => {
  it("gives the text back, character for character", () => {
    const text = "a  b\t c \r\nd\u00a0e\u200bf  \n";
    expect(whitespaceSpans(text).map((s) => s.text).join("")).toBe(text);
  });

  it("leaves a single space between words alone", () => {
    expect(whitespaceSpans("hello world")).toEqual([{ text: "hello world", ws: null }]);
  });

  it("marks a space that opens a line", () => {
    expect(whitespaceSpans(" 0\n 1").map((s) => s.ws)).toEqual(["space", null, "space", null]);
  });

  it("names the kind of one character", () => {
    expect(whitespaceKind(" ")).toBe("space");
    expect(whitespaceKind("\u00a0")).toBe("nbsp");
    expect(whitespaceKind("x")).toBeNull();
  });

  it("marks doubled and trailing spaces", () => {
    expect(whitespaceSpans("a  b ")).toEqual([
      { text: "a", ws: null },
      { text: "  ", ws: "space" },
      { text: "b", ws: null },
      { text: " ", ws: "space" },
    ]);
    expect(whitespaceSpans("a \nb")).toEqual([
      { text: "a", ws: null },
      { text: " ", ws: "space" },
      { text: "\nb", ws: null },
    ]);
  });

  it("marks a space followed only by a tab before the end of the line as trailing", () => {
    expect(whitespaceSpans("a \t\nb").map((s) => s.ws)).toEqual([null, "space", "tab", null]);
  });

  it("marks tabs, carriage returns, non-breaking and zero-width characters", () => {
    expect(whitespaceSpans("a\tb\r\nc\u00a0d\u200be").map((s) => s.ws)).toEqual([
      null,
      "tab",
      null,
      "cr",
      null,
      "nbsp",
      null,
      "zw",
      null,
    ]);
  });
});

describe("missingFinalNewline", () => {
  it("is only worth a marker when trailing newlines count", () => {
    expect(missingFinalNewline("6")).toBe(false);
    expect(missingFinalNewline("6", { trimTrailing: false })).toBe(true);
    expect(missingFinalNewline("6\n", { trimTrailing: false })).toBe(false);
    expect(missingFinalNewline("", { trimTrailing: false })).toBe(false);
  });
});

describe("differsOnlyByWhitespace", () => {
  it("spots outputs that look the same", () => {
    expect(differsOnlyByWhitespace("1 2 3", "1  2 3")).toBe(true);
    expect(differsOnlyByWhitespace("a\tb", "a    b")).toBe(true);
    expect(differsOnlyByWhitespace("ab", "a\u200bb")).toBe(true);
    expect(differsOnlyByWhitespace("1 2 3", "1 2 4")).toBe(false);
    expect(differsOnlyByWhitespace("same", "same")).toBe(false);
  });

  it("ignores what the comparison ignores", () => {
    expect(differsOnlyByWhitespace("6", "6  \n\n")).toBe(false);
    expect(differsOnlyByWhitespace("6", "6  \n\n", { trimTrailing: false })).toBe(true);
    expect(differsOnlyByWhitespace("1 2", "1   2", { numeric: { epsilon: 0, mode: "abs" } })).toBe(false);
  });

  it("follows ignoreCase", () => {
    expect(differsOnlyByWhitespace("OK", "o k")).toBe(false);
    expect(differsOnlyByWhitespace("OK", "o k", { ignoreCase: true })).toBe(true);
  });
});

describe("diffOutput", () => {
  it("reports identical outputs as equal lines", () => {
    expect(show(diffOutput("a\nb\n", "a\nb\n"))).toEqual([" a", " b"]);
  });

  it("diffs lines, then characters inside a changed line", () => {
    expect(show(diffOutput("sum = 6\nbye\n", "sum =  6\nbye\n"))).toEqual([
      "-sum = 6",
      "+sum = [ ]6",
      " bye",
    ]);
  });

  it("lists a missing and an extra line whole", () => {
    expect(show(diffOutput("a\nb\nc", "a\nc"))).toEqual([" a", "-[b]", " c"]);
    expect(show(diffOutput("a\nc", "a\nb\nc"))).toEqual([" a", "+[b]", " c"]);
  });

  it("pairs the lines of a changed block in order", () => {
    expect(show(diffOutput("x1\nx2\nz", "y1\ny2\nz"))).toEqual([
      "-[x]1",
      "-[x]2",
      "+[y]1",
      "+[y]2",
      " z",
    ]);
  });

  it("keeps a common line between two changed ones", () => {
    expect(show(diffOutput("x\nc\ny", "p\nc\nq"))).toEqual(["-[x]", "+[p]", " c", "-[y]", "+[q]"]);
  });

  it("does not flag what trimTrailing ignores", () => {
    expect(show(diffOutput("6\n", "6   \n\n\n"))).toEqual([" 6   "]);
    // The trailing spaces of a changed line are shown, never marked.
    expect(show(diffOutput("a b", "a  b  "))).toEqual(["-a b", "+a [ ]b  "]);
  });

  it("flags trailing whitespace and a missing final newline when they count", () => {
    expect(show(diffOutput("6\n", "6 \n", { trimTrailing: false }))).toEqual(["-6", "+6[ ]"]);
    expect(show(diffOutput("6\n\n", "6\n", { trimTrailing: false }))).toEqual([" 6", "-[]"]);
    const noEol = diffOutput("a\n6\n", "a\n6", { trimTrailing: false });
    expect(show(noEol)).toEqual([" a", "-6", "+6"]);
    expect(noEol.map((l) => l.noNewline === true)).toEqual([false, false, true]);
    // Without trimTrailing: false, the final newline never counts.
    expect(diffOutput("6\n", "6").some((l) => l.noNewline)).toBe(false);
  });

  it("follows ignoreCase", () => {
    expect(show(diffOutput("OK\n", "ok\n", { ignoreCase: true }))).toEqual([" ok"]);
    expect(show(diffOutput("OK\n", "ok\n"))).toEqual(["-[OK]", "+[ok]"]);
  });

  it("treats CRLF as a line ending", () => {
    expect(show(diffOutput("a\nb\n", "a\r\nb\r\n"))).toEqual([" a\r", " b\r"]);
  });

  it("does not present the runner's cut as a difference", () => {
    const expected = "line 1\nline 2\nline 3\nline 4\n";
    const actual = "line 1\nline 2\nli";
    expect(show(diffOutput(expected, actual, { truncated: true }))).toEqual([
      " line 1",
      " line 2",
      " li",
    ]);
    // Without the flag, the same outputs differ.
    expect(show(diffOutput(expected, actual))).toContain("-[line 4]");
  });

  it("stays usable on outputs too large for the table", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    const lines = diffOutput(a, b);
    expect(lines.filter((l) => l.op === "removed")).toHaveLength(3000);
    expect(lines.filter((l) => l.op === "added")).toHaveLength(3000);
  });
});
