import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnswerChip, ChoiceMark, NoAnswer } from "./grading.js";

describe("AnswerChip", () => {
  it("tints the student's text by its verdict, and the key in info without a fill", () => {
    render(
      <>
        <AnswerChip tone="good">malloc</AnswerChip>
        <AnswerChip tone="bad">new</AnswerChip>
        <AnswerChip tone="expected">calloc</AnswerChip>
      </>,
    );
    expect(screen.getByText("malloc").className).toContain("bg-success-soft text-success");
    expect(screen.getByText("new").className).toContain("bg-danger-soft text-danger");
    expect(screen.getByText("calloc").className).toContain("text-info");
    expect(screen.getByText("calloc").className).not.toContain("bg-");
  });
});

describe("ChoiceMark", () => {
  it("names its state in words, since a fill is not a name", () => {
    render(<ChoiceMark state="missed" label="Missed" />);
    const mark = screen.getByRole("img", { name: "Missed" });
    expect(mark.className).toContain("border-dashed border-success");
  });
});

describe("NoAnswer", () => {
  it("is quiet italic text, never a verdict colour", () => {
    render(<NoAnswer>no answer</NoAnswer>);
    expect(screen.getByText("no answer").className).toContain("italic text-fg-faint");
  });
});
