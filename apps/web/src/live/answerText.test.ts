import { describe, expect, it } from "vitest";

import { answerText, CODE_LINES, isEmptyAnswerText, TEXT_CHARS } from "./answerText";

describe("answerText (#94)", () => {
  it("names the ticked choices by canonical letter and label, whatever the display order", () => {
    // The student saw the choices shuffled: C, A, B.
    const student = {
      prompt: "?",
      mode: "multiple",
      choices: [
        { id: 2, text: "free()" },
        { id: 0, text: "malloc()" },
        { id: 1, text: "calloc()" },
      ],
    };
    expect(answerText("mcq", student, { selected: [2, 0] })).toEqual({
      kind: "choices",
      items: [
        { letter: "A", text: "malloc()" },
        { letter: "C", text: "free()" },
      ],
    });
  });

  it("reads an mcq with nothing ticked as empty", () => {
    const text = answerText("mcq", { choices: [] }, { selected: [] });
    expect(text).toEqual({ kind: "choices", items: [] });
    expect(isEmptyAnswerText(text!)).toBe(true);
  });

  it("lists the blanks in order, dropdowns by their label, empty ones as null", () => {
    const student = {
      template: "⸢0⸣ ⸢1⸣ ⸢2⸣",
      blanks: [
        { index: 0, weight: 1, kind: "input", numeric: false },
        { index: 1, weight: 1, kind: "select", options: [{ id: 0, label: "int" }, { id: 1, label: "char" }] },
        { index: 2, weight: 1, kind: "input", numeric: true },
      ],
    };
    expect(answerText("cloze", student, { blanks: ["  malloc ", "1", ""] })).toEqual({
      kind: "blanks",
      items: ["malloc", "char", null],
    });
  });

  it("keeps a short answer whole, and caps a pasted essay", () => {
    expect(answerText("short", {}, { text: " 0x1004 " })).toEqual({
      kind: "text",
      text: "0x1004",
      truncated: false,
    });
    const long = answerText("short", {}, { text: "x".repeat(TEXT_CHARS + 50) });
    expect(long).toMatchObject({ kind: "text", truncated: true });
    expect(long?.kind === "text" && long.text.length).toBe(TEXT_CHARS + 1);
  });

  it("gives the first lines of a program, region after region", () => {
    expect(answerText("code", {}, { regions: ["int x = 1;\n", "", "return x;"] })).toEqual({
      kind: "code",
      lines: ["int x = 1;", "", "return x;"],
      truncated: false,
    });
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const text = answerText("codeimage", {}, { regions: [many] });
    expect(text).toMatchObject({ kind: "code", truncated: true });
    expect(text?.kind === "code" && text.lines).toHaveLength(CODE_LINES);
  });

  it("drops the indentation every line shares", () => {
    expect(answerText("code", {}, { regions: ["    if (p) {\n      free(p);\n    }"] })).toEqual({
      kind: "code",
      lines: ["if (p) {", "  free(p);", "}"],
      truncated: false,
    });
  });

  it("reads a program with only blank regions as empty", () => {
    const text = answerText("code", {}, { regions: ["  ", ""] });
    expect(isEmptyAnswerText(text!)).toBe(true);
  });

  it("gives null for no answer, an unknown type or a shape it does not read", () => {
    expect(answerText("short", {}, null)).toBeNull();
    expect(answerText("circuit", {}, { schematic: { components: [], wires: [] } })).toBeNull();
    expect(answerText("mcq", {}, { selected: "A" })).toBeNull();
    expect(answerText("cloze", {}, "oops")).toBeNull();
    expect(answerText("code", {}, { regions: 3 })).toBeNull();
  });
});
