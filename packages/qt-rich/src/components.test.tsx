/** Smoke tests: the components render, report every change and keep no state they should not. */
import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("tells the host while it holds text back, and when it no longer does (#267)", () => {
    const onUnsent = vi.fn();
    const small: RichStudent = { ...student, maxChars: 5 };
    const { unmount } = render(
      <RichPlayer
        student={small}
        answer={{ text: "" }}
        onChange={() => {}}
        readOnly={false}
        RichText={FakeRichText}
        onUnsent={onUnsent}
      />,
    );
    // Nothing held back yet: nothing to report.
    expect(onUnsent).not.toHaveBeenCalled();
    const field = screen.getByTestId("rich-text");
    fireEvent.change(field, { target: { value: "abcdefg" } });
    expect(onUnsent).toHaveBeenLastCalledWith(true);
    fireEvent.change(field, { target: { value: "abcdefgh" } });
    expect(onUnsent).toHaveBeenCalledTimes(1);
    fireEvent.change(field, { target: { value: "abc" } });
    expect(onUnsent).toHaveBeenLastCalledWith(false);
    // Over again, then gone: the host is never left with a stale flag.
    fireEvent.change(field, { target: { value: "abcdefg" } });
    expect(onUnsent).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onUnsent).toHaveBeenLastCalledWith(false);
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

  it("shows the answer beside the criteria, the instructions and the model answer", () => {
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
    expect(screen.getByText("Criteria")).toBeInTheDocument();
    expect(screen.getByText("CRITERION-TITLE-SECRET-guard page")).toBeInTheDocument();
    expect(screen.getByText("Weight 2")).toBeInTheDocument();
    expect(screen.getByText(/CRITERION-PROMPT-SECRET/)).toBeInTheDocument();
  });

  it("drops an empty instructions panel when the criteria say it all", () => {
    const cfg = config({ criteria: [{ id: "a", title: "Names it", weight: 1, prompt: "" }] });
    render(
      <RichReview
        student={student}
        answer={{ text: "x" }}
        solution={richServer.toSolution(cfg, view)}
        details={null}
        points={null}
        maxPoints={1}
        audience="teacher"
      />,
    );
    expect(screen.getByText("Names it")).toBeInTheDocument();
    expect(screen.queryByText("Grading instructions")).toBeNull();
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
    expect(screen.queryByText("Grading instructions")).toBeNull();
    unmount();
    render(<RichReview {...props} solution={solution} sections={{ solution: false }} />);
    expect(screen.queryByText("Grading instructions")).toBeNull();
    expect(screen.queryByText("Criteria")).toBeNull();
  });

  it("shows a student the model answer alone: the rubric and the criteria are not in their key (ADR-037)", () => {
    const studentKey = richServer.studentSolution!(solution, SECRET_CONFIG);
    render(
      <RichReview
        student={student}
        answer={{ text: "x" }}
        solution={studentKey}
        details={null}
        points={1}
        maxPoints={4}
        audience="student"
      />,
    );
    expect(screen.getByText(/REFERENCE-SECRET/)).toBeInTheDocument();
    expect(screen.getByText("Model answer")).toBeInTheDocument();
    expect(screen.queryByText("Grading instructions")).toBeNull();
    expect(screen.queryByText("No grading instructions.")).toBeNull();
    expect(screen.queryByText("Criteria")).toBeNull();
    expect(screen.queryByText(/CRITERION-/)).toBeNull();
  });

  describe("the validated points per criterion (ADR-118 §5)", () => {
    const breakdown = [
      { id: "thesis", title: "Thesis", points: 2, maxPoints: 2.5 },
      { id: "sources", title: "Sources", points: 0.75, maxPoints: 1.5 },
    ];
    const ai = {
      model: "model-x",
      criteria: [{ id: "thesis", criterion: "Thesis", points: 2, maxPoints: 2.5, comment: "MODEL-SENTENCE" }],
    };
    const lines = (name: string) =>
      within(screen.getByRole("list", { name })).getAllByRole("listitem").map((l) => l.textContent);

    it("lists each title and its points under the answer, the score line unchanged", () => {
      render(
        <RichReview
          student={student}
          answer={{ text: "x" }}
          solution={null}
          details={{ reason: "llm", chars: 1, breakdown }}
          points={2.74}
          maxPoints={4}
          audience="student"
        />,
      );
      expect(lines("Points per criterion")).toEqual(["Thesis2 / 2.5", "Sources0.75 / 1.5"]);
      expect(screen.getByText("2.74 / 4")).toBeInTheDocument();
    });

    it("adds the model's sentence for the teacher only", () => {
      const details = { reason: "llm" as const, chars: 1, breakdown, ai };
      const props = { student, answer: { text: "x" }, solution: null, points: 2.75, maxPoints: 4 };
      const { unmount } = render(<RichReview {...props} details={details} audience="teacher" />);
      expect(screen.getByText("MODEL-SENTENCE")).toBeInTheDocument();
      unmount();
      render(<RichReview {...props} details={details} audience="student" />);
      expect(screen.queryByText("MODEL-SENTENCE")).toBeNull();
      expect(lines("Points per criterion")).toHaveLength(2);
    });

    it("shows no list without a breakdown, nor for an empty answer", () => {
      const props = { student, solution: null, points: 0, maxPoints: 4, audience: "student" as const };
      const { unmount } = render(<RichReview {...props} answer={{ text: "x" }} details={{ reason: "llm", chars: 1 }} />);
      expect(screen.queryByRole("list", { name: "Points per criterion" })).toBeNull();
      unmount();
      render(<RichReview {...props} answer={{ text: "  " }} details={{ reason: "empty", chars: 0, breakdown }} />);
      expect(screen.queryByRole("list", { name: "Points per criterion" })).toBeNull();
    });
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
    await userEvent.click(screen.getByText("Global instructions (optional)"));
    await userEvent.type(screen.getByLabelText("Global instructions"), "?");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rubric: "?" }));
  });

  describe("the rubric's three states (ADR-118)", () => {
    const fold = () => screen.getByText(/^(Global instructions \(optional\)|Grading instructions)$/, { selector: "summary" }).closest("details")!;
    const criteria = [{ id: "a", title: "First", weight: 2, prompt: "" }];

    it("folds the global instructions beside criteria, unless they are written", () => {
      const { unmount } = render(<RichEditor config={config({ criteria })} onChange={vi.fn()} onGenerateTarget={vi.fn()} />);
      expect(screen.getByText("Global instructions (optional)")).toBeInTheDocument();
      expect(fold().open).toBe(false);
      expect(screen.queryByRole("button", { name: "Convert to criteria" })).toBeNull();
      unmount();
      render(<RichEditor config={config({ criteria, rubric: "Ignore spelling." })} onChange={vi.fn()} />);
      expect(fold().open).toBe(true);
    });

    it("offers to convert a legacy rubric, open, and waits for the host", async () => {
      let resolve = () => {};
      const onGenerateTarget = vi.fn(() => new Promise<void>((r) => (resolve = r)));
      render(<RichEditor config={config({ rubric: "- 4 pts: the stack" })} onChange={vi.fn()} onGenerateTarget={onGenerateTarget} />);
      expect(screen.getByText("Grading instructions", { selector: "summary" })).toBeInTheDocument();
      expect(fold().open).toBe(true);
      const convert = screen.getByRole("button", { name: "Convert to criteria" });
      await userEvent.click(convert);
      expect(onGenerateTarget).toHaveBeenCalledWith({ kind: "criteriaFromRubric" });
      expect(convert).toBeDisabled();
      expect(convert).toHaveAttribute("aria-busy", "true");
      resolve();
      await vi.waitFor(() => expect(convert).toBeEnabled());
    });

    it("leaves an empty essay to its criteria, the instructions folded and nothing to convert", () => {
      render(<RichEditor config={emptyRichDraft()} onChange={vi.fn()} onGenerateTarget={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Add a criterion" })).toBeEnabled();
      expect(fold().open).toBe(false);
      expect(screen.queryByRole("button", { name: "Convert to criteria" })).toBeNull();
    });
  });

  it("generates one criterion's prompt, once it has a title", async () => {
    const onGenerateTarget = vi.fn(() => Promise.resolve());
    // A draft with an untitled criterion, as the editor holds it (D16): not a valid config.
    const two = {
      ...config(),
      criteria: [
        { id: "a", title: "First", weight: 2, prompt: "" },
        { id: "b", title: " ", weight: 1, prompt: "" },
      ],
    };
    const { rerender } = render(<RichEditor config={two} onChange={vi.fn()} onGenerateTarget={onGenerateTarget} />);
    expect(screen.getByLabelText("Grading prompt of criterion 1")).toHaveAttribute(
      "placeholder",
      "What the answer must say to earn the weight, and what earns part of it",
    );
    expect(screen.getByRole("button", { name: "Generate the prompt of criterion 2" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Generate the prompt of criterion 1" }));
    expect(onGenerateTarget).toHaveBeenCalledWith({ kind: "criterionPrompt", id: "a" });

    rerender(<RichEditor config={two} onChange={vi.fn()} onGenerateTarget={onGenerateTarget} disabled />);
    expect(screen.queryByRole("button", { name: /^Generate the prompt/ })).toBeNull();
    rerender(<RichEditor config={two} onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Generate the prompt/ })).toBeNull();
  });

  it("adds, edits and removes criteria, and says the default points", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<RichEditor config={config()} onChange={onChange} />);
    expect(screen.getByText("Default points: 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add a criterion" }));
    const added = onChange.mock.lastCall![0].criteria;
    expect(added).toEqual([{ id: expect.stringMatching(/^[a-z0-9]{8}$/), title: "", weight: 1, prompt: "" }]);

    const two = config({
      criteria: [
        { id: "a", title: "First", weight: 2, prompt: "" },
        { id: "b", title: "Second", weight: 3, prompt: "Says why." },
      ],
    });
    rerender(<RichEditor config={two} onChange={onChange} />);
    expect(screen.getByText("Default points: 5")).toBeInTheDocument();
    expect(screen.getByText("2 criteria")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Criterion 1"), { target: { value: "Premier" } });
    expect(onChange.mock.lastCall![0].criteria[0]).toMatchObject({ id: "a", title: "Premier" });
    fireEvent.change(screen.getByLabelText("Weight of criterion 2"), { target: { value: "4" } });
    expect(onChange.mock.lastCall![0].criteria[1]).toMatchObject({ id: "b", weight: 4 });
    fireEvent.change(screen.getByLabelText("Grading prompt of criterion 2"), { target: { value: "More." } });
    expect(onChange.mock.lastCall![0].criteria[1]).toMatchObject({ id: "b", prompt: "More." });

    await userEvent.click(screen.getByRole("button", { name: "Remove criterion 1" }));
    expect(onChange.mock.lastCall![0].criteria.map((c: { id: string }) => c.id)).toEqual(["b"]);
  });

  it("locks every field of a criterion, the remove button included, when the editor is disabled", () => {
    const two = config({
      criteria: [
        { id: "a", title: "First", weight: 2, prompt: "" },
        { id: "b", title: "Second", weight: 3, prompt: "Says why." },
      ],
    });
    render(<RichEditor config={two} onChange={vi.fn()} disabled />);
    expect(screen.getByRole("button", { name: "Add a criterion" })).toBeDisabled();
    for (const n of [1, 2]) {
      expect(screen.getByLabelText(`Criterion ${n}`)).toBeDisabled();
      expect(screen.getByLabelText(`Weight of criterion ${n}`)).toBeDisabled();
      expect(screen.getByLabelText(`Grading prompt of criterion ${n}`)).toBeDisabled();
      expect(screen.getByRole("button", { name: `Remove criterion ${n}` })).toBeDisabled();
    }
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
