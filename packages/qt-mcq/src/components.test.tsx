/**
 * Smoke tests of the three components: they render, they report every change
 * through their callback, and they hold no state of their own.
 */
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { McqEditor } from "./Editor.js";
import { McqPlayer } from "./Player.js";
import { McqReview } from "./Review.js";
import { McqStats } from "./Stats.js";
import { multipleConfig, SECRET_CONFIG } from "./fixtures.js";
import { emptyMcqDraft } from "./schema.js";
import { mcqServer } from "./server.js";

const student = mcqServer.toStudent(SECRET_CONFIG, { seed: 3, itemId: "i", shuffle: false });

describe("McqEditor", () => {
  it("renders the statement and every choice", () => {
    render(<McqEditor config={SECRET_CONFIG} onChange={() => {}} />);
    expect(screen.getByLabelText("Statement")).toHaveValue(SECRET_CONFIG.prompt);
    expect(screen.getByLabelText("Text of choice B")).toHaveValue("0x1004");
  });

  it("reports a typed statement without keeping it", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={emptyMcqDraft()} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Statement"), "?");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ prompt: "…?" }));
    // Controlled: the value only changes when the host sends a new config back.
    expect(screen.getByLabelText("Statement")).toHaveValue("…");
  });

  it("adds a choice through onChange", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={SECRET_CONFIG} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a choice" }));
    expect(onChange.mock.calls[0]?.[0].choices).toHaveLength(4);
  });

  it("normalises the key set when the mode goes back to single", async () => {
    const onChange = vi.fn();
    render(
      <McqEditor
        config={multipleConfig({ policy: "penalized", maxSelections: 2 })}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "One answer" }));
    const next = onChange.mock.calls[0]?.[0];
    expect(next.policy).toBe("all_or_nothing");
    expect(next.choices.filter((c: { correct: boolean }) => c.correct)).toHaveLength(1);
    expect(next.maxSelections).toBeUndefined();
  });

  it("shows the issues the host reported, verbatim", () => {
    render(
      <McqEditor
        config={SECRET_CONFIG}
        onChange={() => {}}
        issues={[{ path: ["choices"], message: "mcq.no_correct_choice" }]}
      />,
    );
    expect(screen.getByText("mcq.no_correct_choice")).toBeInTheDocument();
  });

  it("takes the host's French strings", () => {
    render(
      <McqEditor config={SECRET_CONFIG} onChange={() => {}} strings={{ prompt: "Énoncé" }} />,
    );
    expect(screen.getByLabelText("Énoncé")).toBeInTheDocument();
  });

  it("disables every control when the host says so", () => {
    render(<McqEditor config={SECRET_CONFIG} onChange={() => {}} disabled />);
    expect(screen.getByLabelText("Statement")).toBeDisabled();
  });
});

describe("McqPlayer", () => {
  it("renders radios for a single-answer question and sends the canonical id", async () => {
    const onChange = vi.fn();
    render(<McqPlayer student={student} answer={null} onChange={onChange} readOnly={false} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    await userEvent.click(screen.getByRole("radio", { name: "0x1004" }));
    expect(onChange).toHaveBeenCalledWith({ selected: [1] });
  });

  it("renders checkboxes and keeps the selection ascending", async () => {
    const config = multipleConfig();
    const view = mcqServer.toStudent(config, { seed: 1, itemId: "i", shuffle: false });
    const onChange = vi.fn();
    render(
      <McqPlayer student={view} answer={{ selected: [2] }} onChange={onChange} readOnly={false} />,
    );
    await userEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(onChange).toHaveBeenCalledWith({ selected: [0, 2] });
  });

  it("stops at maxSelections without losing what is already ticked", () => {
    const config = multipleConfig({ maxSelections: 1 });
    const view = mcqServer.toStudent(config, { seed: 1, itemId: "i", shuffle: false });
    render(
      <McqPlayer student={view} answer={{ selected: [0] }} onChange={() => {}} readOnly={false} />,
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[0]).toBeEnabled();
    expect(boxes[1]).toBeDisabled();
  });

  it("is read-only once the attempt is closed", () => {
    render(<McqPlayer student={student} answer={{ selected: [0] }} onChange={() => {}} readOnly />);
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });

  it("lets the host render the markdown", () => {
    render(
      <McqPlayer
        student={student}
        answer={null}
        onChange={() => {}}
        readOnly={false}
        renderMarkdown={(source) => <em data-testid="md">{source}</em>}
      />,
    );
    expect(screen.getAllByTestId("md").length).toBeGreaterThan(0);
  });
});

describe("McqReview", () => {
  it("shows a verdict per choice, not a bare score", () => {
    render(
      <McqReview
        student={student}
        answer={{ selected: [0] }}
        solution={{ correct: [1] }}
        details={{
          policy: "all_or_nothing",
          correct: [1],
          selected: [0],
          c: 0,
          w: 1,
          C: 1,
          W: 2,
          fraction: 0,
          truncated: false,
        }}
        points={0}
        maxPoints={2}
        audience="student"
      />,
    );
    expect(screen.getByText("Incorrect")).toBeInTheDocument();
    expect(screen.getByText("Missed")).toBeInTheDocument();
  });

  it("says nothing about the key when the policy hides it", () => {
    render(
      <McqReview
        student={student}
        answer={{ selected: [0] }}
        solution={null}
        details={null}
        points={null}
        maxPoints={2}
        audience="student"
      />,
    );
    expect(screen.queryByText("Correct")).not.toBeInTheDocument();
    expect(screen.getByText("Chosen")).toBeInTheDocument();
  });
});

describe("McqStats", () => {
  it("draws one row per choice and counts the answers", () => {
    render(
      <McqStats student={student} answers={[{ selected: [1] }, { selected: [1] }, { selected: [0] }]} />,
    );
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3 answers")).toBeInTheDocument();
  });

  it("says so when nobody answered", () => {
    render(<McqStats student={student} answers={[]} />);
    expect(screen.getByText("No answer yet.")).toBeInTheDocument();
  });
});
