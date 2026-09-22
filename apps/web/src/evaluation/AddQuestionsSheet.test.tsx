import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolSummary, QuestionPage } from "@quiz/contracts";

import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { AddQuestionsSheet } from "./AddQuestionsSheet";

/*
 * The question picker of F-EVAL-01, pinned against what it does TODAY.
 *
 * This file is the safety net the FF-07 / FF-11 clean-up needs: the filters
 * build a query string by hand here (`?type=…&difficulty=…`), the list is
 * cached under its own `["pool-questions", …]` root, and the difficulty is a
 * run of `●` rather than the tested `DifficultyDots`. All three are things
 * the refactoring means to change, so each is asserted where a change is
 * visible — the request that leaves, the cache key that is invalidated, the
 * text that a screen reader would read — rather than through a snapshot that
 * would only say "something moved".
 */

const POOLS: PoolSummary[] = [
  {
    id: "p1",
    name: "Programmation C",
    icon: null,
    visibility: "private",
    ownerId: "u-me",
    isPersonal: false,
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-09-18T08:00:00.000Z",
    questionCount: 3,
    role: "owner",
    ownerName: "Marie Dupont",
    memberCount: 0,
  },
  {
    id: "p2",
    name: "Systèmes embarqués",
    icon: null,
    visibility: "shared",
    ownerId: "u-me",
    isPersonal: false,
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-09-18T08:00:00.000Z",
    questionCount: 1,
    role: "contributor",
    ownerName: "Marie Dupont",
    memberCount: 2,
  },
];

const row = (over: Partial<QuestionPage["items"][number]>): QuestionPage["items"][number] => ({
  id: "q1",
  type: "mcq",
  internalName: "ptr-null-check",
  difficulty: 2,
  tags: [],
  categoryId: null,
  latestNumber: 1,
  hasDraftChanges: false,
  updatedAt: "2026-09-18T08:00:00.000Z",
  deprecated: false,
  deletedAt: null,
  ...over,
});

/** Three questions: one addable, one never published, one already deprecated. */
const PAGE: QuestionPage = {
  items: [
    row({ id: "q1", type: "code", internalName: "ptr-arith-01", difficulty: 3 }),
    row({ id: "q2", internalName: "ptr-null-check", difficulty: 1, latestNumber: null }),
    row({ id: "q3", type: "short", internalName: "array-decay", difficulty: 5, deprecated: true }),
  ],
  nextCursor: null,
};

const EMPTY: QuestionPage = { items: [], nextCursor: null };

const QUESTIONS = (search = "") => `GET /app/api/pools/p1/questions${search}`;

function routes(over: Record<string, ReturnType<typeof ok>> = {}) {
  return {
    "GET /app/api/pools": ok(POOLS),
    [QUESTIONS()]: ok(PAGE),
    ...over,
  };
}

function setup(
  over: Record<string, ReturnType<typeof ok>> = {},
  options: { existing?: Set<string>; onClose?: () => void } = {},
) {
  const queryClient = makeQueryClient();
  const onClose = options.onClose ?? vi.fn();
  const stubs = mockFetch(routes(over));
  const rendered = renderWithProviders(
    <AddQuestionsSheet
      evaluationId="e1"
      existing={options.existing ?? new Set()}
      onClose={onClose}
    />,
    { queryClient },
  );
  return { ...rendered, ...stubs, onClose, queryClient };
}

/** The `<li>` of one question, found by the internal name it prints. */
const rowOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

/*
 * The filter and every row's bullets answer to the same accessible name
 * today (FF-11: the row reuses `t("picker.difficulty")` as its `aria-label`),
 * so the select has to be asked for by ROLE. Reaching for it by label alone
 * fails with "found multiple elements" — which is exactly the collision a
 * screen-reader user hears, and the reason this helper exists rather than a
 * bare `getByLabelText`.
 */
const difficultySelect = () => screen.getByRole("combobox", { name: "Difficulty" });

describe("AddQuestionsSheet — the pool", () => {
  it("opens on the first pool and lists its questions", async () => {
    setup();
    expect(await screen.findByText("ptr-arith-01")).toBeVisible();
    expect(screen.getByLabelText("Pool")).toHaveValue("p1");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("switches pool, refetches, and drops what was ticked in the old one", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      "GET /app/api/pools/p2/questions": ok(EMPTY),
    });
    await screen.findByText("ptr-arith-01");

    await user.click(within(rowOf("ptr-arith-01")).getByRole("checkbox"));
    expect(screen.getByText("1 selected")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Pool"), "p2");
    expect(await screen.findByText("Nothing matches")).toBeVisible();
    // The selection belonged to the other pool; the footer is back to its
    // disabled, unnumbered state.
    expect(screen.queryByText("1 selected")).toBeNull();
    expect(calls.some((c) => c.url === "/app/api/pools/p2/questions")).toBe(true);
  });

  it("says so, once and without an error, when the teacher has no pool at all", async () => {
    setup({ "GET /app/api/pools": ok([]) });
    expect(await screen.findByText("No pool yet")).toBeVisible();
  });
});

describe("AddQuestionsSheet — the filters", () => {
  it("sends the type as `?type=`", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ [QUESTIONS("?type=code")]: ok(EMPTY) });
    await screen.findByText("ptr-arith-01");

    await user.selectOptions(screen.getByLabelText("Type"), "code");
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?type=code")).toBe(true),
    );
  });

  it("sends the difficulty as `?difficulty=`", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ [QUESTIONS("?difficulty=3")]: ok(EMPTY) });
    await screen.findByText("ptr-arith-01");

    await user.selectOptions(difficultySelect(), "3");
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?difficulty=3")).toBe(true),
    );
  });

  /*
   * The ORDER of the parameters is part of what is pinned: the query string
   * is also the cache key (`["pool-questions", poolId, search]`), so a
   * reordering is a cache miss, not a cosmetic change. FF-11 replaces this
   * hand-rolled builder with `pool/filters.ts`; this is the expectation that
   * has to keep holding afterwards.
   */
  it("combines the search, the type and the difficulty in that order", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      [QUESTIONS("?q=ptr")]: ok(PAGE),
      [QUESTIONS("?q=ptr&type=code")]: ok(PAGE),
      [QUESTIONS("?q=ptr&type=code&difficulty=3")]: ok(PAGE),
    });
    await screen.findByText("ptr-arith-01");

    await user.type(screen.getByLabelText("Search a question…"), "ptr");
    await user.selectOptions(screen.getByLabelText("Type"), "code");
    await user.selectOptions(difficultySelect(), "3");

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === "/app/api/pools/p1/questions?q=ptr&type=code&difficulty=3"),
      ).toBe(true),
    );
  });

  it("asks for no filter at all when both selects are back on their any option", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ [QUESTIONS("?type=mcq")]: ok(PAGE) });
    await screen.findByText("ptr-arith-01");

    await user.selectOptions(screen.getByLabelText("Type"), "mcq");
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?type=mcq")).toBe(true),
    );
    await user.selectOptions(screen.getByLabelText("Type"), "");
    // Back to the bare path, not `?type=`.
    await waitFor(() => expect(screen.getByLabelText("Type")).toHaveValue(""));
    expect(calls.some((c) => c.url.endsWith("questions?type="))).toBe(false);
  });

  /*
   * The four MVP type ids the sheet hard-codes today (FF-11: `circuit` is
   * missing from this list while it is a registered question type). Written
   * as a subset check so adding the fifth one does not make the safety net
   * cry wolf — what must not change is that each option's VALUE is the type
   * id the API filters on.
   */
  it("offers one option per type, valued by the type id the API expects", async () => {
    setup();
    await screen.findByText("ptr-arith-01");
    const values = within(screen.getByLabelText("Type") as HTMLSelectElement)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(values[0]).toBe("");
    expect(values).toEqual(expect.arrayContaining(["mcq", "short", "cloze", "code"]));
  });
});

describe("AddQuestionsSheet — the rows", () => {
  it("shows a question with no published version, ticked out of reach", async () => {
    setup();
    await screen.findByText("ptr-arith-01");
    const unpublished = within(rowOf("ptr-null-check")).getByRole("checkbox");
    expect(unpublished).toBeDisabled();
    expect(within(rowOf("ptr-null-check")).getByText("draft only")).toBeVisible();
    // The published one next to it is not.
    expect(within(rowOf("ptr-arith-01")).getByRole("checkbox")).toBeEnabled();
  });

  it("shows a question already in the evaluation as ticked and disabled", async () => {
    setup({}, { existing: new Set(["q1"]) });
    await screen.findByText("ptr-arith-01");
    const already = within(rowOf("ptr-arith-01")).getByRole("checkbox");
    expect(already).toBeChecked();
    expect(already).toBeDisabled();
  });

  it("flags a deprecated question", async () => {
    setup();
    await screen.findByText("array-decay");
    expect(within(rowOf("array-decay")).getByText("deprecated")).toBeVisible();
  });

  /*
   * Today the difficulty is `"●".repeat(n)` inside a span that borrows the
   * filter's label — so every row announces itself as "Difficulty" and a
   * screen reader reads three bullet characters. FF-11 replaces it with the
   * tested `DifficultyDots`; this test is what says out loud what the fix
   * changes.
   */
  it("renders the difficulty as a run of bullets under the filter's own label", async () => {
    setup();
    await screen.findByText("ptr-arith-01");
    const dots = within(rowOf("ptr-arith-01")).getByLabelText("Difficulty");
    expect(dots).toHaveTextContent("●●●");
    expect(within(rowOf("array-decay")).getByLabelText("Difficulty")).toHaveTextContent("●●●●●");
  });
});

describe("AddQuestionsSheet — adding", () => {
  it("keeps the action disabled until something is ticked, then counts it", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("ptr-arith-01");
    expect(screen.getByRole("button", { name: "Add questions" })).toBeDisabled();

    await user.click(within(rowOf("ptr-arith-01")).getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Add 1 question" })).toBeEnabled();

    await user.click(within(rowOf("array-decay")).getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Add 2 questions" })).toBeEnabled();
    expect(screen.getByText("2 selected")).toBeVisible();
  });

  it("posts the ticked ids in the order they were ticked, invalidates the evaluation and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { calls, queryClient } = setup(
      { "POST /app/api/evaluations/e1/items": ok({}) },
      { onClose },
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await screen.findByText("ptr-arith-01");

    await user.click(within(rowOf("array-decay")).getByRole("checkbox"));
    await user.click(within(rowOf("ptr-arith-01")).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Add 2 questions" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({
      url: "/app/api/evaluations/e1/items",
      body: { questionIds: ["q3", "q1"] },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["evaluation", "e1"] });
  });

  it("unticks what was ticked", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("ptr-arith-01");
    const box = within(rowOf("ptr-arith-01")).getByRole("checkbox");
    await user.click(box);
    await user.click(box);
    expect(screen.getByRole("button", { name: "Add questions" })).toBeDisabled();
  });

  it("keeps the sheet open and shows the server's message when the add fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    setup(
      {
        "POST /app/api/evaluations/e1/items": {
          status: 422,
          body: { message: "This question has no published version." },
        },
      },
      { onClose },
    );
    await screen.findByText("ptr-arith-01");
    await user.click(within(rowOf("ptr-arith-01")).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Add 1 question" }));

    expect(await screen.findByText("This question has no published version.")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });
});
