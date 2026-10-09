/**
 * Smoke tests of the three components: they render, they report every change
 * through their callback with canonical ids, and they hold no state of their
 * own but the card being moved. The moves go through the click-then-click
 * path — the one that needs no geometry, which jsdom does not have.
 */
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { testGradeContext } from "@quiz/core/testing";
import { CategorizeEditor } from "./Editor.js";
import { CategorizePlayer } from "./Player.js";
import { CategorizeReview } from "./Review.js";
import { categorizeServer } from "./server.js";
import type { CategorizeAnswer, CategorizeConfig } from "./schema.js";
import { C, config, K } from "./test/fixtures.js";

const cfg = config();
const student = categorizeServer.toStudent(cfg, { seed: 0, itemId: "i", shuffle: false });

describe("CategorizeEditor", () => {
  it("adds a card to the tray, as a distractor", async () => {
    const onChange = vi.fn();
    render(<CategorizeEditor config={cfg} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("New definition, Enter to add"), "`long`{Enter}");
    const next = onChange.mock.calls.at(-1)![0] as CategorizeConfig;
    expect(next.cards).toHaveLength(cfg.cards.length + 1);
    expect(next.cards.at(-1)!.text).toBe("`long`");
    expect(next.columns).toEqual(cfg.columns);
  });

  it("adds a column, and removing one sends its cards back to the tray", async () => {
    const onChange = vi.fn();
    render(<CategorizeEditor config={cfg} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a column" }));
    const added = onChange.mock.calls.at(-1)![0] as CategorizeConfig;
    expect(added.columns).toHaveLength(4);
    expect(added.columns[3]).toMatchObject({ label: "", cards: [] });

    await userEvent.click(screen.getByRole("button", { name: "Remove column 1" }));
    const removed = onChange.mock.calls.at(-1)![0] as CategorizeConfig;
    expect(removed.columns.map((c) => c.id)).toEqual([C.float, C.ptr]);
    // The cards stay; with no column listing them, they are distractors now.
    expect(removed.cards).toEqual(cfg.cards);
  });

  it("moves a card with the keyboard: Enter on it, then Enter on a column", async () => {
    const onChange = vi.fn();
    render(<CategorizeEditor config={cfg} onChange={onChange} />);
    // Card 7 is `string`, a distractor in the tray.
    const handle = screen.getByRole("button", { name: "Move card 7" });
    handle.focus();
    await userEvent.keyboard("{Enter}");
    expect(handle).toHaveAttribute("aria-pressed", "true");
    screen.getByRole("button", { name: "Move the selected card to Pointer" }).focus();
    await userEvent.keyboard("{Enter}");
    const next = onChange.mock.calls.at(-1)![0] as CategorizeConfig;
    expect(next.columns.find((c) => c.id === C.ptr)!.cards).toEqual([K.voidp, K.charp, K.string]);
  });
});

describe("CategorizePlayer", () => {
  it("says the rules, and lists every card in the tray", () => {
    render(<CategorizePlayer student={student} answer={null} onChange={() => {}} readOnly={false} />);
    expect(screen.getByText(/Drag each card into its column\. A card may belong to no column\./)).toBeInTheDocument();
    expect(screen.getByText("8 left")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Put everything back" })).toBeNull();
  });

  it("moves a card by a click on it, then a click on a column, with canonical ids", async () => {
    const onChange = vi.fn();
    render(<CategorizePlayer student={student} answer={null} onChange={onChange} readOnly={false} />);
    await userEvent.click(screen.getByRole("button", { name: "`double`" }));
    await userEvent.click(screen.getByRole("button", { name: "Move the selected card to Floating point" }));
    expect(onChange).toHaveBeenLastCalledWith({ columns: { [C.float]: [K.double] } });
  });

  it("puts a placed card back in the tray, and everything back at once", async () => {
    const onChange = vi.fn();
    const answer: CategorizeAnswer = { columns: { [C.int]: [K.int, K.size] } };
    render(<CategorizePlayer student={student} answer={answer} onChange={onChange} readOnly={false} />);
    await userEvent.click(screen.getByRole("button", { name: "`int`" }));
    await userEvent.click(screen.getByRole("button", { name: "Move the selected card back to the tray" }));
    expect(onChange).toHaveBeenLastCalledWith({ columns: { [C.int]: [K.size] } });
    await userEvent.click(screen.getByRole("button", { name: "Put everything back" }));
    expect(onChange).toHaveBeenLastCalledWith({ columns: {} });
  });

  it("shows the ranks when the order counts", () => {
    const ordered = { ...student, ordered: true };
    render(
      <CategorizePlayer student={ordered} answer={{ columns: { [C.int]: [K.int, K.size] } }} onChange={() => {}} readOnly={false} />,
    );
    expect(screen.getByText(/in the right order/)).toBeInTheDocument();
    const int = screen.getByRole("button", { name: /`size_t`/ });
    expect(within(int).getByText("2")).toBeInTheDocument();
  });

  it("locks everything when read-only", async () => {
    const onChange = vi.fn();
    render(
      <CategorizePlayer student={student} answer={{ columns: { [C.int]: [K.int] } }} onChange={onChange} readOnly />,
    );
    const card = screen.getByRole("button", { name: "`double`" });
    expect(card).toBeDisabled();
    await userEvent.click(card);
    expect(screen.queryByRole("button", { name: /Move the selected card/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Put everything back" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tells the student about negative marking", () => {
    render(
      <CategorizePlayer student={{ ...student, negativeMarking: true }} answer={null} onChange={() => {}} readOnly={false} />,
    );
    expect(screen.getByRole("note")).toHaveTextContent("Wrong placements cost points");
  });
});

describe("CategorizeReview", () => {
  const answer: CategorizeAnswer = { columns: { [C.int]: [K.int, K.double], [C.ptr]: [K.string] } };
  const graded = categorizeServer.grade(cfg, answer, testGradeContext(2));
  if (graded instanceof Promise || graded.kind !== "graded") throw new Error("sync grade expected");
  const solution = categorizeServer.toSolution(cfg, { seed: 0, itemId: "i", shuffle: false });

  it("marks every card and says where a wrong one belonged", () => {
    render(
      <CategorizeReview
        student={student}
        answer={answer}
        solution={solution}
        details={graded.details}
        points={graded.points}
        maxPoints={2}
        audience="student"
      />,
    );
    expect(screen.getAllByText("Right").length).toBeGreaterThan(0);
    // `double` in Integer, and `float` left out, both belong in Floating point.
    expect(screen.getAllByText("Expected: Floating point")).toHaveLength(2);
    expect(screen.getByText("Expected: no column")).toBeInTheDocument();
    expect(screen.getByText("Left out")).toBeInTheDocument();
    // int and the boolean left out: 2 of 8.
    expect(screen.getByText(/Cards right 2\/8/)).toBeInTheDocument();
  });

  it("keeps the verdicts but hides the key without a solution", () => {
    const redacted = categorizeServer.studentDetails!(graded.details, { showKey: false, showHiddenCaseNames: false });
    render(
      <CategorizeReview
        student={student}
        answer={answer}
        solution={null}
        details={redacted as typeof graded.details}
        points={graded.points}
        maxPoints={2}
        audience="student"
      />,
    );
    expect(screen.getAllByText("Wrong").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Expected/)).toBeNull();
    // The cards left in the tray carry no verdict, and the count is the student's own placements.
    const leftOut = screen.getByText("Left out").parentElement!;
    expect(within(leftOut).queryByText(/^(Right|Wrong)$/)).toBeNull();
    expect(screen.getByText(/Placed cards right 1\/3/)).toBeInTheDocument();
  });

  it("hides the key when the solution section is off", () => {
    render(
      <CategorizeReview
        student={student}
        answer={answer}
        solution={solution}
        details={graded.details}
        points={graded.points}
        maxPoints={2}
        audience="teacher"
        sections={{ solution: false, prompt: false }}
      />,
    );
    expect(screen.queryByText(/^Expected/)).toBeNull();
    expect(screen.queryByText(cfg.prompt)).toBeNull();
  });
});
