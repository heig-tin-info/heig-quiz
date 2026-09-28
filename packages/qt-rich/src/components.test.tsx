/** Smoke tests: the components render, report every change and keep no state they should not. */
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RichTextProps } from "@quiz/core/client";
import { RichEditor } from "./Editor.js";
import { RichPlayer } from "./Player.js";
import { RichReview } from "./Review.js";
import { emptyRichDraft, type RichStudent } from "./schema.js";
import { richServer } from "./server.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";

const view = { seed: 1, itemId: "i", shuffle: false };
const student = richServer.toStudent(SECRET_CONFIG, view);

/** The host's formatted editor, reduced to what the player relies on: markdown in, markdown out. */
function FakeRichText({ value, onChange, disabled, "aria-label": label }: RichTextProps) {
  return (
    <textarea
      data-testid="rich-text"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

describe("RichPlayer", () => {
  it("hands the formatted field the answer and reports what is typed", () => {
    const onChange = vi.fn();
    render(
      <RichPlayer student={student} answer={{ text: "ab" }} onChange={onChange} readOnly={false} RichText={FakeRichText} />,
    );
    const field = screen.getByTestId("rich-text");
    expect(field).toHaveValue("ab");
    fireEvent.change(field, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith({ text: "abc" });
    expect(screen.getByText("2 / 3000 characters · about 0 A4 page(s)")).toBeInTheDocument();
  });

  it("sends nothing past the limit, says so, and sends again once the answer fits", () => {
    const onChange = vi.fn();
    const small: RichStudent = { ...student, maxChars: 5 };
    render(
      <RichPlayer student={small} answer={{ text: "" }} onChange={onChange} readOnly={false} RichText={FakeRichText} />,
    );
    const field = screen.getByTestId("rich-text");
    fireEvent.change(field, { target: { value: "abcdefg" } });
    expect(onChange).not.toHaveBeenCalled();
    // What was typed stays in the field: cutting it would lose the student's text.
    expect(field).toHaveValue("abcdefg");
    expect(screen.getByRole("alert")).toHaveTextContent("2 characters over the limit");
    fireEvent.change(field, { target: { value: "abcde" } });
    expect(onChange).toHaveBeenCalledWith({ text: "abcde" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops the unsent excess when the answer changes from outside", () => {
    const small: RichStudent = { ...student, maxChars: 5 };
    const props = { student: small, onChange: () => {}, readOnly: false, RichText: FakeRichText };
    const { rerender } = render(<RichPlayer {...props} answer={{ text: "ab" }} />);
    fireEvent.change(screen.getByTestId("rich-text"), { target: { value: "abcdefg" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // The server's newer copy is adopted (or the host resets the item).
    rerender(<RichPlayer {...props} answer={{ text: "xyz" }} />);
    expect(screen.getByTestId("rich-text")).toHaveValue("xyz");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is a textarea with a native limit for a plain question", async () => {
    const onChange = vi.fn();
    render(
      <RichPlayer student={{ ...student, format: "plain" }} answer={null} onChange={onChange} readOnly={false} RichText={FakeRichText} />,
    );
    expect(screen.queryByTestId("rich-text")).toBeNull();
    const field = screen.getByLabelText("Your answer");
    expect(field).toHaveAttribute("maxLength", "3000");
    await userEvent.type(field, "x");
    expect(onChange).toHaveBeenCalledWith({ text: "x" });
  });

  it("falls back to a textarea when the host lends no editor", () => {
    render(<RichPlayer student={student} answer={{ text: "**b**" }} onChange={() => {}} readOnly={false} />);
    expect(screen.getByLabelText("Your answer")).toHaveValue("**b**");
  });

  it("locks the field of a closed attempt", () => {
    render(<RichPlayer student={student} answer={{ text: "a" }} onChange={() => {}} readOnly RichText={FakeRichText} />);
    expect(screen.getByTestId("rich-text")).toBeDisabled();
  });
});

describe("RichReview", () => {
  const solution = richServer.toSolution(SECRET_CONFIG, view);

  it("shows the answer beside the rubric and the model answer", () => {
    render(
      <RichReview
        student={student}
        answer={{ text: "The stack meets the guard page." }}
        solution={solution}
        details={{ reason: "manual", chars: 31 }}
        points={null}
        maxPoints={4}
        audience="teacher"
      />,
    );
    expect(screen.getByText("The stack meets the guard page.")).toBeInTheDocument();
    expect(screen.getByText("31 characters")).toBeInTheDocument();
    expect(screen.getByText(/RUBRIC-SECRET/)).toBeInTheDocument();
    expect(screen.getByText(/REFERENCE-SECRET/)).toBeInTheDocument();
  });

  it("hides the guide when the policy withholds the key or the teacher folds it", () => {
    const props = {
      student,
      answer: { text: "x" },
      details: null,
      points: 1,
      maxPoints: 4,
      audience: "student" as const,
    };
    const { unmount } = render(<RichReview {...props} solution={null} />);
    expect(screen.queryByText("Rubric")).toBeNull();
    unmount();
    render(<RichReview {...props} solution={solution} sections={{ solution: false }} />);
    expect(screen.queryByText("Rubric")).toBeNull();
  });

  it("says when nothing was written", () => {
    render(
      <RichReview student={student} answer={null} solution={null} details={null} points={0} maxPoints={4} audience="teacher" />,
    );
    expect(screen.getByText("No answer")).toBeInTheDocument();
  });
});

describe("RichEditor", () => {
  it("reports a typed rubric without keeping it", async () => {
    const onChange = vi.fn();
    render(<RichEditor config={emptyRichDraft()} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Rubric"), "?");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rubric: "?" }));
  });

  it("stores no empty model answer and no empty limit", () => {
    const onChange = vi.fn();
    render(<RichEditor config={SECRET_CONFIG} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Model answer"), { target: { value: "" } });
    expect("reference" in onChange.mock.calls[0]![0]).toBe(false);
    fireEvent.change(screen.getByLabelText("Character limit"), { target: { value: "" } });
    expect("maxChars" in onChange.mock.calls[1]![0]).toBe(false);
  });

  it("switches the student's field to plain text", async () => {
    const onChange = vi.fn();
    render(<RichEditor config={config()} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Plain text"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ format: "plain" }));
  });

  it("gives the limit in A4 pages", () => {
    render(<RichEditor config={config({ maxChars: 4500 })} onChange={() => {}} />);
    expect(screen.getByText("About 1.5 A4 page(s).")).toBeInTheDocument();
  });
});
