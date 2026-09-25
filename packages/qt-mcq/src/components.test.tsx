/**
 * Smoke tests of the three components: they render, they report every change
 * through their callback, and they hold no state of their own.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McqEditor } from "./Editor.js";
import { McqPlayer } from "./Player.js";
import { McqReview } from "./Review.js";
import { McqStats } from "./Stats.js";
import { multipleConfig, SECRET_CONFIG } from "./test/fixtures.js";
import { emptyMcqDraft, MCQ_MAX_CHOICES } from "./schema.js";
import { mcqServer } from "./server.js";

const student = mcqServer.toStudent(SECRET_CONFIG, { seed: 3, itemId: "i", shuffle: false });

describe("McqEditor", () => {
  it("renders the statement and every choice", () => {
    render(<McqEditor config={SECRET_CONFIG} onChange={() => {}} />);
    expect(screen.getByLabelText("Statement")).toHaveValue(SECRET_CONFIG.prompt);
    expect(screen.getByLabelText("Text of choice B")).toHaveValue("0x1004");
  });

  it("renders an empty draft without crashing (decision D16)", () => {
    render(<McqEditor config={emptyMcqDraft()} onChange={() => {}} />);
    expect(screen.getByLabelText("Statement")).toHaveValue("");
    expect(screen.getByLabelText("Text of choice A")).toHaveValue("");
  });

  it("reports a typed statement without keeping it", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={emptyMcqDraft()} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Statement"), "?");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ prompt: "?" }));
    // Controlled: the value only changes when the host sends a new config back.
    expect(screen.getByLabelText("Statement")).toHaveValue("");
  });

  it("adds a choice through onChange", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={SECRET_CONFIG} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a choice" }));
    expect(onChange.mock.calls[0]?.[0].choices).toHaveLength(4);
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
    expect(screen.getByRole("button", { name: "Reorder choice A" })).toBeDisabled();
  });
});

/*
 * The mode is DERIVED from the key set and never asked for (docs/04 §4.4):
 * there is no radio group left to click, so these tests drive the checkboxes
 * and read the mode back out of what the editor emitted.
 */
describe("McqEditor — the derived mode", () => {
  it("goes to multiple as soon as a second key is ticked", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={SECRET_CONFIG} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Choice A is correct"));
    const next = onChange.mock.calls[0]?.[0];
    expect(next.mode).toBe("multiple");
  });

  it("comes back to single — all or nothing, no limit — when one key is left", async () => {
    const onChange = vi.fn();
    render(
      <McqEditor
        config={multipleConfig({ policy: "true_false", maxSelections: 2 })}
        onChange={onChange}
      />,
    );
    // The fixture has two keys, A and B; un-ticking B leaves exactly one.
    await userEvent.click(screen.getByLabelText("Choice B is correct"));
    const next = onChange.mock.calls[0]?.[0];
    expect(next.mode).toBe("single");
    expect(next.policy).toBe("all_or_nothing");
    expect(next.choices.filter((c: { correct: boolean }) => c.correct)).toHaveLength(1);
    expect(next.maxSelections).toBeUndefined();
  });

  it("keeps the previous mode when nothing is ticked at all", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={multipleConfig({ choices: [
      { text: "a", correct: true },
      { text: "b", correct: false },
    ] })} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Choice A is correct"));
    const next = onChange.mock.calls[0]?.[0];
    expect(next.choices.some((c: { correct: boolean }) => c.correct)).toBe(false);
    // The validation issue says what is missing; the mode is not flipped
    // behind the teacher's back on the way to ticking another box.
    expect(next.mode).toBe("multiple");
  });

  it("offers a checkbox and never a radio, so the key set can go back to empty", () => {
    render(<McqEditor config={SECRET_CONFIG} onChange={() => {}} />);
    expect(screen.queryAllByRole("radio", { name: /is correct$/ })).toHaveLength(0);
    expect(screen.getAllByRole("checkbox", { name: /is correct$/ })).toHaveLength(3);
  });

  /*
   * The LETTER is that checkbox: one pastille per row, no second control and
   * no "Correct" label — a word that named nothing a teacher was looking for.
   */
  it("makes the letter itself the toggle, with no 'Correct' label left", () => {
    render(<McqEditor config={multipleConfig()} onChange={() => {}} />);
    expect(screen.queryByText("Correct")).toBeNull();
    for (const letter of ["A", "B", "C"]) {
      const box = screen.getByRole("checkbox", { name: `Choice ${letter} is correct` });
      // The visible face of the hidden input is the letter beside it.
      expect(box.closest("label")).toHaveTextContent(letter);
    }
  });

  it("ticks and un-ticks through the letter", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={multipleConfig()} onChange={onChange} />);
    const a = screen.getByRole("checkbox", { name: "Choice A is correct" });
    const c = screen.getByRole("checkbox", { name: "Choice C is correct" });
    // The fixture's key set is A and B.
    expect(a).toBeChecked();
    expect(c).not.toBeChecked();
    await userEvent.click(c);
    expect(onChange.mock.calls[0]?.[0].choices[2].correct).toBe(true);
    await userEvent.click(a);
    expect(onChange.mock.calls[1]?.[0].choices[0].correct).toBe(false);
  });

  it("names the drag handle alone, now that it carries no letter", () => {
    render(<McqEditor config={SECRET_CONFIG} onChange={() => {}} />);
    const handle = screen.getByRole("button", { name: "Reorder choice B" });
    expect(handle.textContent).toBe("");
  });
});

/*
 * The policy is a SEGMENTED control again: the six values of
 * `McqQuestionPolicy` are named in one word each now, so the whole set is
 * readable at a glance in the 288 px column the scoring card lives in — which
 * a closed <select> never was. `inherit` is the default — the evaluation
 * decides — and the line under the control says what the chosen one does.
 */
describe("McqEditor — the scoring policy", () => {
  const policy = () => screen.getByRole("radiogroup", { name: "Scoring policy" });

  it("is not drawn at all when the host gives no marks (a poll)", () => {
    render(<McqEditor config={multipleConfig()} onChange={() => {}} ungraded />);
    expect(screen.queryByRole("radiogroup", { name: "Scoring policy" })).not.toBeInTheDocument();
    expect(screen.queryByText("Scoring")).not.toBeInTheDocument();
    expect(screen.queryByText("Never shuffle this question")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Statement")).toBeInTheDocument();
    // The key is optional in a poll: no "Tick the correct answers" either.
    expect(screen.queryByText("Tick the correct answers.")).not.toBeInTheDocument();
  });

  it("offers the six policies, in order, inherit first", () => {
    render(<McqEditor config={multipleConfig({ policy: "inherit" })} onChange={() => {}} />);
    expect(
      within(policy())
        .getAllByRole("radio")
        .map((r) => r.closest("label")?.textContent),
    ).toEqual(["Inherited", "Exact", "True/false", "Distance", "Symmetric", "Ripkey"]);
    expect(within(policy()).getByRole("radio", { name: "Inherited" })).toBeChecked();
  });

  it("reports the picked policy", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={multipleConfig()} onChange={onChange} />);
    await userEvent.click(within(policy()).getByRole("radio", { name: "Ripkey" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ policy: "ripkey" }));
  });

  it("says in one line what the chosen policy does", () => {
    const { unmount } = render(
      <McqEditor config={multipleConfig({ policy: "inherit" })} onChange={() => {}} />,
    );
    expect(screen.getByTestId("mcq-policy-desc")).toHaveTextContent(
      "Uses the policy set on the evaluation.",
    );
    unmount();
    render(<McqEditor config={multipleConfig({ policy: "ripkey" })} onChange={() => {}} />);
    expect(screen.getByTestId("mcq-policy-desc")).toHaveTextContent(
      "The share of correct ticks, cancelled by any wrong tick.",
    );
  });

  it("is not there at all in single mode, where one key leaves nothing to choose", () => {
    render(<McqEditor config={SECRET_CONFIG} onChange={() => {}} />);
    expect(screen.queryByRole("radiogroup", { name: "Scoring policy" })).toBeNull();
    // What single mode DOES keep beside it.
    expect(screen.getByLabelText("Never shuffle this question")).toBeInTheDocument();
    expect(screen.queryByLabelText("Maximum selections")).toBeNull();
  });

  it("opens the host's help topic beside the label, and draws nothing without one", () => {
    const { unmount } = render(<McqEditor config={multipleConfig()} onChange={() => {}} />);
    expect(screen.queryByTestId("help")).toBeNull();
    unmount();
    render(
      <McqEditor
        config={multipleConfig()}
        onChange={() => {}}
        renderHelp={(topic) => <span data-testid="help">{topic}</span>}
      />,
    );
    expect(screen.getByTestId("help")).toHaveTextContent("mcq-policies");
  });

  it("puts the answer-limit issue under the answer limit", () => {
    // Built by hand and not through the schema: a cap below the key set is
    // exactly what `configSchema` refuses, and an invalid draft is a normal
    // state of this editor (decision D16).
    render(
      <McqEditor
        config={{ ...multipleConfig(), maxSelections: 1 }}
        onChange={() => {}}
        issues={[{ path: ["maxSelections"], message: "mcq.max_below_correct" }]}
      />,
    );
    // Said ONCE: the editor raises the same rule itself and recognises the
    // server's copy of it (translated or not).
    expect(screen.getAllByText(/maximum number of selections|max_below_correct/)).toHaveLength(1);
  });

  /*
   * The rule is checked HERE and not only by the server: a teacher who types
   * a 2 under three ticked answers is told at the keystroke, not half a
   * second later once an autosave came back — which is what they met.
   */
  it("says at once that the limit is below the key set, with no server round trip", async () => {
    function Host() {
      const [config, setConfig] = useState(
        multipleConfig({
          choices: [
            { text: "a", correct: true },
            { text: "b", correct: true },
            { text: "c", correct: true },
          ],
        }),
      );
      return <McqEditor config={config} onChange={setConfig} />;
    }
    render(<Host />);
    expect(screen.queryByText(/maximum number of selections/)).toBeNull();
    await userEvent.type(screen.getByLabelText("Maximum selections"), "2");
    expect(
      screen.getByText("The maximum number of selections is below the number of correct choices."),
    ).toBeInTheDocument();
  });

  it("takes the host's sentence for it, so the two never disagree", () => {
    render(
      <McqEditor
        config={{ ...multipleConfig(), maxSelections: 1 }}
        onChange={() => {}}
        strings={{ maxBelowCorrect: "Trop peu de sélections." }}
        issues={[{ path: ["maxSelections"], message: "Trop peu de sélections." }]}
      />,
    );
    expect(screen.getAllByText("Trop peu de sélections.")).toHaveLength(1);
  });
});

/*
 * The scoring settings belong to the right column of the host's editor, under
 * "Properties" — so the host lends the element and the editor portals into it
 * (`EditorProps.aside`). Without one, nothing moves: the same block renders
 * where it always did.
 */
describe("McqEditor — the scoring card in the host's aside", () => {
  it("portals the scoring block into the element the host lends", () => {
    const aside = document.createElement("div");
    aside.setAttribute("data-testid", "aside");
    document.body.append(aside);
    render(<McqEditor config={multipleConfig()} onChange={() => {}} aside={aside} />);
    expect(aside.textContent).toContain("Scoring");
    expect(within(aside).getByRole("radiogroup", { name: "Scoring policy" })).toBeInTheDocument();
    expect(within(aside).getByLabelText("Maximum selections")).toBeInTheDocument();
    expect(within(aside).getByLabelText("Never shuffle this question")).toBeInTheDocument();
    // The statement and the choices stay where they are.
    expect(aside.textContent).not.toContain("Statement");
    aside.remove();
  });

  it("keeps the scoring block inline when the host lends nothing", () => {
    const { container } = render(<McqEditor config={multipleConfig()} onChange={() => {}} />);
    expect(container.textContent).toContain("Scoring");
    expect(within(container).getByLabelText("Maximum selections")).toBeInTheDocument();
  });
});

describe("McqEditor — shuffling", () => {
  it("is allowed by default, and the box stores the opposite", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={multipleConfig()} onChange={onChange} />);
    const box = screen.getByLabelText("Never shuffle this question");
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ shuffleChoices: false }));
  });

  it("is ticked for a question that already refuses to be shuffled", () => {
    render(
      <McqEditor config={multipleConfig({ shuffleChoices: false })} onChange={() => {}} />,
    );
    expect(screen.getByLabelText("Never shuffle this question")).toBeChecked();
  });
});

describe("McqEditor — the keyboard writes the whole list", () => {
  it("Enter walks to the next choice", async () => {
    render(<McqEditor config={SECRET_CONFIG} onChange={() => {}} />);
    const first = screen.getByLabelText("Text of choice A");
    first.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByLabelText("Text of choice B")).toHaveFocus();
  });

  it("Enter on the LAST choice adds one", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={SECRET_CONFIG} onChange={onChange} />);
    screen.getByLabelText("Text of choice C").focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange.mock.calls[0]?.[0].choices).toHaveLength(4);
  });

  it("Tab at the end of the last choice adds one and focuses it", async () => {
    const onChange = vi.fn();
    function Host() {
      const [config, setConfig] = useState(SECRET_CONFIG);
      return (
        <McqEditor
          config={config}
          onChange={(next) => {
            onChange(next);
            setConfig(next);
          }}
        />
      );
    }
    render(<Host />);
    screen.getByLabelText("Text of choice C").focus();
    await userEvent.tab();
    expect(onChange.mock.calls[0]?.[0].choices).toHaveLength(4);
    await waitFor(() => expect(screen.getByLabelText("Text of choice D")).toHaveFocus());
  });

  it("Shift+Tab is the ordinary backwards Tab and adds nothing", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={SECRET_CONFIG} onChange={onChange} />);
    screen.getByLabelText("Text of choice C").focus();
    await userEvent.tab({ shift: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops adding at the maximum", async () => {
    const onChange = vi.fn();
    const full = multipleConfig({
      choices: Array.from({ length: MCQ_MAX_CHOICES }, (_, i) => ({
        text: `c${i}`,
        correct: i < 2,
      })),
    });
    render(<McqEditor config={full} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Add a choice" })).toBeDisabled();
    screen.getByLabelText(`Text of choice ${String.fromCharCode(64 + MCQ_MAX_CHOICES)}`).focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * `@dnd-kit` reorders by comparing the RECTANGLES of the rows, and jsdom runs
 * no layout: every element reports a zero-sized box at the origin, so the
 * keyboard sensor has nowhere to move to and no collision to detect. This
 * stub lays the choice rows out in a column — 40 px each, in DOM order — for
 * the duration of the reordering suite. It fakes geometry, nothing else: the
 * sensor, the collision detection and the editor's `onDragEnd` are the real
 * ones.
 */
function stubRowLayout() {
  const real = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const parent = this.parentElement;
      const row =
        this.tagName === "LI" && parent ? Array.from(parent.children).indexOf(this) : 0;
      const top = this.tagName === "LI" ? row * 40 : 0;
      const height = this.tagName === "LI" ? 40 : 0;
      return {
        x: 0, y: top, top, left: 0, right: 600, bottom: top + height,
        width: 600, height, toJSON: () => ({}),
      } as DOMRect;
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = real;
  });
}

describe("McqEditor — reordering", () => {
  stubRowLayout();

  it("offers one focusable drag handle per choice, named", () => {
    render(<McqEditor config={SECRET_CONFIG} onChange={() => {}} />);
    const handles = screen.getAllByRole("button", { name: /^Reorder choice/ });
    expect(handles).toHaveLength(3);
    // A BUTTON, not a div with a listener: that is what makes the keyboard
    // sensor reachable at all (focus it, Space, arrows, Space).
    for (const handle of handles) {
      expect(handle.tagName).toBe("BUTTON");
      expect(handle).toHaveAttribute("aria-roledescription", "sortable");
    }
    expect(screen.queryByRole("button", { name: /^Move (up|down)/ })).toBeNull();
  });

  it("moves a choice with the keyboard alone", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={SECRET_CONFIG} onChange={onChange} />);
    screen.getByRole("button", { name: "Reorder choice A" }).focus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard(" ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = onChange.mock.calls[0]?.[0];
    expect(next.choices.map((c: { text: string }) => c.text)).toEqual([
      "0x1004",
      "0x1001",
      "0x1008",
    ]);
  });

  it("refuses to delete below the minimum", () => {
    const two = multipleConfig({
      choices: [
        { text: "a", correct: true },
        { text: "b", correct: false },
      ],
    });
    const { unmount } = render(<McqEditor config={two} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Remove choice A" })).toBeDisabled();
    unmount();
    render(<McqEditor config={SECRET_CONFIG} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Remove choice A" })).toBeEnabled();
  });

  it("removes the choice the bin belongs to", async () => {
    const onChange = vi.fn();
    render(<McqEditor config={SECRET_CONFIG} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove choice B" }));
    expect(onChange.mock.calls[0]?.[0].choices.map((c: { text: string }) => c.text)).toEqual([
      "0x1001",
      "0x1008",
    ]);
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
    // Two keys, so the cap cannot go below two (`mcq.max_below_correct`): the
    // student has spent it, and only the boxes they did NOT tick lock.
    const config = multipleConfig({ maxSelections: 2 });
    const view = mcqServer.toStudent(config, { seed: 1, itemId: "i", shuffle: false });
    render(
      <McqPlayer student={view} answer={{ selected: [0, 1] }} onChange={() => {}} readOnly={false} />,
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[0]).toBeEnabled();
    expect(boxes[1]).toBeEnabled();
    expect(boxes[2]).toBeDisabled();
  });

  it("is read-only once the attempt is closed", () => {
    render(<McqPlayer student={student} answer={{ selected: [0] }} onChange={() => {}} readOnly />);
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });

  /*
   * The student meets the same pastille as the teacher: the letter IS the
   * control, at 40 px, and the accessible name stays the TEXT of the choice —
   * the letter is an index of the list, not something to read out.
   */
  it("shows one lettered pastille per choice and selects through it", async () => {
    const onChange = vi.fn();
    render(<McqPlayer student={student} answer={null} onChange={onChange} readOnly={false} />);
    const first = screen.getByRole("radio", { name: student.choices[0]!.text });
    expect(first.closest("label")).toHaveTextContent("A");
    await userEvent.click(first);
    expect(onChange).toHaveBeenCalledWith({ selected: [student.choices[0]!.id] });
    expect(screen.queryByRole("radio", { name: /^A$/ })).toBeNull();
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

  /* #109: the grading page may put the question's own parts away; the
     student's ticks and their verdicts always stay. */
  it("hides the prompt and the missed choices on request, never the verdict on a tick", () => {
    render(
      <McqReview
        student={student}
        answer={{ selected: [0] }}
        solution={{ correct: [1] }}
        details={null}
        points={0}
        maxPoints={2}
        audience="teacher"
        sections={{ prompt: false, solution: false }}
        renderMarkdown={(source: string) => <span data-testid="md">{source}</span>}
      />,
    );
    expect(screen.queryByText(student.prompt)).toBeNull();
    expect(screen.queryByText("Missed")).toBeNull();
    expect(screen.getByText("Incorrect")).toBeInTheDocument();
    expect(screen.getAllByTestId("md")).toHaveLength(student.choices.length);
  });

  it("shows every part when no sections are given", () => {
    render(
      <McqReview
        student={student}
        answer={{ selected: [0] }}
        solution={{ correct: [1] }}
        details={null}
        points={0}
        maxPoints={2}
        audience="teacher"
        renderMarkdown={(source: string) => <span data-testid="md">{source}</span>}
      />,
    );
    expect(screen.getByText(student.prompt)).toBeInTheDocument();
    expect(screen.getByText("Missed")).toBeInTheDocument();
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
