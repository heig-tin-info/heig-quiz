/**
 * The `rich` column of the grading table (ADR-040): the essay as plain text,
 * clamped to three lines, and the grader's guide on the expected row.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { plainText, richGrading } from "./grading.js";
import type { RichStudent } from "./schema.js";

const markdown: RichStudent = { prompt: "Stack or heap?", format: "markdown" };
const [column] = richGrading.columns(markdown, { rubric: "**2 pts**: lifetime", reference: "" });
const html = (node: unknown) => render(<>{node}</>).container;

describe("plainText", () => {
  it("strips the marks of markdown to the words a reader sees", () => {
    expect(plainText("# Title\n\nThe **stack** is _fast_, see [the doc](http://x).")).toBe(
      "Title The stack is fast, see the doc.",
    );
    expect(plainText("- one\n- two\n1. three\n> quoted")).toBe("one two three quoted");
    expect(plainText("```c\nint *p = malloc(4);\n```")).toBe("int *p = malloc(4);");
    expect(plainText("Use `malloc` and ![a heap](h.png)")).toBe("Use malloc and a heap");
    expect(plainText("snake_case_name and 2 * 3 * 4 and a\\*b")).toBe("snake_case_name and 2 * 3 * 4 and a*b");
  });

  it("never lets markup through as markup", () => {
    expect(plainText('<img src=x onerror="alert(1)">Hello <b>there</b>')).toBe("Hello there");
    // A comparison is not a tag ("<y and y>" would be one: HTML reads it so too).
    expect(plainText("x < y and y > z, 3<4")).toBe("x < y and y > z, 3<4");
    expect(plainText("while i<n")).toBe("while i<n");
  });
});

describe("rich grading column", () => {
  it("is one column holding the essay as plain text, clamped to three lines", () => {
    expect(column!.label).toBe("Essay");
    const cell = html(column!.cell({ answer: { text: "The **heap** lives\n\nuntil `free`." }, details: null }));
    const p = cell.querySelector("p")!;
    expect(p.textContent).toBe("The heap lives until free.");
    expect(p.className).toContain("line-clamp-3");
    expect(cell.querySelector("strong, code")).toBeNull();
  });

  it("keeps a plain-text essay as typed", () => {
    const [plain] = richGrading.columns({ ...markdown, format: "plain" }, null);
    expect(html(plain!.cell({ answer: { text: "a **b**\n c" }, details: null })).textContent).toBe("a **b** c");
  });

  it("puts the model answer on the expected row, else the rubric, in info", () => {
    const rubric = html(column!.expected()).querySelector("p")!;
    expect(rubric.textContent).toBe("2 pts: lifetime");
    expect(rubric.className).toContain("text-info");
    const [withReference] = richGrading.columns(markdown, { rubric: "r", reference: "The *model*." });
    expect(html(withReference!.expected()).textContent).toBe("The model.");
    expect(html(richGrading.columns(markdown, null)[0]!.expected()).textContent).toBe("—");
  });

  it("sorts by the text, normalised", () => {
    expect(column!.sortKey({ text: "  The **Stack**  " })).toBe("the stack");
    expect(column!.sortKey(null)).toBe("");
  });
});
