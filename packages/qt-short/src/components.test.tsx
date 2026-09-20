/** Smoke tests: the components render, report every change and keep no state. */
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ShortEditor } from "./Editor.js";
import { ShortPlayer } from "./Player.js";
import { ShortReview } from "./Review.js";
import { config, SECRET_CONFIG } from "./fixtures.js";
import { emptyShortDraft } from "./schema.js";
import { shortServer } from "./server.js";

const student = shortServer.toStudent(SECRET_CONFIG, { seed: 1, itemId: "i", shuffle: false });

describe("ShortEditor", () => {
  it("renders the statement and the first matcher", () => {
    render(<ShortEditor config={config()} onChange={() => {}} />);
    expect(screen.getByLabelText("Statement")).toHaveValue(config().prompt);
    expect(screen.getByLabelText("Value 1")).toHaveValue("#include <stdio.h>");
  });

  it("reports a typed statement without keeping it", async () => {
    const onChange = vi.fn();
    render(<ShortEditor config={emptyShortDraft()} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Statement"), "?");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ prompt: "…?" }));
    expect(screen.getByLabelText("Statement")).toHaveValue("…");
  });

  it("adds a matcher through onChange", async () => {
    const onChange = vi.fn();
    render(<ShortEditor config={config()} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add an accepted answer" }));
    expect(onChange.mock.calls[0]?.[0].matchers).toHaveLength(2);
  });

  it("swaps the fields when the matcher kind changes", async () => {
    const onChange = vi.fn();
    render(<ShortEditor config={config()} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText("Matcher 1"), "number");
    const next = onChange.mock.calls[0]?.[0].matchers[0];
    expect(next).toEqual({
      kind: "number",
      value: 0,
      tolerance: 0,
      toleranceMode: "abs",
      unitRequired: false,
      points: 1,
    });
  });

  it("warns that an llm matcher cannot be published yet", () => {
    render(
      <ShortEditor
        config={config({ matchers: [{ kind: "llm", rubric: "x", points: 1 }] })}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("An LLM matcher cannot be published yet.")).toBeInTheDocument();
  });

  it("shows the issues the host reported, on the matcher that carries them", () => {
    render(
      <ShortEditor
        config={config()}
        onChange={() => {}}
        issues={[{ path: ["matchers", 0, "pattern"], message: "short.invalid_pattern" }]}
      />,
    );
    expect(screen.getByText("short.invalid_pattern")).toBeInTheDocument();
  });

  it("takes the host's French strings", () => {
    render(<ShortEditor config={config()} onChange={() => {}} strings={{ prompt: "Énoncé" }} />);
    expect(screen.getByLabelText("Énoncé")).toBeInTheDocument();
  });
});

describe("ShortPlayer", () => {
  it("renders one field and reports every keystroke", async () => {
    const onChange = vi.fn();
    render(<ShortPlayer student={student} answer={null} onChange={onChange} readOnly={false} />);
    await userEvent.type(screen.getByLabelText("Your answer"), "4");
    expect(onChange).toHaveBeenCalledWith({ text: "4" });
  });

  it("keeps a numeric question on a text input, so a comma survives", () => {
    render(
      <ShortPlayer student={student} answer={{ text: "3,14" }} onChange={() => {}} readOnly={false} />,
    );
    const input = screen.getByLabelText("Your answer");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "decimal");
    expect(input).toHaveValue("3,14");
  });

  it("shows the placeholder the teacher wrote, never an answer", () => {
    render(<ShortPlayer student={student} answer={null} onChange={() => {}} readOnly={false} />);
    expect(screen.getByLabelText("Your answer")).toHaveAttribute("placeholder", "bytes");
    expect(screen.queryByText("0x1004")).not.toBeInTheDocument();
  });

  it("is read-only once the attempt is closed", () => {
    render(<ShortPlayer student={student} answer={{ text: "4" }} onChange={() => {}} readOnly />);
    expect(screen.getByLabelText("Your answer")).toBeDisabled();
  });

  it("switches to a date field for a date question", () => {
    render(
      <ShortPlayer
        student={{ prompt: "When?", kind: "date" }}
        answer={null}
        onChange={() => {}}
        readOnly={false}
      />,
    );
    expect(screen.getByLabelText("Your answer")).toHaveAttribute("type", "date");
  });
});

describe("ShortReview", () => {
  it("names the matcher that accepted the answer", () => {
    render(
      <ShortReview
        student={student}
        answer={{ text: "4 bytes" }}
        solution={{ expected: ["4 ± 0.5 bytes"] }}
        details={{ matchedIndex: 2, matchedKind: "number", normalized: "4 bytes", fraction: 1 }}
        points={2}
        maxPoints={2}
        audience="student"
      />,
    );
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.getByText(/#3 · number/)).toBeInTheDocument();
    expect(screen.getByText("4 ± 0.5 bytes")).toBeInTheDocument();
  });

  it("says nothing about the key when the policy hides it", () => {
    render(
      <ShortReview
        student={student}
        answer={{ text: "5" }}
        solution={null}
        details={{ matchedIndex: null, matchedKind: null, normalized: "5", fraction: 0 }}
        points={0}
        maxPoints={2}
        audience="student"
      />,
    );
    expect(screen.getByText("Not accepted")).toBeInTheDocument();
    expect(screen.queryByText("Accepted answers")).not.toBeInTheDocument();
  });

  it("says so when nothing was typed", () => {
    render(
      <ShortReview
        student={student}
        answer={null}
        solution={null}
        details={null}
        points={null}
        maxPoints={2}
        audience="student"
      />,
    );
    expect(screen.getByText("No answer")).toBeInTheDocument();
  });
});
