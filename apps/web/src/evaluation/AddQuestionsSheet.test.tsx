import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolSummary, QuestionPage } from "@quiz/contracts";

import { PAGE_SIZE } from "../pool/filters";
import {
  makeQueryClient,
  mockFetch,
  ok,
  type RecordedCall,
  renderWithProviders,
} from "../test/render";
import { AddQuestionsSheet } from "./AddQuestionsSheet";

/*
 * The question picker of F-EVAL-01, pinned against what it does TODAY.
 *
 * This file is the safety net the FF-07 / FF-11 clean-up needs: the filters
 * still build a query string by hand here (`?type=…&difficulty=…`) and the
 * list is still cached under its own `["pool-questions", …]` root — both are
 * a later pull request's business. The difficulty half of FF-11 is done: the
 * rows render the tested `DifficultyDots` and the type list comes from
 * `QUESTION_TYPE_IDS`. Each is asserted where a change is visible — the
 * request that leaves, the cache key that is invalidated, the text that a
 * screen reader would read — rather than through a snapshot that would only
 * say "something moved".
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

/**
 * One stubbed questions endpoint, registered under BOTH spellings of the
 * same request: the one the sheet builds by hand today, and the one with the
 * `&limit=25` that `pool/filters.ts` `questionQuery` always appends last.
 * FF-11 routes this sheet through that builder, and a route table that only
 * knew today's spelling would answer 404 the day it does — a red suite that
 * says nothing about the behaviour under test.
 */
function questions(search: string, reply: ReturnType<typeof ok>) {
  const paged = search === "" ? `?limit=${PAGE_SIZE}` : `${search}&limit=${PAGE_SIZE}`;
  return {
    [`GET /app/api/pools/p1/questions${search}`]: reply,
    [`GET /app/api/pools/p1/questions${paged}`]: reply,
  };
}

function routes(over: Record<string, ReturnType<typeof ok>> = {}) {
  return {
    "GET /app/api/pools": ok(POOLS),
    ...questions("", ok(PAGE)),
    ...over,
  };
}

/**
 * The filter parameters of the last questions request, as ordered pairs.
 *
 * Parsed rather than compared as a string, and `limit` is dropped: paging is
 * not filtering, and it is exactly the parameter FF-11 will start sending.
 * What the tests below pin is WHICH filters travel and IN WHAT ORDER — the
 * order matters because the query string is also the TanStack Query key, so
 * two spellings of one filter state are two cache entries.
 */
function lastQuestionQuery(calls: RecordedCall[]): [string, string][] {
  const call = [...calls].reverse().find((c) => c.url.includes("/questions"));
  if (call === undefined) throw new Error("no questions request was made");
  const params = new URLSearchParams(call.url.split("?")[1] ?? "");
  params.delete("limit");
  return [...params.entries()];
}

/** Every questions request so far, each as its parsed parameters. */
function questionQueries(calls: RecordedCall[]): [string, string][][] {
  return calls
    .filter((c) => c.url.includes("/questions"))
    .map((c) => {
      const params = new URLSearchParams(c.url.split("?")[1] ?? "");
      params.delete("limit");
      return [...params.entries()];
    });
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
 * "Difficulty" now names ONE thing on this screen. Before FF-11 the filter
 * and every row's bullets answered to it alike — the row borrowed
 * `t("picker.difficulty")` as its `aria-label` — and a plain `getByLabelText`
 * failed with "found multiple elements", which is the collision a
 * screen-reader user heard. `DifficultyDots` says "Difficulty 3 of 5"
 * instead, so the lookup below is unambiguous again and is what would break
 * if the clash came back.
 */
const difficultySelect = () => screen.getByLabelText("Difficulty");

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
      [`GET /app/api/pools/p2/questions?limit=${PAGE_SIZE}`]: ok(EMPTY),
    });
    await screen.findByText("ptr-arith-01");

    await user.click(within(rowOf("ptr-arith-01")).getByRole("checkbox"));
    expect(screen.getByText("1 selected")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Pool"), "p2");
    expect(await screen.findByText("Nothing matches")).toBeVisible();
    // The selection belonged to the other pool; the footer is back to its
    // disabled, unnumbered state.
    expect(screen.queryByText("1 selected")).toBeNull();
    // The POOL is in the path, so this one is matched on the path alone.
    expect(calls.some((c) => c.url.startsWith("/app/api/pools/p2/questions"))).toBe(true);
  });

  it("says so, once and without an error, when the teacher has no pool at all", async () => {
    setup({ "GET /app/api/pools": ok([]) });
    expect(await screen.findByText("No pool yet")).toBeVisible();
  });
});

describe("AddQuestionsSheet — the filters", () => {
  it("sends the type as a `type` parameter", async () => {
    const user = userEvent.setup();
    const { calls } = setup(questions("?type=code", ok(EMPTY)));
    await screen.findByText("ptr-arith-01");

    await user.selectOptions(screen.getByLabelText("Type"), "code");
    await waitFor(() => expect(lastQuestionQuery(calls)).toEqual([["type", "code"]]));
  });

  it("sends the difficulty as a `difficulty` parameter", async () => {
    const user = userEvent.setup();
    const { calls } = setup(questions("?difficulty=3", ok(EMPTY)));
    await screen.findByText("ptr-arith-01");

    await user.selectOptions(difficultySelect(), "3");
    await waitFor(() => expect(lastQuestionQuery(calls)).toEqual([["difficulty", "3"]]));
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
      ...questions("?q=ptr", ok(PAGE)),
      ...questions("?q=ptr&type=code", ok(PAGE)),
      ...questions("?q=ptr&type=code&difficulty=3", ok(PAGE)),
    });
    await screen.findByText("ptr-arith-01");

    await user.type(screen.getByLabelText("Search a question…"), "ptr");
    await user.selectOptions(screen.getByLabelText("Type"), "code");
    await user.selectOptions(difficultySelect(), "3");

    await waitFor(() =>
      expect(lastQuestionQuery(calls)).toEqual([
        ["q", "ptr"],
        ["type", "code"],
        ["difficulty", "3"],
      ]),
    );
  });

  it("asks for no filter at all when the selects are back on their any option", async () => {
    const user = userEvent.setup();
    const { calls } = setup(questions("?type=mcq", ok(PAGE)));
    await screen.findByText("ptr-arith-01");

    await user.selectOptions(screen.getByLabelText("Type"), "mcq");
    await waitFor(() => expect(lastQuestionQuery(calls)).toEqual([["type", "mcq"]]));

    await user.selectOptions(screen.getByLabelText("Type"), "");
    await waitFor(() => expect(screen.getByLabelText("Type")).toHaveValue(""));
    // No request ever carried an empty `type`: the "any" option removes the
    // parameter rather than sending it blank, which is also what keeps the
    // unfiltered list on ONE cache entry.
    expect(questionQueries(calls).flat().filter(([k, v]) => k === "type" && v === "")).toEqual([]);
  });

  /*
   * One option per REGISTERED type (FF-11: the list used to be four ids
   * written out by hand, so `circuit` was missing). Written as a subset check
   * so a sixth type does not make the safety net cry wolf — what must not
   * change is that each option's VALUE is the type id the API filters on.
   */
  it("offers one option per type, valued by the type id the API expects", async () => {
    setup();
    await screen.findByText("ptr-arith-01");
    const options = within(screen.getByLabelText("Type") as HTMLSelectElement).getAllByRole(
      "option",
    ) as HTMLOptionElement[];
    const values = options.map((o) => o.value);
    expect(values[0]).toBe("");
    expect(values).toEqual(expect.arrayContaining(["mcq", "short", "cloze", "code", "circuit"]));
    // FC-04: the label is the registry's own, so the type that used to fall
    // through the hand-written list reads as a word and not as its id.
    expect(options.find((o) => o.value === "circuit")?.textContent).toBe("Circuit");
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
   * The difficulty used to be `"●".repeat(n)` inside a span that borrowed the
   * filter's label, so every row announced itself as "Difficulty" and a
   * screen reader read three bullet characters. FF-11 puts the pool's tested
   * `DifficultyDots` here instead: five dots that are `aria-hidden`, and one
   * sentence that says which of them are filled.
   */
  it("renders the difficulty as the pool's dots, named by their value", async () => {
    setup();
    await screen.findByText("ptr-arith-01");
    expect(within(rowOf("ptr-arith-01")).getByText("Difficulty 3 of 5")).toBeInTheDocument();
    expect(within(rowOf("array-decay")).getByText("Difficulty 5 of 5")).toBeInTheDocument();
    // The bullet characters are gone, and with them the name the filter
    // and every row once shared.
    expect(rowOf("ptr-arith-01").textContent).not.toContain("\u25cf");
    expect(within(rowOf("ptr-arith-01")).queryByLabelText("Difficulty")).toBeNull();
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
