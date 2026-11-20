import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GradingEntry } from "@quiz/contracts";

import { GradingPanel } from "./GradingPanel";
import { QuestionHost } from "../student/QuestionHost";
import { GRADING_VIEW_KEY } from "./view";
import {
  makeEntry,
  makeEvaluationDetail,
  makeGrading,
  makeQueue,
  makeSteps,
} from "../test/grading-fixtures";
import { elapse, flowingClock } from "../test/clock";
import { makeCourseSummary } from "../test/fixtures";
import { fail, mockFetch, noContent, ok, publicConfig, renderWithProviders } from "../test/render";

/*
 * The grading screen (ADR-044): one question as a table, the key pinned on
 * top, the type's own columns, anonymised by default, one primary action,
 * and the answer panel keyed on the ENTRY.
 */

const EVAL = "/app/api/evaluations/e1";
const QUEUE = (itemId: string, anonymous = "1") =>
  `${EVAL}/grading?itemId=${itemId}&anonymous=${anonymous}`;

const proposal = (attemptId: string, points: number) =>
  makeEntry({
    attemptId,
    grading: makeGrading({
      id: `g-${attemptId}`,
      attemptId,
      points,
      state: "proposed",
      confidence: "high",
    }),
  });
const validated = (attemptId: string, points: number) =>
  makeEntry({
    attemptId,
    answer: { selected: points > 0 ? [1] : [0] },
    grading: makeGrading({
      id: `g-${attemptId}`,
      attemptId,
      points,
      state: "validated",
      confidence: null,
    }),
  });

function routes(
  entries: GradingEntry[] | (() => GradingEntry[]),
  over: Record<string, unknown> = {},
) {
  const read = typeof entries === "function" ? entries : () => entries;
  return {
    [`GET ${EVAL}`]: ok(makeEvaluationDetail()),
    // The reader's role on the evaluation's course (`c1`), ADR-068.
    "GET /app/api/courses": ok([makeCourseSummary()]),
    [`GET ${QUEUE("i1")}`]: () => ok(makeQueue(read())),
    [`GET ${QUEUE("i2")}`]: ok(makeQueue([validated("a1", 3)])),
    [`GET ${EVAL}/grading/steps`]: ok(
      makeSteps([{ key: "i1", total: 3, validated: 1 }, { key: "i2" }]),
    ),
    [`GET ${EVAL}/grading/progress`]: ok({
      done: 3,
      total: 3,
      pending: { runner: 0, llm: 0 },
      failed: 0,
    }),
    ...over,
  } as Parameters<typeof mockFetch>[0];
}

const table = () => screen.findByRole("table", { name: "Answers to question 1" });
/** The answer rows, the header and the expected row left out. */
const answerRows = async () => (await within(await table()).findAllByRole("row")).slice(2);
const rowOf = (attemptId: string) =>
  document.querySelector<HTMLElement>(`[data-row="${attemptId}:i1"]`)!;

beforeEach(() => {
  // jsdom has no EventSource; `progress.ts` copes, and so must the test.
  vi.stubGlobal("EventSource", undefined);
  localStorage.clear();
});

/** A header's words, without the phone's aria-hidden short form. */
const headerText = (h: HTMLElement) =>
  [...h.querySelectorAll("[aria-hidden]")].reduce(
    (text, el) => text.replace(el.textContent ?? "", ""),
    h.textContent ?? "",
  );

describe("GradingPanel — the table", () => {
  it("draws the type's columns under the key, anonymised: no Student column and no name", async () => {
    mockFetch(routes([proposal("a1", 2), validated("a2", 0)].map((e) => ({ ...e, label: null }))));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);

    const t = await table();
    const heads = within(t)
      .getAllByRole("columnheader")
      .map(headerText);
    // mcq: one column per choice, lettered canonically.
    expect(heads).toEqual(["Verdict", "A · 4", "B · 8", "Points", "Actions"]);
    // A choice's header shows its letter alone, at every width (#1083): the
    // whole text is its tooltip and accessible name, and the column fits it.
    const a = within(t).getAllByRole("columnheader")[1]!;
    expect(a.querySelector("span[aria-hidden]")?.textContent).toBe("A");
    expect(a.querySelector(".sr-only")?.textContent).toBe("A · 4");
    expect(a.querySelector("[title]")).toHaveAttribute("title", "A · 4");
    expect(within(a).getByRole("button", { name: "A · 4" })).toBeInTheDocument();
    expect(a).toHaveClass("w-px");
    // The expected row is the first one, marking the correct choice.
    const [, expected] = within(t).getAllByRole("row");
    expect(within(expected!).getByRole("img", { name: "Expected answer" })).toBeInTheDocument();
    expect(within(expected!).getByRole("img", { name: "Expected" })).toBeInTheDocument();
    expect(await answerRows()).toHaveLength(2);
    expect(screen.queryByText("Swift Otter")).toBeNull();
  });

  it("opens the statement from the question's name: the whole text a letter stands for", async () => {
    mockFetch(routes([proposal("a1", 2)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    const name = screen.getByRole("button", { name: "Show the statement: sizeof-ptr" });
    expect(name).toHaveTextContent("sizeof-ptr");
    await userEvent.click(name);
    const panel = await screen.findByRole("dialog", { name: "Question 1" });
    expect(await within(panel).findByText("Statement")).toBeInTheDocument();
    expect(within(panel).getByText("Expected answer")).toBeInTheDocument();
  });

  it("shows the names on request, in their own column, from a named request", async () => {
    const named = [
      { ...proposal("a1", 2), label: "Zoe Blanc" },
      { ...validated("a2", 0), label: "Adam Perret" },
    ];
    const { calls } = mockFetch(
      routes([proposal("a1", 2), validated("a2", 0)], {
        [`GET ${QUEUE("i1", "0")}`]: ok(makeQueue(named)),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    await userEvent.click(screen.getByRole("switch", { name: "Anonymise" }));
    expect(await screen.findByRole("columnheader", { name: /Student/ })).toBeInTheDocument();
    // By name, whatever order the server sent.
    const names = (await answerRows()).map(
      (r) => within(r).queryByText(/Blanc|Perret/)?.textContent,
    );
    expect(names).toEqual(["Adam Perret", "Zoe Blanc"]);
    expect(calls.map((c) => c.url)).toContain(QUEUE("i1", "0"));
  });

  it("sorts by a column, then back to the base order on the third click", async () => {
    mockFetch(routes([proposal("a1", 2), validated("a2", 0), validated("a3", 2)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const base = (await answerRows()).map((r) => r.dataset.row);

    const points = screen.getByRole("button", { name: "Points" });
    await userEvent.click(points);
    expect((await answerRows())[0]!.dataset.row).toBe("a2:i1");
    await userEvent.click(points);
    await userEvent.click(points);
    expect((await answerRows()).map((r) => r.dataset.row)).toEqual(base);
  });
});

describe("GradingPanel — the one primary action", () => {
  it("validates the visible proposals of the question in one call", async () => {
    const { calls } = mockFetch(
      routes([proposal("a1", 2), proposal("a2", 1), validated("a3", 2)], {
        [`POST ${EVAL}/grading/validate-batch`]: ok({ validated: 2 }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: /Validate 2/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/validate-batch"))?.body).toEqual({
        itemId: "i1",
        state: "proposed",
      }),
    );
  });

  it("becomes Next question once the question is validated, then Results on the last", async () => {
    const navigate = vi.fn();
    mockFetch(routes([validated("a1", 2)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={navigate} />);

    const next = await screen.findAllByRole("button", { name: /^Next question/ });
    // The chevron and the primary: the primary is the one with words.
    await userEvent.click(next.find((b) => b.textContent?.trim() === "Next question")!);
    expect(await screen.findByText("Question 2 of 2")).toBeInTheDocument();
    // On the last question the primary is the way to the results: the
    // header's secondary button and it, the primary coming last.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Results/ })).toHaveLength(2));
    await userEvent.click(screen.getAllByRole("button", { name: /Results/ }).at(-1)!);
    expect(navigate).toHaveBeenCalledWith({ view: "results", evaluationId: "e1" });
  });

  it("stays, disabled, while what is left needs a grade by hand", async () => {
    const placeholder = makeEntry({
      attemptId: "a1",
      grading: makeGrading({
        attemptId: "a1",
        points: 0,
        state: "proposed",
        confidence: null,
      }),
    });
    mockFetch(routes([placeholder]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();
    // The primary Validate is disabled, and the row offers Grade, not Validate.
    expect(screen.getByRole("button", { name: /^Validate$/ })).toBeDisabled();
    expect(within(rowOf("a1")).queryByRole("button", { name: /^Validate$/ })).toBeNull();
    expect(within(rowOf("a1")).getByRole("button", { name: "Grade" })).toBeInTheDocument();
    // Its verdict is not judged yet.
    expect(within(rowOf("a1")).getByRole("img", { name: "To grade by hand" })).toBeInTheDocument();
  });
});

const placeholder = (attemptId: string) =>
  makeEntry({
    attemptId,
    grading: makeGrading({
      id: `g-${attemptId}`,
      attemptId,
      points: 0,
      state: "proposed",
      confidence: null,
      details: { reason: "manual" },
    }),
  });

describe("GradingPanel — an essay to grade by hand", () => {
  it("opens on the grading form, with no Validate in the panel", async () => {
    mockFetch(routes([placeholder("a1")]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();
    await userEvent.click(within(rowOf("a1")).getByRole("button", { name: "Grade" }));
    const panel = await screen.findByRole("dialog");
    expect(within(panel).getByRole("spinbutton", { name: /Points/ })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Validate" })).toBeNull();
  });

  it("opens on the form from a click on the row too", async () => {
    mockFetch(routes([placeholder("a1")]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();
    await userEvent.click(rowOf("a1"));
    const panel = await screen.findByRole("dialog");
    expect(within(panel).getByRole("spinbutton", { name: /Points/ })).toBeInTheDocument();
  });

  it("is never validated by V", async () => {
    const { calls } = mockFetch(routes([placeholder("a1")]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();
    await userEvent.keyboard("{ArrowDown}");
    expect(rowOf("a1")).toHaveAttribute("aria-current", "true");
    const user = flowingClock();
    await user.keyboard("v");
    await elapse(50);
    expect(calls.some((c) => c.url.endsWith("/validate"))).toBe(false);
  });
});

describe("GradingPanel — the answer panel", () => {
  it("stays on its entry after a validation under To validate", async () => {
    localStorage.setItem(GRADING_VIEW_KEY, JSON.stringify({ stateFilter: "todo" }));
    let state: GradingEntry[] = [proposal("a1", 2), proposal("a2", 1)];
    mockFetch(
      routes(() => state, {
        [`POST /app/api/gradings/g-a1/validate`]: () => {
          state = [validated("a1", 2), proposal("a2", 1)];
          return ok({});
        },
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    await userEvent.click(rowOf("a1"));
    const panel = await screen.findByRole("dialog", { name: "Anonymous answer" });
    await userEvent.click(within(panel).getByRole("button", { name: "Validate" }));

    // The row leaves the filtered table…
    await waitFor(() => expect(rowOf("a1")).toBeNull());
    // …and the panel still shows the answer it opened on, now validated —
    // not the next student's, which took its place in the table.
    await waitFor(() => expect(within(panel).getByText(/validated/)).toBeInTheDocument());
    expect(within(panel).getByText(/2 \/ 2 pts/)).toBeInTheDocument();
  });

  describe("on a wide window", () => {
    const matchMedia = window.matchMedia;
    beforeEach(() => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        ...matchMedia(query),
        matches: query === "(min-width: 1280px)",
      }));
    });
    afterEach(() => {
      vi.stubGlobal("matchMedia", matchMedia);
    });

    it("docks beside the table, which stays clickable and walkable, and closes on Escape", async () => {
      mockFetch(routes([proposal("a1", 2), proposal("a2", 1)]));
      renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
      await table();

      await userEvent.click(rowOf("a1"));
      const pane = await screen.findByRole("complementary", { name: "Anonymous answer" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(within(pane).getByText(/2 \/ 2 pts/)).toBeInTheDocument();

      // Another row, clicked in the table the pane leaves open.
      await userEvent.click(rowOf("a2"));
      expect(await within(pane).findByText(/1 \/ 2 pts/)).toBeInTheDocument();
      // The arrows walk the table with the pane open, in the visit's shuffled order.
      const a1First =
        rowOf("a1").compareDocumentPosition(rowOf("a2")) & Node.DOCUMENT_POSITION_FOLLOWING;
      await userEvent.keyboard(a1First ? "{ArrowUp}" : "{ArrowDown}");
      expect(await within(pane).findByText(/2 \/ 2 pts/)).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("complementary")).toBeNull();
    });

    it("gives the focus back to the row when the pane is closed from inside", async () => {
      mockFetch(routes([proposal("a1", 2)]));
      renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
      await table();
      await userEvent.click(rowOf("a1"));
      const pane = await screen.findByRole("complementary", { name: "Anonymous answer" });

      await userEvent.click(within(pane).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("complementary")).toBeNull();
      await waitFor(() => expect(rowOf("a1")).toHaveFocus());
    });

    it("keeps the pane open across a change of question, on the new question's key", async () => {
      mockFetch(routes([proposal("a1", 2)]));
      renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
      await table();
      await userEvent.click(rowOf("a1"));
      await screen.findByRole("complementary", { name: "Anonymous answer" });

      await userEvent.keyboard("{ArrowRight}");
      expect(
        await screen.findByRole("table", { name: "Answers to question 2" }),
      ).toBeInTheDocument();
      expect(
        await screen.findByRole("complementary", { name: "Question 2" }),
      ).toBeInTheDocument();
      expect(document.querySelector('[data-row="expected"]')).toHaveAttribute("aria-current", "true");

      // The question bar's arrows too; only the ✕ closes it.
      await userEvent.click(screen.getByRole("button", { name: "Previous question" }));
      const pane = await screen.findByRole("complementary", { name: "Question 1" });
      await userEvent.click(within(pane).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("complementary")).toBeNull();

      // Closed, it stays closed on the next question.
      await userEvent.keyboard("{ArrowRight}");
      await screen.findByRole("table", { name: "Answers to question 2" });
      expect(screen.queryByRole("complementary")).toBeNull();
    });

    it("waits for the next question's answers before drawing its statement (#1072)", async () => {
      // The statement comes with the answers: until they arrive, the pane
      // that followed the change of question has no view to hand a player,
      // and a cloze player read `null.blanks` and took the page down —
      // whenever its chunk was already loaded ("sometimes").
      const cloze = {
        template: "Type ⸢0⸣.",
        blanks: [{ index: 0, weight: 1, kind: "text" }],
      };
      const warm = renderWithProviders(
        <QuestionHost type="cloze" student={cloze} answer={null} onChange={vi.fn()} readOnly />,
      );
      await screen.findByRole("textbox", { name: "Blank 1" });
      warm.unmount();
      const detail = makeEvaluationDetail();
      let arrive: (() => void) | undefined;
      const { fetchMock } = mockFetch(
        routes([proposal("a1", 2)], {
          [`GET ${EVAL}`]: ok({
            ...detail,
            items: detail.items.map((i) => (i.id === "i2" ? { ...i, type: "cloze" } : i)),
          }),
          [`GET ${QUEUE("i2")}`]: ok(
            makeQueue(
              [
                makeEntry({
                  attemptId: "a1",
                  itemId: "i2",
                  answer: { blanks: ["int"] },
                  student: cloze,
                  solution: { blanks: [{ index: 0, expected: "int" }] },
                  grading: null,
                }),
              ],
              { items: [{ id: "i2", position: 1, internalName: "types", type: "cloze", points: 1 }] },
            ),
          ),
        }),
      );
      const reply = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input, init) =>
        String(input) === QUEUE("i2")
          ? new Promise((resolve) => {
              arrive = () => resolve(reply(input, init));
            })
          : reply(input, init),
      );
      renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
      await table();
      await userEvent.click(rowOf("a1"));
      await screen.findByRole("complementary", { name: "Anonymous answer" });

      await userEvent.keyboard("{ArrowRight}");
      const pane = await screen.findByRole("complementary", { name: "Question 2" });
      await waitFor(() => expect(arrive).toBeDefined());
      expect(within(pane).queryByText("Statement")).toBeNull();

      arrive!();
      expect(await within(pane).findByText("Statement")).toBeInTheDocument();
      expect(await within(pane).findByRole("textbox", { name: "Blank 1" })).toBeInTheDocument();
    });
  });

  it("shows an AI proposal's justification to the teacher, marked as never shown to the student", async () => {
    const ai = makeEntry({
      attemptId: "a1",
      grading: makeGrading({
        id: "g-a1",
        attemptId: "a1",
        points: 2,
        state: "proposed",
        source: "llm",
        confidence: "high",
        comment: null,
        details: {
          justification: "Covers the rubric.",
          ai: {
            model: "claude-sonnet-5-5",
            criteria: [{ criterion: "The stack is bounded", points: 1.5, maxPoints: 2, comment: "Said, not explained." }],
          },
        },
      }),
    });
    mockFetch(routes([ai]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    await userEvent.click(rowOf("a1"));
    const panel = await screen.findByRole("dialog", { name: "Anonymous answer" });
    expect(within(panel).getByText("The AI's justification, not shown to the student")).toBeInTheDocument();
    expect(within(panel).getByText("Covers the rubric.")).toBeInTheDocument();
    // Its points per criterion and the model that wrote it (ADR-063).
    const criteria = within(panel).getByRole("list", { name: "Points per criterion" });
    expect(within(criteria).getByText("The stack is bounded")).toBeInTheDocument();
    expect(within(criteria).getByText("Said, not explained.")).toBeInTheDocument();
    expect(within(panel).getByText("Proposed by Claude Sonnet 5.5")).toBeInTheDocument();

    // The teacher may copy it into the comment, which they then edit (ADR-063 §7).
    await userEvent.click(within(panel).getByRole("button", { name: /Adjust/ }));
    await userEvent.click(within(panel).getByRole("button", { name: "Use as comment" }));
    expect(within(panel).getByRole("textbox", { name: /comment/i })).toHaveValue("Covers the rubric.");
    expect(within(panel).queryByRole("button", { name: "Use as comment" })).toBeNull();
  });

  it("opens the key from the expected row, with Re-grade and Edit question", async () => {
    const navigate = vi.fn();
    mockFetch(routes([proposal("a1", 2)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={navigate} />);
    const [, expected] = within(await table()).getAllByRole("row");

    await userEvent.click(expected!);
    const panel = await screen.findByRole("dialog", { name: "Question 1" });
    await userEvent.click(within(panel).getByRole("button", { name: /Edit question/ }));
    expect(navigate).toHaveBeenCalledWith({
      view: "question",
      id: "q1",
      fromGrading: "e1",
      item: "i1",
    });
  });
});

/*
 * A parameterized question (ADR-056 §9): every answer has its own key. The
 * expected row is the question as written, the rows are grouped by verdict,
 * and the panel lays the student's values beside their answer.
 */
describe("GradingPanel — a parameterized question", () => {
  const TEMPLATE = {
    student: {
      prompt: "Dropped from [[h]] m: how long?",
      choices: [
        { id: 0, text: "[[t]] s" },
        { id: 1, text: "[[sqrt(h/g)]] s" },
      ],
      mode: "single",
    },
    solution: { correct: [0] },
    example: false,
  };
  const VARIABLES = {
    rows: [
      { name: "h", expr: "randint(10, 100)", format: "int" },
      { name: "t", expr: "sqrt(2*h/9.81)", format: ".2" },
    ],
    condition: "t > 1.5",
  };
  const own = (attemptId: string, points: number, h: string) => ({
    ...validated(attemptId, points),
    values: [
      { name: "h", value: h },
      { name: "t", value: "2.02" },
    ],
  });
  const queue = (template = TEMPLATE) =>
    ok(
      makeQueue([own("a1", 2, "20"), own("a2", 0, "45"), own("a3", 2, "80")], {
        items: [
          {
            id: "i1",
            position: 0,
            internalName: "fall",
            type: "mcq",
            points: 2,
            parameters: { variables: VARIABLES, template },
          },
        ],
      }),
    );

  it("pins the question as written, says each answer has its own key, and groups the rows by verdict", async () => {
    mockFetch(routes([], { [`GET ${QUEUE("i1")}`]: queue() }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);

    const t = await table();
    const heads = within(t)
      .getAllByRole("columnheader")
      .map(headerText);
    // The template's choices, never one student's numbers.
    expect(heads).toEqual(["Verdict", "A · [[t]] s", "B · [[sqrt(h/g)]] s", "Points", "Actions"]);
    const [, expected] = within(t).getAllByRole("row");
    expect(within(expected!).getByText("Own key per answer")).toBeInTheDocument();
    // The wrong answer first, whatever the shuffle drew.
    expect((await answerRows())[0]!.dataset.row).toBe("a2:i1");
  });

  it("opens the variables on the expected row and the student's own values on an answer", async () => {
    mockFetch(routes([], { [`GET ${QUEUE("i1")}`]: queue() }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const [, expected] = within(await table()).getAllByRole("row");

    await userEvent.click(expected!);
    const key = await screen.findByRole("dialog", { name: "Question 1" });
    expect(within(key).getByText("Variables")).toBeInTheDocument();
    expect(within(key).getByText("= randint(10, 100)")).toBeInTheDocument();
    expect(within(key).getByText("t > 1.5")).toBeInTheDocument();

    await userEvent.click(rowOf("a2"));
    const answer = await screen.findByRole("dialog", { name: "Anonymous answer" });
    const values = within(answer).getByText("This student's values").parentElement!;
    expect(values.textContent).toContain("h = 45");
    expect(values.textContent).toContain("t = 2.02");
  });

  it("says 'per answer' instead of pinning an example's key", async () => {
    mockFetch(routes([], { [`GET ${QUEUE("i1")}`]: queue({ ...TEMPLATE, example: true }) }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const [, expected] = within(await table()).getAllByRole("row");
    expect(within(expected!).getAllByText("per answer")).toHaveLength(2);
    expect(within(expected!).queryByRole("img", { name: "Expected" })).toBeNull();
  });
});

/*
 * The round trip of ADR-044's addendum: Edit question → the editor → back
 * on the same question → Re-grade, emphasised while a newer version waits.
 */
describe("GradingPanel — edit, come back, re-grade", () => {
  const VERSIONS = `${EVAL}/items/i1/versions`;
  const version = (number: number) => ({
    number,
    publishedAt: `2026-09-0${number}T08:00:00.000Z`,
    publishedBy: null,
    changeNote: number === 2 ? "Fixed the key." : null,
    deprecatedAt: null,
    deprecationNote: null,
  });
  const expectedRow = async () => within(await table()).getAllByRole("row")[1]!;

  it("opens on the question named in ?item=, and keeps it there as the teacher moves", async () => {
    mockFetch(routes([proposal("a1", 2)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />, {
      route: "/evaluations/e1/grading?item=i2",
    });
    expect(await screen.findByRole("table", { name: "Answers to question 2" })).toBeVisible();
    await userEvent.keyboard("{ArrowLeft}");
    expect(await table()).toBeVisible();
    expect(window.location.search).toBe("?item=i1");
  });

  it("offers no Edit question to whoever may not write the pool, and a plain Re-grade while up to date", async () => {
    mockFetch(
      routes([proposal("a1", 2)], {
        [`GET ${EVAL}`]: ok(makeEvaluationDetail({ editableQuestionIds: [] })),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const expected = await expectedRow();
    expect(within(expected).getByRole("button", { name: "Re-grade" })).toBeVisible();
    expect(within(expected).queryByRole("button", { name: /newer version/ })).toBeNull();
    expect(within(expected).queryByRole("button", { name: /Edit question/ })).toBeNull();

    await userEvent.click(expected);
    const panel = await screen.findByRole("dialog", { name: "Question 1" });
    expect(within(panel).queryByRole("button", { name: /Edit question/ })).toBeNull();
  });

  it("emphasises Re-grade for a stale item, and the sheet starts on the newest version", async () => {
    const base = makeEvaluationDetail();
    mockFetch(
      routes([proposal("a1", 2)], {
        // The server's `staleItems` is the one source: no version number is compared here.
        [`GET ${EVAL}`]: ok(
          makeEvaluationDetail({
            staleItems: ["i1"],
            evaluation: { ...base.evaluation, state: "released", releasedAt: "2026-09-02T08:00:00.000Z" },
          }),
        ),
        [`GET ${VERSIONS}`]: ok({ frozenNumber: 1, versions: [version(2), version(1)] }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const regrade = within(await expectedRow()).getByRole("button", {
      name: "New version",
    });
    expect(regrade).toHaveTextContent("New version");

    await userEvent.click(regrade);
    const sheet = await screen.findByRole("dialog", { name: "Re-grade a question" });
    expect(await within(sheet).findByRole("radio", { name: /v2/ })).toBeChecked();
    // The evaluation's release reaches the sheet (its wording: RegradeSheet.test.tsx).
    expect(within(sheet).getByText("Results released")).toBeVisible();
  });

  it("is read-only for an assistant once released, saying why; the questions still walk (ADR-068 §3)", async () => {
    const base = makeEvaluationDetail();
    const released = makeEvaluationDetail({
      evaluation: { ...base.evaluation, state: "released", releasedAt: "2026-09-02T08:00:00.000Z" },
    });
    const { calls } = mockFetch(
      routes([proposal("a1", 2)], {
        [`GET ${EVAL}`]: ok(released),
        "GET /app/api/courses": ok([makeCourseSummary({ myRole: "assistant" })]),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    expect(
      await screen.findByText("The results are released: only a teacher of the course may change a grade now."),
    ).toBeVisible();
    const expected = await expectedRow();
    expect(within(expected).queryByRole("button", { name: /Re-grade/ })).toBeNull();
    expect(within(rowOf("a1")).queryByRole("button", { name: "Validate" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Validate/ })).toBeNull();
    // The primary, a labelled button beside the question bar's arrow.
    const next = screen.getAllByRole("button", { name: "Next question" }).find((b) => b.textContent?.trim() === "Next question");
    expect(next).toBeEnabled();

    await userEvent.click(rowOf("a1"));
    const panel = await screen.findByRole("dialog", { name: "Anonymous answer" });
    expect(within(panel).queryByRole("button", { name: /Adjust|Validate/ })).toBeNull();
    await userEvent.keyboard("v");
    expect(calls.some((c) => c.url.endsWith("/validate"))).toBe(false);
  });
});

describe("GradingPanel — the keyboard", () => {
  it("walks the rows with ↑ ↓, opens with Enter, validates with V and changes question with →", async () => {
    const { calls } = mockFetch(
      routes([proposal("a1", 2)], { [`POST /app/api/gradings/g-a1/validate`]: ok({}) }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    await userEvent.keyboard("{ArrowDown}");
    expect(rowOf("a1")).toHaveAttribute("aria-current", "true");
    await userEvent.keyboard("{ArrowUp}");
    expect(document.querySelector('[data-row="expected"]')).toHaveAttribute("aria-current", "true");
    await userEvent.keyboard("{ArrowDown}v");
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/gradings/g-a1/validate")).toBe(true),
    );

    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Anonymous answer" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByText("Question 2 of 2")).toBeInTheDocument();
  });

  it("ignores the keys while a field has the focus", async () => {
    const { calls } = mockFetch(routes([proposal("a1", 2)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();
    await userEvent.keyboard("{ArrowDown}a");
    const points = await screen.findByRole("spinbutton", { name: /Points/ });
    expect(points).toHaveFocus();
    await userEvent.type(screen.getByRole("textbox", { name: /Comment/ }), "v");
    expect(calls.some((c) => c.url.endsWith("/validate"))).toBe(false);
  });
});

describe("GradingPanel — adjusting an answer (F-GRADE-05)", () => {
  /** Opens the answer of `attemptId` in the panel, its adjustment form open. */
  async function adjust(attemptId: string) {
    await table();
    await userEvent.click(rowOf(attemptId));
    const panel = await screen.findByRole("dialog");
    await userEvent.click(within(panel).getByRole("button", { name: "Adjust" }));
    return panel;
  }

  it("refuses to save without a comment, and sends nothing", async () => {
    const { calls } = mockFetch(routes([validated("a1", 2)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const panel = await adjust("a1");

    await userEvent.click(within(panel).getByRole("button", { name: "Save and validate" }));
    expect(await within(panel).findByText("A comment is required.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("overrides a graded answer through its grading, points and comment", async () => {
    const { calls } = mockFetch(
      routes([validated("a1", 2)], { [`POST /app/api/gradings/g-a1/override`]: ok(makeGrading()) }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const panel = await adjust("a1");

    // One pill, the points over the item's maximum (F-PROJ-25 as amended), under a visible label.
    const points = within(panel).getByRole("spinbutton", { name: "Points", description: "points out of 2" });
    expect(points.parentElement).toHaveTextContent("/ 2");
    expect(within(panel).getByText("Points", { selector: "label" })).toBeInTheDocument();
    await userEvent.clear(points);
    await userEvent.type(points, "1.5");
    await userEvent.type(within(panel).getByRole("textbox", { name: /Comment/ }), "Half the idea.");
    await userEvent.click(within(panel).getByRole("button", { name: "Save and validate" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/app/api/gradings/g-a1/override")?.body).toEqual({
        points: 1.5,
        comment: "Half the idea.",
      }),
    );
  });

  it("grades an answer the pass never reached through the answer itself", async () => {
    const { calls } = mockFetch(
      routes([makeEntry({ attemptId: "a1", answerId: "ans-a1", grading: null })], {
        [`POST /app/api/answers/ans-a1/gradings`]: ok(makeGrading()),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const panel = await adjust("a1");

    await userEvent.type(within(panel).getByRole("textbox", { name: /Comment/ }), "Read by hand.");
    await userEvent.click(within(panel).getByRole("button", { name: "Save and validate" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/answers/ans-a1/gradings")).toBe(true),
    );
  });

  it("keeps the points within the item's range, below zero under negative marking (ADR-026)", async () => {
    const detail = makeEvaluationDetail();
    const negative = makeEvaluationDetail({
      evaluation: { ...detail.evaluation, settings: { ...detail.evaluation.settings, negativeMarking: true } },
    });
    const { calls } = mockFetch(
      routes([validated("a1", 2)], {
        [`GET ${EVAL}`]: ok(negative),
        [`POST /app/api/gradings/g-a1/override`]: ok(makeGrading()),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const panel = await adjust("a1");
    const points = within(panel).getByRole("spinbutton", { name: /Points/ });
    await userEvent.type(within(panel).getByRole("textbox", { name: /Comment/ }), "Guessed.");

    // Past the lower bound, refused and not sent.
    await userEvent.clear(points);
    await userEvent.type(points, "-3");
    await userEvent.click(within(panel).getByRole("button", { name: "Save and validate" }));
    expect(
      await within(panel).findByText("Enter a number of points between -2 and 2."),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    // Within it, a negative mark is a mark.
    await userEvent.clear(points);
    await userEvent.type(points, "-1");
    await userEvent.click(within(panel).getByRole("button", { name: "Save and validate" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/override"))?.body).toMatchObject({ points: -1 }),
    );
  });
});

describe("GradingPanel — an essay graded by criteria (ADR-118 §6)", () => {
  // The criteria come with the queue's item, from the type's `gradingCriteria`.
  const ESSAY_ITEM = {
    id: "i1",
    position: 0,
    internalName: "essay",
    type: "rich",
    points: 3,
    criteria: [
      { id: "thesis", title: "Thesis", weight: 2 },
      { id: "sources", title: "Sources", weight: 1 },
    ],
  };
  const essay = (grading: Partial<Parameters<typeof makeGrading>[0]>) =>
    makeEntry({
      attemptId: "a1",
      answer: { text: "The stack grows down." },
      student: { prompt: "Explain the stack.", format: "plain" },
      solution: {
        rubric: "",
        criteria: [
          { id: "thesis", title: "Thesis", weight: 2, prompt: "States it." },
          { id: "sources", title: "Sources", weight: 1, prompt: "" },
        ],
      },
      grading: makeGrading({ id: "g-a1", attemptId: "a1", maxPoints: 3, ...grading }),
    });
  const detail = makeEvaluationDetail();
  const essayRoutes = (entry: GradingEntry, over: Record<string, unknown> = {}) =>
    routes([entry], {
      [`GET ${EVAL}`]: ok({
        ...detail,
        items: detail.items.map((i) => (i.id === "i1" ? { ...i, type: "rich", points: 3 } : i)),
      }),
      [`GET ${QUEUE("i1")}`]: ok(makeQueue([entry], { items: [ESSAY_ITEM] })),
      ...over,
    });

  it("restarts the answer from an assistant's proposal on Edit, the points switch off: an essay graded by criteria takes none (ADR-139 §14)", async () => {
    const entry = {
      ...essay({ points: 1, state: "validated", source: "manual" }),
      contestation: {
        id: "c-a1",
        state: "open" as const,
        reason: "My thesis is stated.",
        filedAt: "2026-09-03T08:00:00.000Z",
        reply: null,
        resolvedAt: null,
        counted: true,
        proposal: { verdict: "accepted" as const, reply: "Right.", points: 3, rationale: null, accepted: null, proposedAt: "2026-09-05T10:00:00.000Z", stale: false, affected: null },
      },
    };
    mockFetch(essayRoutes(entry));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await screen.findByRole("table", { name: "Answers to question 1" });
    await userEvent.click(rowOf("a1"));
    const panel = await screen.findByRole("dialog");
    const answer = within(panel).getByRole("region", { name: "Answer to the contestation" });
    await userEvent.click(within(answer).getByRole("switch", { name: "Change the points" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
    const fresh = within(panel).getByRole("region", { name: "Answer to the contestation" });
    expect(within(fresh).getByLabelText("Reply")).toHaveValue("Right.");
    expect(within(fresh).getByRole("switch", { name: "Change the points" })).not.toBeChecked();
  });

  it("edits each criterion within its maximum, derives the total, and sends the criteria", async () => {
    const entry = essay({
      points: 2,
      state: "proposed",
      source: "llm",
      details: {
        reason: "llm",
        chars: 21,
        justification: "Fair.",
        ai: {
          model: "claude-sonnet-5-5",
          criteria: [
            { id: "thesis", criterion: "Thesis", points: 1.5, maxPoints: 2, comment: "Clear thesis." },
            { id: "sources", criterion: "Sources", points: 0.5, maxPoints: 1, comment: "One source." },
          ],
        },
      },
    });
    const { calls } = mockFetch(essayRoutes(entry, { [`POST /app/api/gradings/g-a1/override`]: ok(makeGrading()) }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await screen.findByRole("table", { name: "Answers to question 1" });
    await userEvent.click(rowOf("a1"));
    const panel = await screen.findByRole("dialog");
    await userEvent.click(within(panel).getByRole("button", { name: "Adjust" }));

    // One pill per criterion, from the proposal, bounded by its share; no total to type.
    const form = within(panel).getByRole("group", { name: "Criteria" });
    const thesis = within(form).getByRole("spinbutton", { name: "Thesis", description: "points out of 2" });
    const sources = within(form).getByRole("spinbutton", { name: "Sources", description: "points out of 1" });
    expect(thesis).toHaveValue(1.5);
    expect(within(form).getByText("Weight 2")).toBeInTheDocument();
    expect(within(form).getByText("Clear thesis.")).toBeInTheDocument();
    expect(within(panel).queryByRole("spinbutton", { name: "Points" })).toBeNull();
    const total = within(form).getByRole("status", { name: "Total" });
    expect(total).toHaveTextContent("2 / 3");

    await userEvent.clear(thesis);
    await userEvent.type(thesis, "2");
    await userEvent.clear(sources);
    await userEvent.type(sources, "1.5");
    expect(total).toHaveTextContent("3 / 3");
    await userEvent.type(within(panel).getByRole("textbox", { name: /Comment/ }), "Read again.");
    await userEvent.click(within(panel).getByRole("button", { name: "Save and validate" }));
    expect(await within(form).findByText("Between 0 and 1 points.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await userEvent.clear(sources);
    await userEvent.type(sources, "0.75");
    expect(total).toHaveTextContent("2.75 / 3");
    await userEvent.click(within(panel).getByRole("button", { name: "Save and validate" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/app/api/gradings/g-a1/override")?.body).toEqual({
        criteria: [
          { id: "thesis", points: 2 },
          { id: "sources", points: 0.75 },
        ],
        comment: "Read again.",
      }),
    );
  });

  it("shows a validated grading's points per criterion", async () => {
    const entry = essay({
      points: 2.5,
      state: "validated",
      source: "manual",
      details: {
        manual: true,
        breakdown: [
          { id: "thesis", title: "Thesis", points: 2, maxPoints: 2 },
          { id: "sources", title: "Sources", points: 0.5, maxPoints: 1 },
        ],
      },
    });
    mockFetch(essayRoutes(entry));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await screen.findByRole("table", { name: "Answers to question 1" });
    await userEvent.click(rowOf("a1"));
    const panel = await screen.findByRole("dialog");

    const lines = within(within(panel).getByRole("list", { name: "Points per criterion" })).getAllByRole("listitem");
    expect(lines.map((l) => l.textContent)).toEqual(["Thesis2 / 2", "Sources0.5 / 1"]);
  });
});

describe("GradingPanel — how a question counts (ADR-108)", () => {
  const COUNTING = `PUT ${EVAL}/items/i1/counting`;
  const base = makeEvaluationDetail();

  it("asks with the new total, then writes the choice", async () => {
    const { calls } = mockFetch(
      routes([validated("a1", 2)], {
        [COUNTING]: ok({ counting: "bonus", modifiedAfterRelease: false }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    await userEvent.click(screen.getByRole("button", { name: "How this question counts" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Count as bonus" }));
    const dialog = await screen.findByRole("dialog", { name: "Change how question 1 counts?" });
    expect(within(dialog).getByText("Total: 5 → 3 pts")).toBeInTheDocument();
    // Not released: nobody to tell.
    expect(within(dialog).queryByText(/will be notified/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Change" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ counting: "bonus" }));
  });

  it("says the students are told once released", async () => {
    mockFetch(
      routes([validated("a1", 2)], {
        [`GET ${EVAL}`]: ok({
          ...base,
          evaluation: { ...base.evaluation, state: "released", releasedAt: "2026-09-02T09:00:00.000Z" },
        }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    await userEvent.click(screen.getByRole("button", { name: "How this question counts" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Do not count" }));
    const dialog = await screen.findByRole("dialog", { name: "Change how question 1 counts?" });
    expect(within(dialog).getByText("Total: 5 → 3 pts")).toBeInTheDocument();
    expect(within(dialog).getByText(/will be notified/)).toBeInTheDocument();
  });

  it("greys out a choice that would leave nothing in the total", async () => {
    mockFetch(
      routes([validated("a1", 2)], {
        [`GET ${EVAL}`]: ok({
          ...base,
          items: base.items.map((i) => (i.id === "i2" ? { ...i, counting: "neutralized" as const } : i)),
          totalPoints: 2,
        }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    await userEvent.click(screen.getByRole("button", { name: "How this question counts" }));
    expect(await screen.findByRole("menuitem", { name: /Do not count/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /Count as bonus/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /Count normally/ })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("names a neutralized question beside its points", async () => {
    mockFetch(
      routes([validated("a1", 2)], {
        [`GET ${EVAL}`]: ok({
          ...base,
          items: base.items.map((i) => (i.id === "i1" ? { ...i, counting: "neutralized" as const } : i)),
        }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();
    expect(screen.getByText("Not counted")).toBeInTheDocument();
  });

  it("offers nothing while the item list is still editable", async () => {
    mockFetch(
      routes([validated("a1", 2)], {
        [`GET ${EVAL}`]: ok({ ...base, evaluation: { ...base.evaluation, state: "draft" }, attemptCount: 0 }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    expect(await screen.findByText(/Nobody has taken this evaluation yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "How this question counts" })).toBeNull();
  });
});

describe("GradingPanel — every answer as one file (F-EXP-01)", () => {
  const MD = `${EVAL}/items/i1/answers.md`;
  const exportable = (on: boolean) => ({
    [`GET ${QUEUE("i1")}`]: ok(
      makeQueue([validated("a1", 3)], {
        items: [{ id: "i1", position: 0, internalName: "sum", type: "code", points: 2, exportable: on }],
      }),
    ),
  });

  const PDF = `${EVAL}/items/i1/answers.pdf`;
  /** Opens the Export menu and returns its items' names. */
  const openExport = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "Export" }));
    return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
  };

  it("offers one Export menu beside the one primary action, its last item the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockFetch(routes([], { ...exportable(true), ...publicConfig(true), [`GET ${MD}`]: ok("# Answers") }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);

    await waitFor(async () => expect(await openExport()).toEqual(["Markdown", "PDF", "JSON", "Clipboard"]));
    expect(screen.getByRole("menuitem", { name: "Markdown" })).toHaveAttribute("href", MD);
    expect(screen.getByRole("menuitem", { name: "JSON" })).toHaveAttribute("href", `${EVAL}/items/i1/answers.json`);
    // No Copy button of its own beside the menu.
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Clipboard" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("# Answers")));
    expect(await screen.findByText("Answers copied")).toBeInTheDocument();
  });

  it("says so when the clipboard refuses the answers", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockFetch(routes([], { ...exportable(true), ...publicConfig(true), [`GET ${MD}`]: ok("# Answers") }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);

    await waitFor(async () => expect(await openExport()).toContain("Clipboard"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Clipboard" }));
    expect(await screen.findByText("Could not copy the answers.")).toBeInTheDocument();
  });

  it("downloads the PDF without leaving the page, and words a refusal", async () => {
    // jsdom has no object URLs: the save is observed where it hands over the blob.
    const createObjectURL = vi.fn((_blob: Blob) => "blob:pdf");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    let busy = false;
    const { calls } = mockFetch(
      routes([], {
        ...exportable(true),
        ...publicConfig(true),
        [`GET ${PDF}`]: () => (busy ? { status: 503, body: { error: "pdf_busy" } } : ok("%PDF-1.7")),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await waitFor(async () => expect(await openExport()).toContain("PDF"));
    await userEvent.click(screen.getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.url === PDF)).toHaveLength(1);

    busy = true;
    await openExport();
    await userEvent.click(screen.getByRole("menuitem", { name: "PDF" }));
    expect(await screen.findByText("Too many PDFs at once: try again in a moment.")).toBeInTheDocument();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("hides the PDF when the server makes none", async () => {
    mockFetch(routes([], { ...exportable(true), ...publicConfig(false) }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    expect(await openExport()).toEqual(["Markdown", "JSON", "Clipboard"]);
  });

  it("offers neither for a question that does not export as text", async () => {
    mockFetch(routes([], { ...exportable(false), ...publicConfig(true) }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});

describe("GradingPanel — accepting an answer (ADR-128)", () => {
  const ACCEPT = `${EVAL}/items/i1/acceptances`;
  const CLOZE_STUDENT = {
    template: "Type ⸢0⸣.",
    blanks: [
      {
        index: 0,
        weight: 1,
        kind: "select",
        options: [
          { id: 0, label: "int" },
          { id: 1, label: "invalid" },
        ],
      },
    ],
  };
  const clozeEntry = (attemptId: string, accepted: boolean) =>
    makeEntry({
      attemptId,
      answer: { blanks: ["1"] },
      student: CLOZE_STUDENT,
      solution: { blanks: [{ index: 0, expected: "int" }] },
      parts: [{ part: "b0", answer: "1", label: "invalid", right: false }],
      grading: makeGrading({
        id: `g-${attemptId}`,
        attemptId,
        points: accepted ? 2 : 0,
        state: "validated",
        confidence: null,
        details: {
          perBlank: [
            { index: 0, weight: 1, kind: "select", ok: accepted, given: "1", expected: "int", ...(accepted ? { accepted: true } : {}) },
          ],
          earned: accepted ? 1 : 0,
          total: 1,
          fraction: accepted ? 1 : 0,
        },
      }),
    });
  const detail = makeEvaluationDetail();
  const clozeDetail = {
    ...detail,
    items: detail.items.map((i) => (i.id === "i1" ? { ...i, type: "cloze" } : i)),
  };
  const queue = (accepted: boolean) =>
    makeQueue([clozeEntry("a1", accepted), clozeEntry("a2", accepted)], {
      items: [
        {
          id: "i1",
          position: 0,
          internalName: "types",
          type: "cloze",
          points: 2,
          acceptance: {
            scopes: ["everyone", "student"],
            accepted: accepted ? [{ part: "b0", answer: "1", label: "invalid", attemptId: null }] : [],
          },
        },
      ],
    });

  it("opens its card from a cell's corner without opening the row, then accepts for every such answer", async () => {
    const { calls } = mockFetch(
      routes([], {
        [`GET ${EVAL}`]: ok(clozeDetail),
        [`GET ${QUEUE("i1")}`]: ok(queue(false)),
        [`PUT ${ACCEPT}`]: ok({ accepted: true, regraded: 2, unchanged: 0, modifiedAfterRelease: false }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    await userEvent.click(within(rowOf("a1")).getByRole("button", { name: "Accept this answer" }));
    const card = await screen.findByRole("dialog", { name: "Accept an answer" });
    // The row's panel stayed shut: the card is the only layer.
    expect(screen.getAllByRole("dialog")).toEqual([card]);
    expect(within(card).getByText("Count “invalid” as right")).toBeInTheDocument();
    expect(within(card).getByText("2 answers")).toBeInTheDocument();
    expect(within(card).getByRole("radio", { name: "All these answers" })).toBeChecked();

    await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ part: "b0", answer: "1", attemptId: null }),
    );
    // Done, the card closes; a click on the row still opens its panel.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(rowOf("a2"));
    expect(await screen.findByRole("dialog", { name: "Anonymous answer" })).toBeInTheDocument();
  });

  it("marks an accepted answer, lists it beside the key, and offers to stop accepting it", async () => {
    const { calls } = mockFetch(
      routes([], {
        [`GET ${EVAL}`]: ok(clozeDetail),
        [`GET ${QUEUE("i1")}`]: ok(queue(true)),
        [`DELETE ${ACCEPT}`]: ok({ accepted: false, regraded: 2, unchanged: 0, modifiedAfterRelease: false }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    const t = await table();
    const [, expected] = within(t).getAllByRole("row");
    expect(within(expected!).getByRole("img", { name: "Accepted answer" })).toBeInTheDocument();
    // The seal after the chip is the accepted sign, and the way to stop it.
    expect(within(rowOf("a1")).queryByRole("img", { name: "Accepted" })).toBeNull();

    await userEvent.click(within(rowOf("a1")).getByRole("button", { name: "Accepted answer" }));
    const card = await screen.findByRole("dialog", { name: "Accept an answer" });
    expect(within(card).getByText("Accepted for all these answers.")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Stop accepting" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ part: "b0", answer: "1", attemptId: null }));
  });

  it("shows a refusal on the card instead of swallowing it", async () => {
    mockFetch(
      routes([], {
        [`GET ${EVAL}`]: ok(clozeDetail),
        [`GET ${QUEUE("i1")}`]: ok(queue(false)),
        [`PUT ${ACCEPT}`]: { status: 403, body: { error: "owner_required" } },
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();
    await userEvent.click(within(rowOf("a1")).getByRole("button", { name: "Accept this answer" }));
    const card = await screen.findByRole("dialog", { name: "Accept an answer" });
    await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
    expect(await within(card).findByText(/only a teacher of the course may change a grade/)).toBeInTheDocument();
  });
});

describe("GradingPanel — accepting a card of a board past eight cards (ADR-128)", () => {
  const ACCEPT = `${EVAL}/items/i1/acceptances`;
  const cards = Array.from({ length: 9 }, (_, i) => ({ id: `card${i}`, text: `card ${i}` }));
  const student = {
    prompt: "Sort.",
    columns: [
      { id: "cola", label: "A" },
      { id: "colb", label: "B" },
    ],
    cards,
    ordered: true,
  };
  const detail = makeEvaluationDetail();
  const entry = makeEntry({
    attemptId: "a1",
    answer: { columns: { cola: cards.map((c) => c.id) } },
    student,
    solution: null,
    parts: [
      { part: "card0", answer: "cola#1", label: "card 0 → A · 1", right: true },
      { part: "card8", answer: "cola#9", label: "card 8 → A · 9", right: false },
    ],
    grading: makeGrading({ id: "g-a1", attemptId: "a1", points: 0, state: "validated", confidence: null }),
  });

  it("offers the summary column's cards in the panel, for this answer only when the item says so", async () => {
    const { calls } = mockFetch(
      routes([], {
        [`GET ${EVAL}`]: ok({ ...detail, items: detail.items.map((i) => (i.id === "i1" ? { ...i, type: "categorize" } : i)) }),
        [`GET ${QUEUE("i1")}`]: ok(
          makeQueue([entry], {
            items: [
              {
                id: "i1",
                position: 0,
                internalName: "sort",
                type: "categorize",
                points: 2,
                // An ordered board: the server offers one answer only.
                acceptance: { scopes: ["student"], accepted: [] },
              },
            ],
          }),
        ),
        [`PUT ${ACCEPT}`]: ok({ accepted: true, regraded: 1, unchanged: 0, modifiedAfterRelease: false }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();
    // One summary column: no control in the table.
    expect(within(rowOf("a1")).queryByRole("button", { name: "Accept this answer" })).toBeNull();
    await userEvent.click(rowOf("a1"));
    const panel = await screen.findByRole("dialog", { name: "Anonymous answer" });
    expect(within(panel).getByText("card 8 → A · 9")).toBeInTheDocument();
    expect(within(panel).queryByText("card 0 → A · 1")).toBeNull();
    await userEvent.click(within(panel).getByRole("button", { name: "Accept this answer" }));
    const card = await screen.findByRole("dialog", { name: "Accept an answer" });
    // An ordered board: one answer only, no scope to choose.
    expect(within(card).queryByRole("radio")).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ part: "card8", answer: "cola#9", attemptId: "a1" }),
    );
  });
});

describe("GradingPanel — a teacher's own walk (ADR-018, amended 2026-11-17)", () => {
  const entries = () => [
    { ...proposal("a1", 2), staff: true, mine: true },
    { ...proposal("a2", 1), staff: true, mine: false },
    proposal("a3", 0),
  ];

  it("says You on the reader's own row, Teacher on a colleague's, and nothing on a student's", async () => {
    mockFetch(routes(entries()));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    expect(await answerRows()).toHaveLength(3);
    expect(within(rowOf("a1")).getByText("You")).toBeInTheDocument();
    expect(within(rowOf("a1")).queryByText("Teacher")).toBeNull();
    expect(within(rowOf("a2")).getByText("Teacher")).toBeInTheDocument();
    expect(within(rowOf("a2")).queryByText("You")).toBeNull();
    expect(within(rowOf("a3")).queryByText("You")).toBeNull();
    expect(within(rowOf("a3")).queryByText("Teacher")).toBeNull();
  });

  it("shows the staff rows by default; the switch hides them and the choice is remembered", async () => {
    mockFetch(routes(entries()));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    expect(await answerRows()).toHaveLength(3);
    const toggle = screen.getByRole("switch", { name: "Show test attempts" });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);
    expect(await answerRows()).toHaveLength(1);
    expect(rowOf("a1")).toBeNull();
    expect(localStorage.getItem("quiz-staff-rows-grading")).toBe("hidden");
  });

  it("counts the hidden staff proposals in the batch: the server validates them too", async () => {
    localStorage.setItem("quiz-staff-rows-grading", "hidden");
    mockFetch(routes(entries()));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    expect(await answerRows()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Validate 3/ })).toBeEnabled();
  });

  it("offers no switch while no answer is a staff one", async () => {
    mockFetch(routes([proposal("a3", 0)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    expect(screen.queryByRole("switch", { name: "Show test attempts" })).toBeNull();
  });
});

/*
 * ADR-139: the contestations of a question on its grading screen — their
 * filter, which lives in the URL, the reason folded under Anonymise, and the
 * owner's one answer; an assistant reads them.
 */
describe("GradingPanel — contestations", () => {
  const contested = (attemptId: string, state: "open" | "accepted" | "refused", points = 1) => ({
    ...validated(attemptId, points),
    contestation: {
      id: `c-${attemptId}`,
      state,
      reason: "I wrote 31.\nThe key accepts 0x1F.",
      filedAt: "2026-09-03T08:00:00.000Z",
      reply: state === "open" ? null : "Read the statement again.",
      resolvedAt: state === "open" ? null : "2026-09-04T08:00:00.000Z",
      counted: true,
      proposal: null,
    },
  });
  const entries = () => [contested("a1", "open"), contested("a2", "refused"), validated("a3", 3)];
  const withSteps = (over: Record<string, unknown> = {}) =>
    routes(entries(), {
      [`GET ${EVAL}/grading/steps`]: ok(
        makeSteps([{ key: "i1", total: 3, validated: 3, contested: 1 }, { key: "i2" }]),
      ),
      ...over,
    });
  const openAnswer = async (attemptId: string) => {
    await userEvent.click(rowOf(attemptId));
    return screen.findByRole("dialog", { name: "Anonymous answer" });
  };

  it("filters on the contested answers, in the URL, and marks the question and the rows", async () => {
    mockFetch(withSteps());
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    expect(await answerRows()).toHaveLength(3);
    // The question's open contestations, beside its state.
    expect(screen.getAllByText("1 contested").length).toBeGreaterThan(0);
    expect(within(rowOf("a1")).getByText("contested")).toBeVisible();
    expect(within(rowOf("a2")).getByText("refused")).toBeVisible();

    // The choice counts the answers it keeps, open or answered.
    await userEvent.click(screen.getByRole("radio", { name: "Contested · 2" }));
    expect(await answerRows()).toHaveLength(2);
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("contested");
    // Never the stored habit: a next visit without the link shows every answer.
    expect(localStorage.getItem(GRADING_VIEW_KEY) ?? "").not.toContain("contested");

    await userEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(await answerRows()).toHaveLength(3);
    expect(window.location.search).not.toContain("filter");
  });

  it("opens the notification's link on the first question holding an open contestation", async () => {
    mockFetch(
      routes([validated("a3", 3)], {
        [`GET ${QUEUE("i2")}`]: ok(makeQueue(entries())),
        [`GET ${EVAL}/grading/steps`]: ok(makeSteps([{ key: "i1", total: 3, validated: 3 }, { key: "i2", contested: 1 }])),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />, {
      route: "/evaluations/e1/grading?filter=contested",
    });
    const second = await screen.findByRole("table", { name: "Answers to question 2" });
    // The header and the key's row, then the two contested answers.
    await waitFor(() => expect(within(second).getAllByRole("row")).toHaveLength(4));
    expect(screen.getByRole("radio", { name: "Contested · 2" })).toBeChecked();
    expect(new URLSearchParams(window.location.search).get("item")).toBe("i2");
  });

  it("offers no contested choice on a question without a contestation", async () => {
    mockFetch(routes([validated("a3", 3)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    expect(screen.queryByRole("radio", { name: /Contested/ })).toBeNull();
  });

  it("folds the reason under Anonymise, a disclosure; the names unfold it", async () => {
    mockFetch(
      withSteps({
        [`GET ${QUEUE("i1", "0")}`]: ok(makeQueue(entries().map((e) => ({ ...e, label: `Student ${e.attemptId}` })))),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    const panel = await openAnswer("a1");
    expect(within(panel).getByText("Contestation awaiting an answer")).toBeVisible();
    expect(within(panel).queryByText(/I wrote 31/)).toBeNull();
    const show = within(panel).getByRole("button", { name: "Show the reason" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(show);
    const reason = within(panel).getByText(/I wrote 31\.\s+The key accepts 0x1F\./);
    expect(reason).toBeVisible();
    // The focus follows to what the button revealed, never to the page.
    await waitFor(() => expect(reason.parentElement).toHaveFocus());

    // With the names, the reason reads at once.
    await userEvent.click(screen.getByRole("switch", { name: "Anonymise" }));
    const named = await screen.findByRole("dialog", { name: "Student a1" });
    expect(within(named).getByText(/I wrote 31/)).toBeVisible();
    expect(within(named).queryByRole("button", { name: "Show the reason" })).toBeNull();
  });

  it("lets the owner answer once: a refusal needs a reply, an acceptance may give points", async () => {
    const { calls } = mockFetch(
      withSteps({
        "POST /app/api/contestations/c-a1/resolve": ok({
          contestation: { ...contested("a1", "accepted").contestation },
          grading: null,
          modifiedAfterRelease: false,
        }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    const panel = await openAnswer("a1");
    const answer = within(panel).getByRole("region", { name: "Answer to the contestation" });

    await userEvent.click(within(answer).getByRole("button", { name: "Refuse" }));
    // The help line turns into the error, tied to the field.
    expect(within(answer).getByLabelText("Reply")).toHaveAccessibleDescription("Required to refuse or to change the points.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    // New points: a refusal is then held, and the reply becomes the override's comment.
    await userEvent.click(within(answer).getByRole("switch", { name: "Change the points" }));
    expect(within(answer).getByRole("button", { name: "Refuse" })).toBeDisabled();
    const points = within(answer).getByLabelText("Points");
    await userEvent.clear(points);
    await userEvent.type(points, "2");
    await userEvent.type(within(answer).getByLabelText("Reply"), "Right, 0x1F is 31.");
    await userEvent.click(within(answer).getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        verdict: "accepted",
        reply: "Right, 0x1F is 31.",
        points: 2,
      }),
    );
  });

  it("shows an answered contestation's verdict and reply, with no answer to give", async () => {
    mockFetch(withSteps());
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />, {
      route: "/evaluations/e1/grading?filter=contested",
    });
    await answerRows();
    const panel = await openAnswer("a2");
    expect(within(panel).getByText("Contestation refused")).toBeVisible();
    expect(within(panel).getByText("Read the statement again.")).toBeVisible();
    expect(within(panel).queryByRole("region", { name: "Answer to the contestation" })).toBeNull();
  });

  it("lets an assistant read a contestation, never answer it", async () => {
    mockFetch(withSteps({ "GET /app/api/courses": ok([makeCourseSummary({ myRole: "assistant" })]) }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    const panel = await openAnswer("a1");
    expect(await within(panel).findByText("The answer is the course's Teacher role's.")).toBeVisible();
    expect(within(panel).queryByRole("button", { name: "Refuse" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Accept" })).toBeNull();
  });
});

/*
 * ADR-139 §14: an AI assistant's proposal on an open contestation, above the
 * owner's answer — read escaped, confirmed as it was READ, copied into the
 * answer, discarded — and the owner's batch of the question's proposals,
 * one confirmation after the other.
 */
describe("GradingPanel — an assistant's proposals", () => {
  const PROPOSED_AT = "2026-09-05T10:00:00.000Z";
  const offered = (over: Record<string, unknown> = {}) => ({
    verdict: "accepted" as const,
    reply: "<b>Right</b>, 0x1F is 31.",
    points: 3,
    rationale: null,
    accepted: null,
    proposedAt: PROPOSED_AT,
    stale: false,
    affected: null,
    ...over,
  });
  const contested = (attemptId: string, proposalOf: ReturnType<typeof offered> | null, over: Record<string, unknown> = {}) => ({
    ...validated(attemptId, 1),
    contestation: {
      id: `c-${attemptId}`,
      state: "open" as const,
      reason: "I wrote 31.",
      filedAt: "2026-09-03T08:00:00.000Z",
      reply: null,
      resolvedAt: null,
      counted: true,
      proposal: proposalOf,
      ...over,
    },
  });
  const steps = { [`GET ${EVAL}/grading/steps`]: ok(makeSteps([{ key: "i1", total: 3, validated: 3, contested: 3 }, { key: "i2" }])) };
  const openAnswer = async (attemptId: string) => {
    await userEvent.click(rowOf(attemptId));
    return screen.findByRole("dialog", { name: "Anonymous answer" });
  };
  const blockOf = (panel: HTMLElement) => within(panel).getByRole("region", { name: "AI assistant's proposal" });

  it("shows the proposal above the answer, escaped, and confirms the one it showed", async () => {
    const { calls } = mockFetch(
      routes([contested("a1", offered())], {
        ...steps,
        "POST /app/api/contestations/c-a1/proposal/confirm": ok({ contestation: contested("a1", null).contestation, grading: null, modifiedAfterRelease: false }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    // The row says an assistant prepared it.
    expect(within(rowOf("a1")).getByTestId("proposal-mark")).toBeInTheDocument();
    const block = blockOf(await openAnswer("a1"));
    expect(within(block).getByText("Acceptance proposed")).toBeVisible();
    expect(within(block).getByText(/^New points: 3 \/ /)).toBeVisible();
    // The model's text is data: drawn as written, never as markup.
    expect(within(block).getByText("<b>Right</b>, 0x1F is 31.")).toBeVisible();
    expect(block.querySelector("b")).toBeNull();
    await userEvent.click(within(block).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toMatchObject({
        url: "/app/api/contestations/c-a1/proposal/confirm",
        body: { proposedAt: PROPOSED_AT },
      }),
    );
  });

  it("never confirms a proposal a refetch brought unread: the owner reads it first", async () => {
    let entries = [contested("a1", offered())];
    const { calls } = mockFetch(
      routes(() => entries, {
        ...steps,
        "POST /app/api/contestations/c-a1/proposal/confirm": ok({ contestation: contested("a1", null).contestation, grading: null, modifiedAfterRelease: false }),
      }),
    );
    const { queryClient } = renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    const panel = await openAnswer("a1");
    // An assistant rewrites the proposal; a refetch (a window's focus, another write) brings it.
    const NEWER = "2026-09-05T11:00:00.000Z";
    entries = [contested("a1", offered({ proposedAt: NEWER, verdict: "refused", points: null, reply: "No." }))];
    await queryClient.invalidateQueries();
    expect(await within(panel).findByText("An assistant wrote this proposal while you were on this page.")).toBeVisible();
    const block = blockOf(panel);
    expect(within(block).getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(within(block).getByRole("button", { name: "I have read it" }));
    await userEvent.click(within(block).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ proposedAt: NEWER }));
  });

  it("holds Confirm on a proposal written after a discard, until the owner reads it", async () => {
    let entries = [contested("a1", offered())];
    const { calls } = mockFetch(
      routes(() => entries, {
        ...steps,
        "DELETE /app/api/contestations/c-a1/proposal": () => {
          entries = [contested("a1", null)];
          return noContent();
        },
        "POST /app/api/contestations/c-a1/proposal/confirm": ok({ contestation: contested("a1", null).contestation, grading: null, modifiedAfterRelease: false }),
      }),
    );
    const { queryClient } = renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    const panel = await openAnswer("a1");
    await userEvent.click(within(blockOf(panel)).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(within(panel).queryByRole("region", { name: "AI assistant's proposal" })).toBeNull());
    // An assistant writes another one; a refetch brings it to the same screen.
    const LATER = "2026-09-05T12:00:00.000Z";
    entries = [contested("a1", offered({ proposedAt: LATER }))];
    await queryClient.invalidateQueries();
    const block = await within(panel).findByRole("region", { name: "AI assistant's proposal" });
    expect(within(block).getByText("An assistant wrote this proposal while you were on this page.")).toBeVisible();
    expect(within(block).getByRole("button", { name: "Confirm" })).toBeDisabled();
    await userEvent.click(within(block).getByRole("button", { name: "I have read it" }));
    await userEvent.click(within(block).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ proposedAt: LATER }));
  });

  it("says an accepted answer was confirmed but the other copies not re-graded, where the answer now stands", async () => {
    const acceptance = offered({ points: null, accepted: { part: "b1", answer: "31", scope: "everyone", label: "31" }, affected: 2 });
    let entries = [contested("a1", acceptance)];
    mockFetch(
      routes(() => entries, {
        ...steps,
        "POST /app/api/contestations/c-a1/proposal/confirm": () => {
          entries = [contested("a1", null, { state: "accepted", reply: "Right.", resolvedAt: "2026-09-05T12:00:00.000Z" })];
          return fail(500, { error: "regrade_failed", message: "re-grade failed" });
        },
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    const panel = await openAnswer("a1");
    await userEvent.click(within(blockOf(panel)).getByRole("button", { name: "Confirm" }));
    // The reads come back answered; the warning stays under the record.
    expect(await within(panel).findByText("Contestation accepted")).toBeVisible();
    expect(
      within(panel).getByText(
        "Contestation accepted and the reply sent. Re-grading the other copies failed: accept the same answer again in the question's panel.",
      ),
    ).toBeVisible();
    expect(within(panel).queryByText("The answer could not be saved.")).toBeNull();
  });

  it("restarts the answer from the proposal on Edit, the verdict left to the owner", async () => {
    mockFetch(routes([contested("a1", offered())], steps));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    const panel = await openAnswer("a1");
    await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
    const answer = within(panel).getByRole("region", { name: "Answer to the contestation" });
    await waitFor(() => expect(within(answer).getByLabelText("Reply")).toHaveFocus());
    expect(within(answer).getByLabelText("Reply")).toHaveValue("<b>Right</b>, 0x1F is 31.");
    expect(within(answer).getByRole("switch", { name: "Change the points" })).toBeChecked();
    expect(within(answer).getByLabelText("Points")).toHaveValue(3);
    // The proposal stays until the answer or a discard.
    expect(blockOf(panel)).toBeVisible();
  });

  it("offers no Edit on an accepted answer, which the reply form cannot carry", async () => {
    mockFetch(
      routes([contested("a1", offered({ points: null, accepted: { part: "b1", answer: "31", scope: "everyone", label: "31" }, affected: 2 }))], steps),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    const block = blockOf(await openAnswer("a1"));
    expect(within(block).getByText("Also changes 2 other students")).toBeVisible();
    expect(within(block).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(block).getByRole("button", { name: "Confirm" })).toBeEnabled();
  });

  it("holds Confirm on a stale proposal; a refusal that says it moved words it and reads again", async () => {
    const { calls } = mockFetch(
      routes([contested("a1", offered({ stale: true })), contested("a2", offered({ verdict: "refused", points: null, reply: "No." })), contested("a3", offered())], {
        ...steps,
        "POST /app/api/contestations/c-a2/proposal/confirm": fail(409, { error: "proposal_stale", message: "stale" }),
        "POST /app/api/contestations/c-a3/proposal/confirm": fail(409, { error: "not_open", message: "answered" }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    let panel = await openAnswer("a1");
    expect(within(panel).getByText("The grading changed since this proposal. It cannot be confirmed as it stands.")).toBeVisible();
    expect(within(panel).getByRole("button", { name: "Confirm" })).toBeDisabled();
    const reads = () => calls.filter((c) => c.method === "GET" && c.url === QUEUE("i1")).length;
    for (const [attemptId, words] of [
      ["a2", "The proposal or the grading changed since you read it. Read it again."],
      ["a3", "This contestation already has its answer."],
    ] as const) {
      await userEvent.click(rowOf(attemptId));
      panel = await screen.findByRole("dialog", { name: "Anonymous answer" });
      const before = reads();
      await userEvent.click(within(panel).getByRole("button", { name: "Confirm" }));
      expect(await within(panel).findByText(words)).toBeVisible();
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
    }
  });

  it("lets an assistant of the course read and discard a proposal, never confirm it", async () => {
    const { calls } = mockFetch(
      routes([contested("a1", offered())], {
        ...steps,
        "GET /app/api/courses": ok([makeCourseSummary({ myRole: "assistant" })]),
        "DELETE /app/api/contestations/c-a1/proposal": noContent(),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await answerRows();
    const panel = await openAnswer("a1");
    const block = await within(panel).findByRole("region", { name: "AI assistant's proposal" });
    expect(within(block).queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(within(block).queryByRole("button", { name: "Edit" })).toBeNull();
    await userEvent.click(within(block).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/app/api/contestations/c-a1/proposal")).toBe(true));
    expect(await screen.findByText("Proposal discarded.")).toBeVisible();
  });

  it("confirms the question's proposals one after the other, a refusal never stopping the rest", async () => {
    const { calls } = mockFetch(
      routes(
        [
          contested("a1", offered()),
          contested("a2", offered({ verdict: "refused", points: null, reply: "No." })),
          contested("a3", offered({ points: null, accepted: { part: "b1", answer: "31", scope: "everyone", label: "31" }, affected: 2 })),
          contested("a4", offered({ stale: true })),
          // An attempt that no longer counts is answered by hand.
          contested("a5", offered(), { counted: false }),
        ],
        {
          ...steps,
          "POST /app/api/contestations/c-a1/proposal/confirm": ok({}),
          "POST /app/api/contestations/c-a2/proposal/confirm": fail(409, { error: "not_open", message: "answered" }),
          "POST /app/api/contestations/c-a3/proposal/confirm": fail(500, { error: "regrade_failed", message: "re-grade failed" }),
        },
      ),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />, { route: "/evaluations/e1/grading?filter=contested" });
    await answerRows();
    await userEvent.click(screen.getByRole("button", { name: "Confirm the proposals (3)" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm the proposals" });
    expect(within(dialog).getByText("The open contestations of question 1 that carry a proposal.")).toBeVisible();
    expect(within(dialog).getByText("2 accepted")).toBeVisible();
    expect(within(dialog).getByText("1 refused")).toBeVisible();
    expect(within(dialog).getByText("1 changes the points")).toBeVisible();
    expect(within(dialog).getByText("Also changes 2 other students")).toBeVisible();
    expect(within(dialog).getByText("1 out-of-date proposal is left out.")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm 3" }));
    const summary = await within(dialog).findByTestId("proposal-batch-summary");
    // The accepted answer whose re-grade failed is confirmed, said apart.
    expect(within(summary).getByText("2 confirmed")).toBeVisible();
    expect(within(summary).getByText("1 confirmed, other copies not re-graded")).toBeVisible();
    expect(within(summary).getByText(/Re-grading the other copies failed/)).toBeVisible();
    expect(within(summary).getByText("1 not confirmed")).toBeVisible();
    expect(within(summary).getByText(/This contestation already has its answer\./)).toBeVisible();
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([
      "/app/api/contestations/c-a1/proposal/confirm",
      "/app/api/contestations/c-a2/proposal/confirm",
      "/app/api/contestations/c-a3/proposal/confirm",
    ]);
    expect(posts.every((c) => (c.body as { proposedAt: string }).proposedAt === PROPOSED_AT)).toBe(true);
  });
});
