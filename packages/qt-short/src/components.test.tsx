/** Smoke tests: the components render, report every change and keep no state. */
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ShortEditor } from "./Editor.js";
import { ShortPlayer } from "./Player.js";
import { ShortReview } from "./Review.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";
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
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ prompt: "?" }));
    expect(screen.getByLabelText("Statement")).toHaveValue("");
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

  it("offers the four kinds as one segmented control", async () => {
    const onChange = vi.fn();
    render(<ShortEditor config={config()} onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Expected answer" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Text" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Number" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "number" }));
  });

  it("shows the constraints of the current kind, and only those", () => {
    const { rerender } = render(<ShortEditor config={config()} onChange={() => {}} />);
    expect(screen.getByLabelText("Min length")).toHaveValue(0);
    expect(screen.getByLabelText("Max length")).toHaveValue(255);
    expect(screen.queryByLabelText("Integer")).not.toBeInTheDocument();

    rerender(<ShortEditor config={config({ kind: "number" })} onChange={() => {}} />);
    expect(screen.getByLabelText("Min")).toBeInTheDocument();
    expect(screen.getByLabelText("Integer")).toBeInTheDocument();
    expect(screen.queryByLabelText("Min length")).not.toBeInTheDocument();

    rerender(<ShortEditor config={config({ kind: "date" })} onChange={() => {}} />);
    expect(screen.getByLabelText("From")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("To")).toHaveAttribute("type", "date");

    rerender(<ShortEditor config={config({ kind: "time" })} onChange={() => {}} />);
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Min")).not.toBeInTheDocument();
  });

  it("empties a number bound rather than storing a zero", async () => {
    const onChange = vi.fn();
    render(
      <ShortEditor
        config={config({ kind: "number", constraints: { minLength: 0, maxLength: 255, integer: false, min: 3 } })}
        onChange={onChange}
      />,
    );
    await userEvent.clear(screen.getByLabelText("Min"));
    expect(onChange.mock.calls.at(-1)?.[0].constraints).not.toHaveProperty("min");
  });

  it("carries the two prefilters, and no per-matcher case box", async () => {
    const onChange = vi.fn();
    render(<ShortEditor config={config()} onChange={onChange} />);
    expect(screen.queryByLabelText("Case sensitive")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Trim")).toBeChecked();
    await userEvent.click(screen.getByLabelText("Lowercase"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ prefilters: { trim: true, lowercase: false } }),
    );
  });

  it("drops the prefilters and the points when the host gives no marks (a poll)", () => {
    render(<ShortEditor config={config()} onChange={() => {}} ungraded />);
    expect(screen.getByLabelText("Value 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Trim")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Points 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Share of the item awarded by this matcher.")).not.toBeInTheDocument();
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

  it("enforces the numeric window and the whole-number step", () => {
    render(<ShortPlayer student={student} answer={null} onChange={() => {}} readOnly={false} />);
    const input = screen.getByLabelText("Your answer");
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "100");
    expect(input).toHaveAttribute("step", "1");
    expect(input).toHaveAttribute("inputmode", "numeric");
  });

  it("enforces the length window of a text question", () => {
    render(
      <ShortPlayer
        student={{
          prompt: "Which directive?",
          kind: "text",
          constraints: { minLength: 3, maxLength: 40, integer: false },
        }}
        answer={null}
        onChange={() => {}}
        readOnly={false}
      />,
    );
    const input = screen.getByLabelText("Your answer");
    expect(input).toHaveAttribute("maxlength", "40");
    expect(input).toHaveAttribute("minlength", "3");
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
        student={{
          prompt: "When?",
          kind: "date",
          constraints: { minLength: 0, maxLength: 255, integer: false, from: "2026-01-01", to: "2026-12-31" },
        }}
        answer={null}
        onChange={() => {}}
        readOnly={false}
      />,
    );
    const input = screen.getByLabelText("Your answer");
    expect(input).toHaveAttribute("type", "date");
    expect(input).toHaveAttribute("min", "2026-01-01");
    expect(input).toHaveAttribute("max", "2026-12-31");
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
