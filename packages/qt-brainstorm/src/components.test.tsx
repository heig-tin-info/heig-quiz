import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BrainstormPlayer } from "./Player.js";

const student = { prompt: "Un être vivant ?", maxIdeas: 2 };

describe("BrainstormPlayer", () => {
  it("adds an idea as the whole answer, once per idea", async () => {
    const onChange = vi.fn();
    render(<BrainstormPlayer student={student} answer={{ ideas: ["Respire"] }} onChange={onChange} readOnly={false} />);
    await userEvent.type(screen.getByLabelText("Your idea"), "grandit{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({ ideas: ["Respire", "grandit"] });
    onChange.mockClear();
    await userEvent.type(screen.getByLabelText("Your idea"), "la respire !{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes an idea, and stops adding at the cap", async () => {
    const onChange = vi.fn();
    render(<BrainstormPlayer student={student} answer={{ ideas: ["a", "b"] }} onChange={onChange} readOnly={false} />);
    expect(screen.getByLabelText("Your idea")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Remove a" }));
    expect(onChange).toHaveBeenCalledWith({ ideas: ["b"] });
  });

  it("shows the ideas without controls when read-only", () => {
    render(<BrainstormPlayer student={student} answer={{ ideas: ["a"] }} onChange={() => {}} readOnly />);
    expect(screen.queryByLabelText("Your idea")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove a" })).toBeNull();
  });
});

describe("BrainstormEditor", () => {
  it("edits the prompt and clamps the cap", async () => {
    const { BrainstormEditor } = await import("./Editor.js");
    const onChange = vi.fn();
    const config = { configVersion: 1 as const, prompt: "", maxIdeas: 5 };
    render(<BrainstormEditor config={config} onChange={onChange} uploadAsset={async () => ""} />);
    await userEvent.type(screen.getByLabelText("Question"), "Q");
    expect(onChange).toHaveBeenLastCalledWith({ ...config, prompt: "Q" });
    const cap = screen.getByLabelText("Ideas per participant");
    await userEvent.clear(cap);
    await userEvent.type(cap, "40");
    expect(onChange).toHaveBeenLastCalledWith({ ...config, maxIdeas: 10 });
  });
});

describe("BrainstormReview and the grading column", () => {
  it("lists the ideas given, or says there are none", async () => {
    const { BrainstormReview } = await import("./Review.js");
    const props = { student, solution: null, details: null, points: null, maxPoints: 1, audience: "teacher" as const };
    const { rerender } = render(<BrainstormReview {...props} answer={{ ideas: ["respire"] }} />);
    expect(screen.getByText("respire")).toBeVisible();
    rerender(<BrainstormReview {...props} answer={null} />);
    expect(screen.getByText("No ideas")).toBeVisible();
  });

  it("draws one column of chips, sorted by the ideas", async () => {
    const { brainstormGrading } = await import("./grading.js");
    const [column] = brainstormGrading.columns(student, null);
    render(<div>{column!.cell({ answer: { ideas: ["respire", "grandit"] }, details: null })}</div>);
    expect(screen.getByText("grandit")).toBeVisible();
    render(<div>{column!.cell({ answer: null, details: null })}</div>);
    expect(screen.getByText("empty")).toBeVisible();
    expect(column!.expected()).toBeNull();
    expect(column!.sortKey({ ideas: ["B", "a"] })).toBe("b a");
  });
});
