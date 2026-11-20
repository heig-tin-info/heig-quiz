/** Smoke tests: the components render, report every change and keep no state. */
import { useEffect } from "react";
import type { RichTextProps } from "@quiz/core/client";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClozeEditor } from "./Editor.js";
import { ClozePlayer } from "./Player.js";
import { ClozeReview } from "./Review.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";
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

  it("reads a dropdown as a DROPDOWN in the blanks table, correct answers only", () => {
    render(<ClozeEditor config={config("Libérer avec {{=free|delete}}.")} onChange={() => {}} />);
    expect(screen.getByText("select")).toBeInTheDocument();
    expect(screen.getByText("free")).toBeInTheDocument();
  });

  it("hands the host's image upload to the rich field (#984)", () => {
    const seen: RichTextProps[] = [];
    const RichText = (props: RichTextProps) => {
      seen.push(props);
      return null;
    };
    const upload = async () => "asset:x";
    render(
      <ClozeEditor config={SECRET_CONFIG} onChange={() => {}} RichText={RichText} uploadAsset={upload} />,
    );
    expect(seen.at(-1)).toMatchObject({ holes: true, uploadImage: upload });
  });

  it("takes the host's French strings", () => {
    render(
      <ClozeEditor config={SECRET_CONFIG} onChange={() => {}} strings={{ text: "Texte à trous" }} />,
    );
    expect(screen.getByLabelText("Texte à trous")).toBeInTheDocument();
  });

  /*
   * ADR-138: Labels writes the key, Dropdowns REMOVES it, so a question
   * nobody switched keeps the stored JSON it had.
   */
  it("writes the labels presentation, and removes the key going back to dropdowns", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ClozeEditor config={SECRET_CONFIG} onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Choices shown as" });
    expect(group).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Labels" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...SECRET_CONFIG, presentation: "labels" });
    rerender(<ClozeEditor config={{ ...SECRET_CONFIG, presentation: "labels" }} onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Dropdowns" }));
    expect(onChange.mock.lastCall?.[0]).toEqual(SECRET_CONFIG);
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty("presentation");
  });

  it("numbers the label groups in the blank table, in labels mode only", () => {
    const text = "{{=ohm|farad}} {{=Ω|F}} {{farad|=ohm}} {{word}}";
    const { rerender } = render(<ClozeEditor config={config(text)} onChange={() => {}} />);
    expect(screen.queryByRole("columnheader", { name: "Group" })).toBeNull();
    rerender(<ClozeEditor config={config(text, { presentation: "labels" })} onChange={() => {}} />);
    expect(screen.getByRole("columnheader", { name: "Group" })).toBeInTheDocument();
    const groups = screen.getAllByRole("row").slice(1).map((row) => row.querySelectorAll("td")[3]?.textContent);
    expect(groups).toEqual(["1", "2", "1", "—"]);
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

  it("sends the id the view gave a dropdown option (ADR-097)", async () => {
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

  it("writes the expected answer inside each field, given a key (#554)", () => {
    const { container } = render(
      <ClozePlayer
        student={student}
        answer={{ blanks: ["Newt", null, null, null, null] }}
        onChange={() => {}}
        readOnly={false}
        answerKey={{
          blanks: [
            { index: 0, expected: "Newton" },
            { index: 3, expected: "newton" },
          ],
        }}
      />,
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(4);
    const first = screen.getByRole("textbox", { name: "Blank 1" });
    expect(first).toHaveValue("Newt");
    expect(first).toHaveAttribute("placeholder", "Newton");
    expect(first).toHaveAttribute("title", "Expected: Newton");
    expect(screen.getByRole("combobox", { name: "Blank 4" })).toHaveDisplayValue("newton");
    // Nothing is added beside a field: the layout is the one without the key.
    expect(container.textContent).not.toContain("Newton");
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

/*
 * ADR-138: the dropdowns shown as labels. Two groups (the units, the
 * symbols) and a text blank, unshuffled, so an option's id is its position.
 */
const LABELS_TEXT = "R in {{=ohm|farad|henry}}, C in {{ohm|=farad|henry}}, R as {{=Ω|F}}, named after {{Ohm}}.";
const labelsStudent = clozeServer.toStudent(config(LABELS_TEXT, { presentation: "labels" }), {
  seed: 3,
  itemId: "i",
  shuffle: false,
});

/**
 * jsdom lays nothing out, and dnd-kit finds its drop targets by their boxes:
 * this stub puts the gaps on a row, 80 px apart in the order of the text, and
 * every other box at the origin. Geometry only — the sensor, the collision
 * detection and the player's drop are the real ones.
 */
function stubLabelsLayout() {
  const real = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const gap = /^Blank (\d+)/.exec(this.getAttribute("aria-label") ?? "");
      const [left, top, width, height] = gap ? [Number(gap[1]) * 80, 200, 60, 20] : [0, 0, 60, 20];
      return { x: left, y: top, top, left, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = real;
  });
}

describe("ClozePlayer, labels (ADR-138)", () => {
  const play = (answer: { blanks: (string | null)[] } | null = null, extra: Partial<Parameters<typeof ClozePlayer>[0]> = {}) => {
    const onChange = vi.fn();
    const view = render(
      <ClozePlayer student={labelsStudent} answer={answer} onChange={onChange} readOnly={false} {...extra} />,
    );
    return { onChange, ...view };
  };
  const label = (name: string) => screen.getByRole("button", { name });

  it("shows a tray row per group, a gap per dropdown, and the other blanks as fields", () => {
    play();
    expect(screen.getByRole("group", { name: "Group 1" })).toHaveTextContent("ohmfaradhenry");
    expect(screen.getByRole("group", { name: "Group 2" })).toHaveTextContent("ΩF");
    expect(screen.getByRole("button", { name: "Blank 1, empty" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Blank 3, empty" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Blank 4" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Drag a label into a blank, or click the label, then the blank.")).toBeInTheDocument();
  });

  it("places a label by a click on it, then on a gap of its group", async () => {
    const { onChange } = play();
    await userEvent.click(label("farad"));
    expect(label("farad")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Blank 2, empty" }));
    expect(onChange).toHaveBeenCalledWith({ blanks: [null, "1", null, null] });
    // A label is reusable and the selection is spent.
    expect(label("farad")).toHaveAttribute("aria-pressed", "false");
  });

  it("stores exactly what the dropdown stores for the same choice", async () => {
    const { onChange, unmount } = play();
    await userEvent.click(label("henry"));
    await userEvent.click(screen.getByRole("button", { name: "Blank 1, empty" }));
    unmount();
    const dropdown = vi.fn();
    const { presentation: _labels, ...served } = labelsStudent;
    render(<ClozePlayer student={served} answer={null} onChange={dropdown} readOnly={false} />);
    const select = screen.getByRole("combobox", { name: "Blank 1" });
    const henry = Array.from(select.querySelectorAll("option")).find((option) => option.textContent === "henry")!;
    await userEvent.selectOptions(select, henry);
    expect(onChange.mock.calls[0]?.[0]).toEqual(dropdown.mock.calls[0]?.[0]);
  });

  it("works from the keyboard: Enter selects, Enter places, Escape lets go", async () => {
    const { onChange } = play();
    label("ohm").focus();
    await userEvent.keyboard("{Enter}");
    expect(label("ohm")).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Escape}");
    expect(label("ohm")).toHaveAttribute("aria-pressed", "false");
    await userEvent.keyboard("{Enter}");
    screen.getByRole("button", { name: "Blank 1, empty" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith({ blanks: ["0", null, null, null] });
  });

  it("refuses a label in a gap of another group, and shows it", async () => {
    const { onChange } = play();
    await userEvent.click(label("Ω"));
    const other = screen.getByRole("button", { name: "Blank 1, empty" });
    expect(other.className).toContain("opacity-40");
    expect(screen.getByRole("button", { name: "Blank 3, empty" }).className).not.toContain("opacity-40");
    await userEvent.click(other);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("empties a filled gap activated with nothing selected", async () => {
    const { onChange } = play({ blanks: ["0", null, "1", null] });
    expect(screen.getByRole("button", { name: "Blank 3: F" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Blank 1: ohm" }));
    expect(onChange).toHaveBeenCalledWith({ blanks: ["", null, "1", null] });
  });

  it("is locked once the attempt is closed", () => {
    play({ blanks: ["0", null, null, null] }, { readOnly: true });
    for (const name of ["ohm", "farad", "henry", "Ω", "F", "Blank 1: ohm", "Blank 2, empty"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("textbox", { name: "Blank 4" })).toBeDisabled();
  });

  it("shows the expected label inside an empty gap, given a key (#554)", () => {
    play(null, { answerKey: { blanks: [{ index: 0, expected: "ohm" }] } });
    const gap = screen.getByRole("button", { name: "Blank 1, empty" });
    expect(gap).toHaveAttribute("title", "Expected: ohm");
    const shown = Array.from(gap.children).find((child) => !child.classList.contains("invisible"));
    expect(shown).toHaveTextContent("ohm");
    expect(shown?.className).toContain("text-success");
  });

  it("sizes every gap of a group for its widest label, whatever it holds", () => {
    play({ blanks: ["0", null, null, null] });
    const sizers = (name: string) =>
      Array.from(screen.getByRole("button", { name }).querySelectorAll(".invisible")).map((el) => el.textContent);
    expect(sizers("Blank 1: ohm")).toEqual(["ohm", "farad", "henry"]);
    expect(sizers("Blank 2, empty")).toEqual(["ohm", "farad", "henry"]);
    expect(sizers("Blank 3, empty")).toEqual(["Ω", "F"]);
  });

  it("never starts a native drag: nothing is draggable, nothing the integrity journal hears", async () => {
    const heard = vi.fn();
    document.addEventListener("dragstart", heard, true);
    document.addEventListener("drop", heard, true);
    const { container } = play();
    await userEvent.click(label("farad"));
    await userEvent.click(screen.getByRole("button", { name: "Blank 1, empty" }));
    document.removeEventListener("dragstart", heard, true);
    document.removeEventListener("drop", heard, true);
    expect(heard).not.toHaveBeenCalled();
    expect(container.querySelector("[draggable]")).toBeNull();
    expect(label("farad").className).toContain("select-none");
  });

  describe("dragged with the keyboard", () => {
    stubLabelsLayout();

    it("carries a label from the tray to the gap the arrows reach", async () => {
      const { onChange } = play();
      label("farad").focus();
      await userEvent.keyboard(" ");
      await userEvent.keyboard("{ArrowRight}");
      await userEvent.keyboard("{ArrowRight}");
      await userEvent.keyboard(" ");
      await waitFor(() => expect(onChange).toHaveBeenCalledWith({ blanks: [null, "1", null, null] }));
    });

    it("moves a placed label to another gap of its group, emptying the first", async () => {
      const { onChange } = play({ blanks: ["0", null, null, null] });
      screen.getByRole("button", { name: "Blank 1: ohm" }).focus();
      await userEvent.keyboard(" ");
      await userEvent.keyboard("{ArrowRight}");
      await userEvent.keyboard(" ");
      await waitFor(() => expect(onChange).toHaveBeenCalledWith({ blanks: ["", "0", null, null] }));
    });
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
   * A TABLE with a dropdown in a cell. The `|` of the hole never reaches the
   * table parser: `parseCloze` runs FIRST and the cell holds a sentinel by the
   * time marked splits the row (decision D5).
   */
  it("renders a GFM table, with the blank inside its cell", () => {
    const one = clozeServer.toStudent(
      config("| Polarisation | État |\n| --- | :-: |\n| Directe | {{=passante|bloquée}} |"),
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

  /** What a screen reader says of an element: its text, the `aria-hidden` parts left out. */
  const spoken = (el: Element) => {
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll("[aria-hidden='true']").forEach((node) => node.remove());
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  };
  /** The expected answers the text says after its chips, by their accessible label. */
  const keysInText = () => screen.queryAllByText(/^Expected: /).map((el) => el.textContent);
  const solution = { blanks: details.perBlank.map((b) => ({ index: b.index, expected: b.expected })) };
  const answer = { blanks: ["Newton", "9", null, "0", "n", "0"] };

  it("numbers every blank of the text like the table's first column, an empty one too (#1044)", () => {
    render(
      <ClozeReview
        student={student}
        answer={answer}
        solution={null}
        details={details}
        points={2}
        maxPoints={6}
        audience="student"
      />,
    );
    // The chip's own text is the answer; its number is read as "Blank n", never glued to it.
    expect(screen.getAllByText("Newton").map(spoken)).toContain("Blank 1: Newton");
    expect(screen.getAllByText("9").map(spoken)).toContain("Blank 2: 9");
    expect(spoken(screen.getByText("…"))).toBe("Blank 3: …");
    expect(screen.getAllByText("n").map(spoken)).toContain("Blank 5: n");
    // The visible numeral itself is hidden from the reader.
    const chip = screen.getAllByText("9").find((el) => spoken(el) === "Blank 2: 9");
    expect(chip?.querySelector("[aria-hidden='true']")?.textContent).toBe("2");
    // Without the key (`solution: null`), no expected answer follows a chip.
    expect(keysInText()).toEqual([]);
  });

  it("writes the expected answer after a wrong or empty blank when the solution is shown (#1044)", () => {
    const { container } = render(
      <ClozeReview
        student={student}
        answer={answer}
        solution={solution}
        details={details}
        points={2}
        maxPoints={6}
        audience="student"
      />,
    );
    // Blanks 2 and 5 are wrong, 3 is empty; the right ones carry no key.
    expect(keysInText()).toEqual(["Expected: 10", "Expected: += | + =", "Expected: /^N$/"]);
    // The visible key, cut when long, keeps the whole value in its title.
    expect(container.querySelector("[title='Expected: += | + =']")?.textContent).toBe("→ += | + =");
  });

  it("writes no expected answer after a right or accepted blank (#1044)", () => {
    const accepted = {
      ...details,
      perBlank: details.perBlank.map((b) => (b.index === 1 ? { ...b, ok: true, accepted: true as const } : b)),
    };
    render(
      <ClozeReview
        student={student}
        answer={answer}
        solution={solution}
        details={accepted}
        points={2}
        maxPoints={6}
        audience="student"
      />,
    );
    // Blank 1 right and blank 2 accepted at grading: only 3 (empty) and 5 (wrong) keep a key.
    expect(keysInText()).toEqual(["Expected: += | + =", "Expected: /^N$/"]);
  });

  it("writes no expected answer when the solution section is hidden (#109), keeping the numbers", () => {
    render(
      <ClozeReview
        student={student}
        answer={answer}
        solution={solution}
        details={details}
        points={2}
        maxPoints={6}
        audience="student"
        sections={{ solution: false }}
      />,
    );
    expect(keysInText()).toEqual([]);
    expect(spoken(screen.getByText("…"))).toBe("Blank 3: …");
  });

  it("hides the text and the expected column on request (#109), keeping every answer", () => {
    const { container } = render(
      <ClozeReview
        student={student}
        answer={{ blanks: ["Newton", "9", null, "0", "n", "0"] }}
        solution={{ blanks: details.perBlank.map((b) => ({ index: b.index, expected: b.expected })) }}
        details={details}
        points={2}
        maxPoints={6}
        audience="teacher"
        sections={{ prompt: false, solution: false }}
      />,
    );
    expect(screen.queryByText("Expected")).not.toBeInTheDocument();
    expect(screen.queryByText("10")).not.toBeInTheDocument();
    // The text is gone: only the table is left, one row per blank.
    expect(container.querySelectorAll("tbody tr")).toHaveLength(student.blanks.length);
    expect(container.firstElementChild?.firstElementChild?.tagName).toBe("TABLE");
    expect(screen.getByText("Newton")).toBeInTheDocument();
    expect(screen.getAllByText("Correct")).toHaveLength(3);
  });
});
