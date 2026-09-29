import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    await userEvent.keyboard("v");
    await new Promise((r) => setTimeout(r, 50));
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

  it("opens the key from the expected row, with Re-grade and Edit question", async () => {
    const navigate = vi.fn();
    mockFetch(routes([proposal("a1", 2)]));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={navigate} />);
    const [, expected] = within(await table()).getAllByRole("row");

    await userEvent.click(expected!);
    const panel = await screen.findByRole("dialog", { name: "Question 1" });
    await userEvent.click(within(panel).getByRole("button", { name: /Edit question/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "question", id: "q1", from: "e1" });
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
