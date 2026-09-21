/** Smoke tests: the components render, report every change and keep no state. */
import { useEffect } from "react";
import type { RichTextProps } from "@quiz/core/client";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClozeEditor } from "./Editor.js";
import { ClozePlayer } from "./Player.js";
import { ClozeReview } from "./Review.js";
import { config, SECRET_CONFIG } from "./fixtures.js";
import { emptyClozeDraft } from "./schema.js";
import { clozeServer } from "./server.js";
import { splitBlocks } from "./text.js";

const student = clozeServer.toStudent(SECRET_CONFIG, { seed: 3, itemId: "i", shuffle: false });

describe("ClozeEditor", () => {
  it("renders the text and what the parser understood", () => {
    render(<ClozeEditor config={SECRET_CONFIG} onChange={() => {}} />);
    expect(screen.getByLabelText("Text with blanks")).toHaveValue(SECRET_CONFIG.text);
    expect(screen.getByText("Newton | newton")).toBeInTheDocument();
    expect(screen.getByText("/^N$/")).toBeInTheDocument();
  });

  it("reports a typed text without keeping it", async () => {
    const onChange = vi.fn();
    render(<ClozeEditor config={emptyClozeDraft()} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Text with blanks"), "?");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ text: "?" }));
    expect(screen.getByLabelText("Text with blanks")).toHaveValue("");
  });

  it("toggles case sensitivity through onChange", async () => {
    const onChange = vi.fn();
    render(<ClozeEditor config={SECRET_CONFIG} onChange={onChange} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Case sensitive" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ caseSensitive: true }));
  });

  it("shows a parse error as it is typed, before any save", () => {
    render(<ClozeEditor config={{ ...SECRET_CONFIG, text: "La loi de {{Newton" }} onChange={() => {}} />);
    expect(screen.getByText("cloze.unterminated")).toBeInTheDocument();
  });

  /*
   * PREDEFINED CHOICE SETS. The section is the teacher-facing half of the
   * grammar change: a dropdown written once in a card, named by a key, and
   * dropped in the text as `{{1}}` — which is the only spelling that fits in a
   * markdown table cell.
   */
  it("adds a set with the next free key and two options ready to fill", async () => {
    const onChange = vi.fn();
    render(<ClozeEditor config={config("{{Newton}}")} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a set" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        choiceSets: [
          {
            key: "1",
            options: [
              { label: "", correct: true },
              { label: "", correct: false },
            ],
          },
        ],
      }),
    );
  });

  it("reports an option label and its correct flag without keeping them", async () => {
    const onChange = vi.fn();
    const withSet = config("{{1}}", {
      choiceSets: [
        { key: "1", options: [{ label: "free", correct: true }, { label: "delete", correct: false }] },
      ],
    });
    render(<ClozeEditor config={withSet} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Option 2"), "!");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        choiceSets: [expect.objectContaining({ options: expect.arrayContaining([{ label: "delete!", correct: false }]) })],
      }),
    );
    onChange.mockClear();
    await userEvent.click(screen.getAllByRole("checkbox", { name: "Correct" })[1]!);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        choiceSets: [expect.objectContaining({ options: [{ label: "free", correct: true }, { label: "delete", correct: true }] })],
      }),
    );
  });

  it("reads a used key as a DROPDOWN in the blanks table, not as a text answer", () => {
    const withSet = config("Libérer avec {{1}}.", {
      choiceSets: [
        { key: "1", options: [{ label: "free", correct: true }, { label: "delete", correct: false }] },
      ],
    });
    render(<ClozeEditor config={withSet} onChange={() => {}} />);
    expect(screen.getByText("select")).toBeInTheDocument();
    expect(screen.getByText("set 1 (free ✓, delete)")).toBeInTheDocument();
  });

  /*
   * "Insert in the text" goes through the rich editor's imperative handle
   * (`RichTextApi`), because the hole belongs WHERE THE CARET IS and a
   * markdown string handed back through `value` would land at the end.
   * Without a rich editor there is no caret, so the button is not drawn.
   */
  it("inserts {{key}} through the rich editor's handle, and hides the button without one", async () => {
    const insertHole = vi.fn();
    const Rich = ({ onReady, value, "aria-label": label }: RichTextProps) => {
      useEffect(() => {
        onReady?.({ insertHole, focus: () => {} });
      }, [onReady]);
      return <textarea aria-label={label} value={value} readOnly />;
    };
    const withSet = config("{{Newton}}", {
      choiceSets: [
        { key: "u", options: [{ label: "a", correct: true }, { label: "b", correct: false }] },
      ],
    });
    render(<ClozeEditor config={withSet} onChange={() => {}} RichText={Rich} />);
    await userEvent.click(screen.getByRole("button", { name: "Insert in the text" }));
    expect(insertHole).toHaveBeenCalledWith("u");
  });

  it("draws no insert button without a rich editor: there is no caret to insert at", () => {
    const withSet = config("{{Newton}}", {
      choiceSets: [
        { key: "u", options: [{ label: "a", correct: true }, { label: "b", correct: false }] },
      ],
    });
    render(<ClozeEditor config={withSet} onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "Insert in the text" })).not.toBeInTheDocument();
  });

  it("takes the host's French strings", () => {
    render(
      <ClozeEditor config={SECRET_CONFIG} onChange={() => {}} strings={{ text: "Texte à trous" }} />,
    );
    expect(screen.getByLabelText("Texte à trous")).toBeInTheDocument();
  });
});

describe("ClozePlayer", () => {
  it("renders one control per blank, in place, with the code fence intact", () => {
    render(<ClozePlayer student={student} answer={null} onChange={() => {}} readOnly={false} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(4);
    expect(screen.getByRole("combobox", { name: "Blank 4" })).toBeInTheDocument();
    expect(document.querySelector("pre")).not.toBeNull();
  });

  it("reports a typed blank as a full array, one slot per blank", async () => {
    const onChange = vi.fn();
    render(<ClozePlayer student={student} answer={null} onChange={onChange} readOnly={false} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Blank 1" }), "N");
    expect(onChange).toHaveBeenCalledWith({ blanks: ["N", null, null, null, null, null] });
  });

  it("stores the canonical option index of a dropdown (decision D4)", async () => {
    const onChange = vi.fn();
    render(<ClozePlayer student={student} answer={null} onChange={onChange} readOnly={false} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Blank 4" }), "2");
    expect(onChange).toHaveBeenCalledWith({ blanks: [null, null, null, "2", null, null] });
  });

  it("shows the stored answer and stays controlled", () => {
    render(
      <ClozePlayer
        student={student}
        answer={{ blanks: ["Newton", null, null, "0", null] }}
        onChange={() => {}}
        readOnly={false}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Blank 1" })).toHaveValue("Newton");
    expect(screen.getByRole("combobox", { name: "Blank 4" })).toHaveValue("0");
  });

  it("is read-only once the attempt is closed", () => {
    render(<ClozePlayer student={student} answer={null} onChange={() => {}} readOnly />);
    for (const field of screen.getAllByRole("textbox")) expect(field).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Blank 4" })).toBeDisabled();
  });

  it("lets the host render the text with its own markdown pipeline", () => {
    render(
      <ClozePlayer
        student={student}
        answer={null}
        onChange={() => {}}
        readOnly={false}
        renderText={({ renderBlank }) => <div data-testid="host">{renderBlank(0)}</div>}
      />,
    );
    expect(screen.getByTestId("host")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});

describe("the fallback text renderer", () => {
  it("separates fenced code from paragraphs", () => {
    const blocks = splitBlocks("a\n\nb\n\n```c\nint x;\n```\n\nc");
    expect(blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "paragraph",
      "code",
      "paragraph",
    ]);
  });

  /*
   * A TABLE, which is why the choice sets exist: a hole in a cell must reach
   * the student as a cell, not as a line of `| Directe | ⸢1⸣ |` prose.
   */
  it("renders a GFM table, with the blank inside its cell", () => {
    const one = clozeServer.toStudent(
      config("| Polarisation | État |\n| --- | :-: |\n| Directe | {{1}} |", {
        choiceSets: [
          { key: "1", options: [{ label: "passante", correct: true }, { label: "bloquée", correct: false }] },
        ],
      }),
      { seed: 1, itemId: "i", shuffle: false },
    );
    render(<ClozePlayer student={one} answer={null} onChange={() => {}} readOnly={false} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Polarisation" })).toBeInTheDocument();
    // The dropdown of the set is IN the cell, and the alignment of the
    // delimiter row is carried over.
    const cell = screen.getAllByRole("cell")[1]!;
    expect(cell.querySelector("select")).not.toBeNull();
    expect(cell.className).toContain("text-center");
  });

  it("renders bold, italic and inline code", () => {
    const one = clozeServer.toStudent(config("**a** *b* `c` {{d}}"), {
      seed: 1,
      itemId: "i",
      shuffle: false,
    });
    render(<ClozePlayer student={one} answer={null} onChange={() => {}} readOnly={false} />);
    expect(screen.getByText("a").tagName).toBe("STRONG");
    expect(screen.getByText("b").tagName).toBe("EM");
    expect(screen.getByText("c").tagName).toBe("CODE");
  });
});

describe("ClozeReview", () => {
  const details = {
    perBlank: [
      { index: 0, weight: 1, kind: "text" as const, ok: true, given: "Newton", expected: "Newton | newton" },
      { index: 1, weight: 1, kind: "number" as const, ok: false, given: "9", expected: "10" },
      { index: 2, weight: 1, kind: "text" as const, ok: false, given: null, expected: "+= | + =" },
      { index: 3, weight: 1, kind: "select" as const, ok: true, given: "0", expected: "newton" },
      { index: 4, weight: 2, kind: "regex" as const, ok: false, given: "n", expected: "/^N$/" },
      {
        index: 5,
        weight: 1,
        kind: "select" as const,
        ok: true,
        given: "0",
        expected: "set SET-KEY-MARKER (newton ✓, pascal, joule)",
      },
    ],
    earned: 3,
    total: 7,
    fraction: 3 / 7,
  };

  it("shows a verdict per blank, not a bare score", () => {
    render(
      <ClozeReview
        student={student}
        answer={{ blanks: ["Newton", "9", null, "0", "n", "0"] }}
        solution={{ blanks: details.perBlank.map((b) => ({ index: b.index, expected: b.expected })) }}
        details={details}
        points={2}
        maxPoints={6}
        audience="teacher"
      />,
    );
    expect(screen.getAllByText("Correct")).toHaveLength(3);
    expect(screen.getAllByText("Incorrect")).toHaveLength(3);
    expect(screen.getByText("Not answered")).toBeInTheDocument();
    // A dropdown is shown by its label, never by the stored index.
    expect(screen.getAllByText("newton").length).toBeGreaterThan(0);
  });

  /*
   * `gradings.details` is a union: this type's breakdown, or a grading-level
   * marker written when no type ever ran on the cell. A marker has no
   * `perBlank`, and reading it as one used to take the page down.
   */
  it("survives a grading-level marker where a breakdown was expected", () => {
    render(
      <ClozeReview
        student={student}
        answer={null}
        solution={null}
        details={{ reason: "config_unreadable" } as unknown as typeof details}
        points={0}
        maxPoints={6}
        audience="student"
      />,
    );
    expect(screen.queryAllByText("Correct")).toHaveLength(0);
    expect(screen.getByText("Score")).toBeInTheDocument();
  });

  it("hides the expected column when the policy hides the key", () => {
    render(
      <ClozeReview
        student={student}
        answer={{ blanks: ["Newton", null, null, null, null, null] }}
        solution={null}
        details={details}
        points={2}
        maxPoints={6}
        audience="student"
      />,
    );
    expect(screen.queryByText("Expected")).not.toBeInTheDocument();
  });
});
