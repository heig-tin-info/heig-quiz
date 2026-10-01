import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GradingEntry } from "@quiz/contracts";

import { GradingPanel } from "./GradingPanel";
import { GRADING_VIEW_KEY } from "./view";
import {
  makeEntry,
  makeEvaluationDetail,
  makeGrading,
  makeQueue,
  makeSteps,
} from "../test/grading-fixtures";
import { elapse, flowingClock } from "../test/clock";
import { mockFetch, ok, renderWithProviders } from "../test/render";

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

describe("GradingPanel — the table", () => {
  it("draws the type's columns under the key, anonymised: no Student column and no name", async () => {
    mockFetch(routes([proposal("a1", 2), validated("a2", 0)].map((e) => ({ ...e, label: null }))));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);

    const t = await table();
    const heads = within(t)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    // mcq: one column per choice, lettered canonically.
    expect(heads).toEqual(["Verdict", "A · 4", "B · 8", "Points", "Actions"]);
    // The expected row is the first one, marking the correct choice.
    const [, expected] = within(t).getAllByRole("row");
    expect(within(expected!).getByRole("img", { name: "Expected answer" })).toBeInTheDocument();
    expect(within(expected!).getByRole("img", { name: "Expected" })).toBeInTheDocument();
    expect(await answerRows()).toHaveLength(2);
    expect(screen.queryByText("Swift Otter")).toBeNull();
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
        details: { justification: "Covers the rubric." },
      }),
    });
    mockFetch(routes([ai]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await table();

    await userEvent.click(rowOf("a1"));
    const panel = await screen.findByRole("dialog", { name: "Anonymous answer" });
    expect(within(panel).getByText("The AI's justification, never shown to the student")).toBeInTheDocument();
    expect(within(panel).getByText("Covers the rubric.")).toBeInTheDocument();
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
      .map((h) => h.textContent);
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
    expect(within(sheet).getByText("The results are released")).toBeVisible();
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

    const points = within(panel).getByRole("spinbutton", { name: /Points/ });
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
