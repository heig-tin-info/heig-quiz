import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AnswerChip,
  ChoiceMark,
  ClampedCode,
  countTone,
  headerOf,
  NoAnswer,
  runStatus,
  WordChip,
} from "./grading.js";

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

describe("ClampedCode", () => {
  const more = (n: number) => `${n} more lines`;
  const seven = ["a", "b", "c", "d", "e", "f", "g"].join("\n");

  it("is a plain box, not a button, when the program fits or overflows by one line", () => {
    render(<ClampedCode code={seven.slice(0, 11)} more={more} expand="Show all" collapse="Fold" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("pre")!.className).toContain("w-full");
  });

  it("clamps a long program, says how much it hides, and unfolds in place", () => {
    const outer = { clicks: 0 };
    render(
      <div onClick={() => (outer.clicks += 1)} onKeyDown={() => (outer.clicks += 1)}>
        <ClampedCode code={seven} more={more} expand="Show all" collapse="Fold" />
      </div>,
    );
    const box = screen.getByRole("button", { expanded: false });
    expect(box).toHaveAttribute("title", "Show all");
    expect(screen.getByText(/2 more lines/)).toBeInTheDocument();
    expect(box).toHaveAttribute("data-clamped");

    fireEvent.click(box);
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText(/more lines/)).toBeNull();
    expect(box).not.toHaveAttribute("data-clamped");

    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveAttribute("aria-expanded", "false");
    // Neither the click nor the key reached the row: the panel stays shut.
    expect(outer.clicks).toBe(0);
  });

  it("writes the key in info", () => {
    render(<ClampedCode code="ref" tone="expected" more={more} expand="" collapse="" />);
    expect(screen.getByText("ref").className).toContain("text-info");
  });
});

describe("runStatus", () => {
  it("reads the runner of a breakdown", () => {
    expect(runStatus({ runner: "ok" })).toBe("ran");
    expect(runStatus({ runner: "busy" })).toBe("waiting");
    expect(runStatus({ runner: "unavailable" })).toBe("waiting");
    expect(runStatus({ runner: "error" })).toBe("failed");
    expect(runStatus({ runner: "none" })).toBeNull();
  });

  it("waits for a grading not written yet, or a marker a new pass may clear", () => {
    expect(runStatus(null)).toBe("waiting");
    expect(runStatus({ reason: "runner_unavailable" })).toBe("waiting");
    expect(runStatus({ reason: "runner_busy" })).toBe("waiting");
    expect(runStatus({ reason: "template_region_mismatch" })).toBe("failed");
  });

  it("says nothing of a run on a teacher's override", () => {
    expect(runStatus({ manual: true })).toBeNull();
  });
});

describe("countTone", () => {
  it("is good for all, bad for none, partial in between", () => {
    expect(countTone(3, 3)).toBe("good");
    expect(countTone(0, 3)).toBe("bad");
    expect(countTone(2, 3)).toBe("partial");
  });
});

describe("headerOf", () => {
  it("is one plain line, cut with an ellipsis, the whole text as its title", () => {
    expect(headerOf("`int`\n  a", 32)).toEqual({ label: "int a", title: "int a" });
    const long = headerOf("A very long card text that goes on and on", 10);
    expect(long.label).toBe("A very lo…");
    expect(long.title).toBe("A very long card text that goes on and on");
  });
});

describe("WordChip", () => {
  it("is a chip in the text face, its text as its tooltip", () => {
    render(<WordChip tone="partial" text="2/3 tests" />);
    const chip = screen.getByText("2/3 tests");
    expect(chip).toHaveAttribute("title", "2/3 tests");
    expect(chip.className).not.toContain("font-mono");
    expect(chip.className).toContain("outline-dashed");
  });
});
