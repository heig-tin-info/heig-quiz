import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PoolDetail, QuestionPage } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders, type RecordedCall } from "../test/render";
import { PoolView } from "./PoolView";

/*
 * The pool screen against a stubbed API: what the table shows, what the
 * filter bar sends, the three actions each row carries, and the bulk bar
 * that only exists once something is ticked.
 *
 * A click on a row SHOWS the question (a pane beside the list on a wide
 * window, in its place on a narrow one); Enter, a double-click and the
 * pencil open the editor; Space and the row's star star it (F-POOL-10).
 *
 * The category tree is NOT part of this screen any more: it lives in the app
 * sidebar and hands its selection over through the `category` query-string
 * parameter, which the last two tests here cover from the page's side.
 */

const POOL: PoolDetail = {
  pool: {
    id: "p1",
    name: "Programmation C",
    icon: null,
    color: null,
    visibility: "private",
    ownerId: "u-me",
    isPersonal: false,
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-09-18T08:00:00.000Z",
  },
  role: "owner",
  categories: [
    {
      id: "k1",
      poolId: "p1",
      parentId: null,
      name: "Pointeurs",
      position: 0,
      children: [
        { id: "k2", poolId: "p1", parentId: "k1", name: "Arithmétique", position: 0, children: [] },
      ],
    },
  ],
  tags: ["pointeurs", "securite"],
  questionCount: 2,
};

const PAGE: QuestionPage = {
  items: [
    {
      id: "q1",
      type: "code",
      internalName: "ptr-arith-01",
      difficulty: 3,
      tags: ["pointeurs"],
      categoryId: "k2",
      latestNumber: 3,
      hasDraftChanges: true,
      keyless: false,
      review: null,
      starred: false,
      randomizable: false,
      updatedAt: "2026-09-18T08:00:00.000Z",
      deprecated: false,
      deletedAt: null,
    },
    {
      id: "q2",
      type: "mcq",
      internalName: "ptr-null-check",
      difficulty: 2,
      tags: [],
      categoryId: "k1",
      latestNumber: null,
      hasDraftChanges: true,
      keyless: false,
      review: null,
      starred: false,
      randomizable: false,
      updatedAt: "2026-09-10T08:00:00.000Z",
      deprecated: false,
      deletedAt: null,
    },
  ],
  nextCursor: null,
  total: 2,
};

/** The student view of either question, as `POST /questions/:id/preview` builds it. */
const VIEW = {
  type: "mcq",
  student: {
    prompt: "Que vaut un pointeur non initialisé ?",
    choices: [
      { id: 0, text: "NULL" },
      { id: 1, text: "Une valeur indéterminée" },
    ],
    mode: "single",
  },
  itemPoints: 2,
};

const previewCalls = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method === "POST" && c.url.endsWith("/preview"));

/** The table row that carries a question's name. */
const rowOf = (name: string) => within(screen.getByRole("table")).getByText(name).closest("tr")!;

const EMPTY_PAGE: QuestionPage = { items: [], nextCursor: null, total: 0 };

/** The caller's favourites of the pool (`pool/stars.tsx`). */
const STARRED = "GET /app/api/pools/p1/questions?starred=1&limit=200";

function routes(over: Record<string, ReturnType<typeof ok>> = {}) {
  return {
    "GET /app/api/pools/p1": ok(POOL),
    "GET /app/api/pools/p1/questions?limit=25": ok(PAGE),
    [STARRED]: ok(EMPTY_PAGE),
    ...over,
  };
}

const previews = (over: Record<string, ReturnType<typeof ok>> = {}) =>
  routes({
    "POST /app/api/questions/q1/preview": ok(VIEW),
    "POST /app/api/questions/q2/preview": ok(VIEW),
    ...over,
  });

describe("PoolView", () => {
  it("wears the pool's trail: Question pools, then the pool as the current page", async () => {
    mockFetch(routes());
    const navigate = vi.fn();
    renderWithProviders(<PoolView id="p1" navigate={navigate} />);
    const trail = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByText("Programmation C")).toHaveAttribute("aria-current", "page");
    await userEvent.click(within(trail).getByRole("link", { name: "Question pools" }));
    expect(navigate).toHaveBeenCalledWith({ view: "pools" });
  });

  it("lists the questions across the full width, without a category tree", async () => {
    mockFetch(routes());
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Programmation C" })).toBeInTheDocument();
    expect(await screen.findByText("ptr-arith-01")).toBeInTheDocument();
    expect(screen.getByText("ptr-null-check")).toBeInTheDocument();
    // The tree moved to the sidebar: the page renders none of its rows.
    expect(screen.queryByRole("button", { name: "Pointeurs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All questions" })).not.toBeInTheDocument();
    // A question with no published version reads as a draft, not as "v0".
    expect(screen.getByText("draft")).toBeInTheDocument();
    // A row with no tag shows a dash rather than an empty cell.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("reads the selected category from the query string", async () => {
    const { calls } = mockFetch(
      routes({ "GET /app/api/pools/p1/questions?categoryId=k2&limit=25": ok(PAGE) }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />, { route: "/?category=k2" });
    await screen.findByText("ptr-arith-01");
    expect(
      calls.some((c) => c.url === "/app/api/pools/p1/questions?categoryId=k2&limit=25"),
    ).toBe(true);
    // The header names the category instead of counting the whole pool.
    expect(screen.getByText("Arithmétique")).toBeInTheDocument();
  });

  it("counts the whole pool in the header when no category is selected", async () => {
    mockFetch(routes());
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    // One in the header (the pool), one above the list (the search).
    expect(screen.getAllByText("2 questions")).toHaveLength(2);
  });

  it("counts every question the search matches, not only the loaded page", async () => {
    mockFetch(
      routes({
        "GET /app/api/pools/p1/questions?limit=25": ok({ ...PAGE, nextCursor: "c2", total: 42 }),
      }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    expect(screen.getByText("42 questions")).toBeInTheDocument();
  });

  it("says one question in the singular", async () => {
    mockFetch(
      routes({
        "GET /app/api/pools/p1/questions?limit=25": ok({
          items: PAGE.items.slice(0, 1),
          nextCursor: null,
          total: 1,
        }),
      }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    expect(screen.getByText("1 question")).toBeInTheDocument();
  });

  it("sorts from the column headers only, and the cards keep that sort", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({ "GET /app/api/pools/p1/questions?sort=name&dir=asc&limit=25": ok(PAGE) }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    expect(screen.queryByRole("radiogroup", { name: "Sort by" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("?sort=name&dir=asc&limit=25"))).toBe(true),
    );
    const before = calls.length;
    await user.click(screen.getByRole("radio", { name: "Cards" }));
    await screen.findByText("ptr-arith-01");
    // Switching the view changes the drawing, not the query.
    expect(calls.slice(before).some((c) => c.url.includes("/questions?limit=25"))).toBe(false);
  });

  it("sends the search as a query parameter", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({ "GET /app/api/pools/p1/questions?q=ptr&limit=25": ok(PAGE) }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    await user.type(screen.getByLabelText("Search a question"), "ptr");
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?q=ptr&limit=25")).toBe(true),
    );
  });

  it("filters by type through the filter sheet", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({ "GET /app/api/pools/p1/questions?type=code&limit=25": ok(PAGE) }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    const sheet = await screen.findByRole("dialog");
    // The type list is a row of pressed-or-not pills, not of checkboxes.
    await user.click(within(sheet).getByRole("button", { name: "Code" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?type=code&limit=25")).toBe(
        true,
      ),
    );
  });

  it("shows the question on a row click, and opens the editor only on Enter", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(previews());
    renderWithProviders(<PoolView id="p1" navigate={navigate} />);
    // A narrow window (jsdom has no width): the preview takes the list's place.
    await user.click(await screen.findByText("ptr-arith-01"));
    expect(await screen.findByText("Que vaut un pointeur non initialisé ?")).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
    // The latest PUBLISHED version, and a word about the draft that moved since.
    expect(previewCalls(calls)).toEqual([
      expect.objectContaining({ url: "/app/api/questions/q1/preview", body: { source: 3 } }),
    ]);
    expect(screen.getByText(/Its draft has unpublished changes/)).toBeVisible();
    expect(screen.queryByText("ptr-null-check")).toBeNull();
    // The key stays with the picker and the item preview, not the pool.
    expect(screen.queryByRole("button", { name: "Show answers" })).toBeNull();

    // Back returns to the list, the focus on the row it came from.
    expect(screen.getByRole("button", { name: "Back to the list" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(rowOf("ptr-arith-01")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith({ view: "question", id: "q1" });
  });

  it("previews the draft of a question never published, and opens the editor from there", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(previews());
    renderWithProviders(<PoolView id="p1" navigate={navigate} />);
    await user.click(await screen.findByText("ptr-null-check"));
    expect(await screen.findByText("Never published — this is its draft")).toBeVisible();
    expect(previewCalls(calls)[0]).toMatchObject({ body: { source: "draft" } });
    // Same tab: the anchor keeps its href for a middle-click, a plain click navigates.
    const link = screen.getByRole("link", { name: /Open in the editor/ });
    expect(link).not.toHaveAttribute("target");
    await user.click(link);
    expect(navigate).toHaveBeenCalledWith({ view: "question", id: "q2" });
  });

  it("opens the editor on a double-click", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(previews());
    renderWithProviders(<PoolView id="p1" navigate={navigate} />);
    // Two quick clicks on the tick box are two ticks, not a way into the editor.
    await user.dblClick(await screen.findByLabelText("Select ptr-null-check"));
    expect(navigate).not.toHaveBeenCalled();
    await user.dblClick(screen.getByText("ptr-null-check"));
    expect(navigate).toHaveBeenCalledWith({ view: "question", id: "q2" });
  });

  it("stars the focused row on Space, and neither opens nor ticks it", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(previews({ "PUT /app/api/questions/star": { status: 204 } }));
    renderWithProviders(<PoolView id="p1" navigate={navigate} />);
    await screen.findByText("ptr-arith-01");
    rowOf("ptr-arith-01").focus();
    await user.keyboard(" ");
    expect(navigate).not.toHaveBeenCalled();
    expect(previewCalls(calls)).toEqual([]);
    expect(screen.getByLabelText("Select ptr-arith-01")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Star ptr-arith-01" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")).toMatchObject({
        url: "/app/api/questions/star",
        body: { questionIds: ["q1"] },
      }),
    );
    // The tick box keeps its own Space.
    screen.getByLabelText("Select ptr-arith-01").focus();
    await user.keyboard(" ");
    expect(screen.getByLabelText("Select ptr-arith-01")).toBeChecked();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("walks the rows with the arrows in the order they are drawn, and stops at the last", async () => {
    const user = userEvent.setup();
    mockFetch(previews());
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    // One row in the Tab order.
    expect(rowOf("ptr-arith-01")).toHaveAttribute("tabindex", "0");
    expect(rowOf("ptr-null-check")).toHaveAttribute("tabindex", "-1");
    rowOf("ptr-arith-01").focus();
    await user.keyboard("{ArrowDown}");
    expect(rowOf("ptr-null-check")).toHaveFocus();
    expect(rowOf("ptr-null-check")).toHaveAttribute("tabindex", "0");
    await user.keyboard("{ArrowDown}");
    expect(rowOf("ptr-null-check")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(rowOf("ptr-arith-01")).toHaveFocus();
  });

  it("walks the cards section by section, not in the order the server sent", async () => {
    const user = userEvent.setup();
    // By category, the tree's order puts Pointeurs (q2) before its child
    // Arithmétique (q1): the reverse of the page.
    localStorage.setItem("quiz-pool-view", "cards");
    localStorage.setItem("quiz-pool-group", "category");
    mockFetch(previews());
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    const cardOf = (name: string) =>
      screen.getByText(name, { selector: "span" }).closest<HTMLElement>("[tabindex]")!;
    await screen.findByText("ptr-null-check");
    expect(cardOf("ptr-null-check")).toHaveAttribute("tabindex", "0");
    cardOf("ptr-null-check").focus();
    await user.keyboard("{ArrowDown}");
    expect(cardOf("ptr-arith-01")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(cardOf("ptr-null-check")).toHaveFocus();
  });

  it("shows the focused row on P, without a pointer, where the pane takes the list's place", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(previews());
    renderWithProviders(<PoolView id="p1" navigate={navigate} />);
    await screen.findByText("ptr-arith-01");
    expect(rowOf("ptr-arith-01")).toHaveAttribute("aria-keyshortcuts", "P Enter Space");
    rowOf("ptr-arith-01").focus();
    await user.keyboard("{ArrowDown}");
    // On a narrow window the arrows only move: the pane would hide the list.
    expect(screen.queryByText("Que vaut un pointeur non initialisé ?")).toBeNull();
    await user.keyboard("p");
    expect(await screen.findByText("Never published — this is its draft")).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(rowOf("ptr-null-check")).toHaveFocus();
  });

  it("waits for a second click before a narrow window gives the list away to the pane", async () => {
    mockFetch(previews());
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByText("ptr-arith-01"));
      // Not yet: this click may be the first of a double-click.
      await act(() => vi.advanceTimersByTimeAsync(299));
      expect(screen.queryByRole("button", { name: "Back to the list" })).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByRole("button", { name: "Back to the list" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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

    it("docks the preview beside the list, follows the arrows, and closes on Escape", async () => {
      const user = userEvent.setup();
      const { calls } = mockFetch(previews());
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await screen.findByText("ptr-arith-01");
      // No empty pane before the first look.
      expect(screen.queryByRole("complementary")).toBeNull();

      await user.click(screen.getByText("ptr-arith-01"));
      const pane = await screen.findByRole("complementary", { name: "Preview ptr-arith-01" });
      expect(await within(pane).findByText("Que vaut un pointeur non initialisé ?")).toBeVisible();
      // The list stays, the row marked as the one shown.
      expect(rowOf("ptr-arith-01")).toHaveAttribute("aria-current", "true");

      await user.keyboard("{ArrowDown}");
      expect(rowOf("ptr-null-check")).toHaveFocus();
      expect(
        await screen.findByRole("complementary", { name: "Preview ptr-null-check" }),
      ).toBeVisible();
      expect(rowOf("ptr-arith-01")).not.toHaveAttribute("aria-current");
      expect(previewCalls(calls).map((c) => c.url)).toEqual([
        "/app/api/questions/q1/preview",
        "/app/api/questions/q2/preview",
      ]);

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(rowOf("ptr-null-check")).toHaveFocus();
    });

    it("opens the pane from the keyboard alone: the arrows show the row they reach", async () => {
      const user = userEvent.setup();
      mockFetch(previews());
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await screen.findByText("ptr-arith-01");
      rowOf("ptr-arith-01").focus();
      await user.keyboard("{ArrowDown}");
      expect(
        await screen.findByRole("complementary", { name: "Preview ptr-null-check" }),
      ).toBeVisible();
      expect(rowOf("ptr-null-check")).toHaveAttribute("aria-current", "true");
      await user.keyboard("{Home}");
      expect(
        await screen.findByRole("complementary", { name: "Preview ptr-arith-01" }),
      ).toBeVisible();
      // The name is announced politely as the question changes, not the body.
      const pane = screen.getByRole("complementary");
      expect(
        within(pane).getByRole("heading", { name: "ptr-arith-01" }).parentElement,
      ).toHaveAttribute("aria-live", "polite");
    });

    it("closes with its X and hands the focus back to the row", async () => {
      const user = userEvent.setup();
      mockFetch(previews());
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await user.click(await screen.findByText("ptr-arith-01"));
      await user.click(await screen.findByRole("button", { name: "Close the preview" }));
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(rowOf("ptr-arith-01")).toHaveFocus();
    });
  });

  it("carries edit, duplicate and delete on every row", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(
      routes({ "POST /app/api/questions/q1/copy": ok({ meta: { id: "q9" } }) }),
    );
    renderWithProviders(<PoolView id="p1" navigate={navigate} />);
    await screen.findByText("ptr-arith-01");
    // The pencil opens the editor, like Enter on the row.
    await user.click(screen.getByRole("button", { name: "Edit ptr-arith-01" }));
    expect(navigate).toHaveBeenCalledWith({ view: "question", id: "q1" });
    // The copy button copies, and does not navigate anywhere on its own.
    await user.click(screen.getByRole("button", { name: "Duplicate ptr-arith-01" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/questions/q1/copy")).toBe(true),
    );
  });

  it("asks before deleting a question from its row", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    await user.click(screen.getByRole("button", { name: "Delete ptr-arith-01" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("ptr-arith-01");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("shows the bulk bar once questions are ticked", async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Select ptr-arith-01"));
    expect(await screen.findByRole("region", { name: "1 selected" })).toBeInTheDocument();
  });

  it("creates a category from the move dialog and files the selection into it", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({
        "POST /app/api/pools/p1/categories": ok({
          id: "k9",
          poolId: "p1",
          parentId: null,
          name: "Tableaux",
          position: 1,
        }),
        "PATCH /app/api/questions/q1": ok({}),
      }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    await user.click(screen.getByLabelText("Select ptr-arith-01"));
    const bar = await screen.findByRole("region", { name: "1 selected" });
    await user.click(within(bar).getByRole("button", { name: "Move to a category" }));
    const dialog = await screen.findByRole("dialog");
    // The last option asks a question instead of answering one.
    await user.selectOptions(within(dialog).getByLabelText("Category"), "New category…");
    await user.type(within(dialog).getByLabelText("Category name"), "Tableaux");
    await user.click(within(dialog).getByRole("button", { name: "Move to a category" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/pools/p1/categories")).toBe(true),
    );
    expect(calls.find((c) => c.url === "/app/api/pools/p1/categories")?.body).toEqual({
      name: "Tableaux",
      parentId: null,
    });
    // ...and the questions land in the category that click just created.
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.url === "/app/api/questions/q1")).toBe(
        true,
      ),
    );
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ categoryId: "k9" });
  });

  it("reports a category that could not be created, and moves nothing", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({
        "POST /app/api/pools/p1/categories": fail(409, { message: "Name already used" }),
      }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    await user.click(screen.getByLabelText("Select ptr-arith-01"));
    const bar = await screen.findByRole("region", { name: "1 selected" });
    await user.click(within(bar).getByRole("button", { name: "Move to a category" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Category"), "New category…");
    await user.type(within(dialog).getByLabelText("Category name"), "Tableaux");
    await user.click(within(dialog).getByRole("button", { name: "Move to a category" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Name already used");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("offers the one action of an empty pool", async () => {
    mockFetch({
      "GET /app/api/pools/p1": ok({ ...POOL, questionCount: 0 }),
      "GET /app/api/pools/p1/questions?limit=25": ok(EMPTY_PAGE),
    });
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    expect(await screen.findByText("No question yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /New question/ }).length).toBeGreaterThan(0);
  });

  it("draws the statistics icon only for the questions that have statistics", async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({
        "GET /app/api/pools/p1/question-stats": ok({ items: [{ questionId: "q1", n: 24, p: 0.73, since: null }] }),
      }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    const open = await screen.findByRole("button", { name: "Statistics of ptr-arith-01" });
    expect(screen.queryByRole("button", { name: "Statistics of ptr-null-check" })).not.toBeInTheDocument();
    await user.click(open);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("73%")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Reset statistics/ })).toBeInTheDocument();
  });

  it("shows the statistics on a read-only pool too, without the reset", async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({
        "GET /app/api/pools/p1": ok({ ...POOL, role: "reader" }),
        "GET /app/api/pools/p1/question-stats": ok({ items: [{ questionId: "q2", n: 10, p: 0.5, since: null }] }),
      }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Statistics of ptr-null-check" }));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("50%")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Reset statistics/ })).not.toBeInTheDocument();
  });

  it("keeps the list when the statistics fail, without any icon", async () => {
    mockFetch(routes({ "GET /app/api/pools/p1/question-stats": fail(500) }));
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    expect(screen.queryByRole("button", { name: /^Statistics of/ })).not.toBeInTheDocument();
  });

  describe("the statistics filters (F-STAT-03)", () => {
    const STATS = {
      items: [
        {
          questionId: "q1",
          n: 24,
          p: 0.73,
          since: null,
          time: { n: 21, meanS: 95, medianS: 80, p25S: 52, p75S: 121 },
        },
      ],
    };
    const openSheet = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("button", { name: /Filters/ }));
      return screen.findByRole("dialog");
    };

    it("bounds the rate in the page, hides the questions without statistics until asked", async () => {
      const user = userEvent.setup();
      const { calls } = mockFetch(
        routes({
          "GET /app/api/pools/p1/question-stats": ok(STATS),
          "GET /app/api/pools/p1/questions?limit=200": ok(PAGE),
        }),
      );
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await screen.findByText("ptr-null-check");
      const sheet = await openSheet(user);
      await user.type(within(sheet).getByLabelText("Success rate, from"), "50");
      await user.click(within(sheet).getByRole("button", { name: "Done" }));

      await waitFor(() => expect(screen.queryByText("ptr-null-check")).not.toBeInTheDocument());
      expect(screen.getByText("ptr-arith-01")).toBeInTheDocument();
      expect(screen.getByText("1 question")).toBeInTheDocument();
      expect(screen.getByText("Success 50% and up")).toBeInTheDocument();
      // The bound never travels: the API is asked for the whole search, nothing more.
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?limit=200")).toBe(true);
      expect(calls.some((c) => /[?&](rate|time)/.test(c.url))).toBe(false);

      await user.click(within(await openSheet(user)).getByRole("switch", {
        name: "Include questions without statistics",
      }));
      expect(await screen.findByText("ptr-null-check")).toBeInTheDocument();
    });

    it("follows the cursor to the end by itself while a bound is set", async () => {
      const user = userEvent.setup();
      const [first, second] = PAGE.items;
      const { calls } = mockFetch(
        routes({
          "GET /app/api/pools/p1/question-stats": ok({
            items: [...STATS.items, { ...STATS.items[0]!, questionId: "q2", p: 0.2 }],
          }),
          "GET /app/api/pools/p1/questions?limit=200": ok({ items: [first], nextCursor: "c2", total: 2 }),
          "GET /app/api/pools/p1/questions?limit=200&cursor=c2": ok({
            items: [second],
            nextCursor: null,
            total: 2,
          }),
        }),
      );
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await screen.findByText("ptr-null-check");
      const sheet = await openSheet(user);
      await user.type(within(sheet).getByLabelText("Median time, up to"), "100");
      await user.click(within(sheet).getByRole("button", { name: "Done" }));

      // The second page arrives without a click; the count is of the rows that pass.
      await waitFor(() =>
        expect(calls.some((c) => c.url.endsWith("?limit=200&cursor=c2"))).toBe(true),
      );
      expect(await screen.findByText("ptr-null-check")).toBeInTheDocument();
      expect(screen.getByText("ptr-arith-01")).toBeInTheDocument();
      expect(screen.getAllByText("2 questions")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    });

    it("says so in the sheet when no question has statistics yet", async () => {
      const user = userEvent.setup();
      mockFetch(routes({ "GET /app/api/pools/p1/question-stats": ok({ items: [] }) }));
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await screen.findByText("ptr-arith-01");
      const sheet = await openSheet(user);
      expect(within(sheet).getByText(/No question of this pool has statistics from exams yet/)).toBeInTheDocument();
      expect(within(sheet).queryByLabelText("Success rate, from")).not.toBeInTheDocument();
    });
  });

  it("reports a failed listing with a retry", async () => {
    mockFetch({ "GET /app/api/pools/p1": ok(POOL) });
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  describe("favourites (F-POOL-10)", () => {
    const starButton = (name: string) => screen.getByRole("button", { name: `Star ${name}` });

    it("stars from the row at once, and puts the star back when the server refuses", async () => {
      const user = userEvent.setup();
      const { calls } = mockFetch(routes({ "PUT /app/api/questions/star": fail(500) }));
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await screen.findByText("ptr-arith-01");
      expect(starButton("ptr-arith-01")).toHaveAttribute("aria-pressed", "false");

      await user.click(starButton("ptr-arith-01"));
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      // Rolled back, and the list was never refetched for it.
      await waitFor(() => expect(starButton("ptr-arith-01")).toHaveAttribute("aria-pressed", "false"));
      expect(calls.filter((c) => c.url === "/app/api/pools/p1/questions?limit=25")).toHaveLength(1);
    });

    it("lets a reader star", async () => {
      const user = userEvent.setup();
      const { calls } = mockFetch(
        routes({
          "GET /app/api/pools/p1": ok({ ...POOL, role: "reader" }),
          "PUT /app/api/questions/star": { status: 204 },
        }),
      );
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await screen.findByText("ptr-arith-01");
      await user.click(starButton("ptr-null-check"));
      expect(starButton("ptr-null-check")).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    });

    it("stars the selection from the bulk bar, then offers to unstar it", async () => {
      const user = userEvent.setup();
      const { calls } = mockFetch(routes({ "PUT /app/api/questions/star": { status: 204 } }));
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await screen.findByText("ptr-arith-01");
      await user.click(screen.getByLabelText("Select ptr-arith-01"));
      await user.click(screen.getByLabelText("Select ptr-null-check"));
      const bar = await screen.findByRole("region", { name: "2 selected" });
      await user.click(within(bar).getByRole("button", { name: "Star" }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === "PUT")).toMatchObject({
          body: { questionIds: ["q1", "q2"] },
        }),
      );
      expect(within(bar).getByRole("button", { name: "Unstar" })).toBeVisible();
    });

    it("clears the caller's favourites after a confirm that counts them", async () => {
      const user = userEvent.setup();
      const starredPage: QuestionPage = {
        items: [{ ...PAGE.items[0]!, starred: true }],
        nextCursor: null,
        total: 1,
      };
      const { calls } = mockFetch(
        routes({
          "GET /app/api/pools/p1/questions?limit=25": ok({
            ...PAGE,
            items: [{ ...PAGE.items[0]!, starred: true }, PAGE.items[1]!],
          }),
          [STARRED]: ok(starredPage),
          "DELETE /app/api/pools/p1/stars": ok({ cleared: 1 }),
        }),
      );
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await user.click(await screen.findByRole("button", { name: "Clear favourites" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Remove your star from the 1 question of this pool?");
      await user.click(within(dialog).getByRole("button", { name: "Clear favourites" }));
      await waitFor(() =>
        expect(calls.some((c) => c.method === "DELETE" && c.url === "/app/api/pools/p1/stars")).toBe(
          true,
        ),
      );
      await waitFor(() => expect(starButton("ptr-arith-01")).toHaveAttribute("aria-pressed", "false"));
    });

    it("has no Clear favourites while the caller has none here", async () => {
      mockFetch(routes());
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
      await screen.findByText("ptr-arith-01");
      expect(screen.queryByRole("button", { name: "Clear favourites" })).toBeNull();
    });
  });

  describe("the Tags tab", () => {
    const USAGE = [
      { tag: "pointeurs", description: "Adresses et déréférencement", questions: 4, courses: 2 },
      { tag: "securite", description: "", questions: 1, courses: 0 },
      { tag: "structures", description: "struct et union", questions: 0, courses: 0 },
    ];
    const tagRoutes = (over: Record<string, ReturnType<typeof ok>> = {}) =>
      routes({
        "GET /app/api/pools/p1/tags/usage": ok(USAGE),
        "GET /app/api/pools/p1/questions?tag=pointeurs&limit=25": ok(PAGE),
        ...over,
      });

    it("lists every tag, most used first, and filters on the name and the description", async () => {
      const user = userEvent.setup();
      mockFetch(tagRoutes());
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />, { route: "/?tab=tags" });
      const table = await screen.findByRole("table");
      const names = within(table)
        .getAllByRole("button", { name: /^#/ })
        .map((b) => b.textContent);
      expect(names).toEqual(["#pointeurs", "#securite", "#structures"]);
      expect(within(rowOfTag("pointeurs")).getByText("4")).toBeInTheDocument();
      expect(within(rowOfTag("pointeurs")).getByText("2")).toBeInTheDocument();

      await user.type(screen.getByRole("searchbox", { name: "Filter tags" }), "union");
      expect(within(screen.getByRole("table")).getAllByRole("button", { name: /^#/ })).toHaveLength(1);
      await user.clear(screen.getByRole("searchbox", { name: "Filter tags" }));
      await user.type(screen.getByRole("searchbox", { name: "Filter tags" }), "nothing");
      expect(screen.getByText("No tag matches")).toBeInTheDocument();
    });

    it("draws the heat without the tags no question wears", async () => {
      const user = userEvent.setup();
      mockFetch(tagRoutes());
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />, { route: "/?tab=tags" });
      await screen.findByRole("table");
      await user.click(screen.getByRole("radio", { name: "Heat" }));
      expect(
        screen.getByRole("button", { name: "#pointeurs: 4 questions, 2 courses. Show its questions." }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "#securite: 1 question, 0 courses. Show its questions." })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^#structures/ })).toBeNull();
    });

    it("says so when the pool has no tag", async () => {
      mockFetch(tagRoutes({ "GET /app/api/pools/p1/tags/usage": ok([]) }));
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />, { route: "/?tab=tags" });
      expect(await screen.findByText("No tags yet")).toBeInTheDocument();
      // Nothing to filter: the field and the view switch are not drawn.
      expect(screen.queryByRole("searchbox", { name: "Filter tags" })).toBeNull();
    });

    it("offers a retry when the usage fails to load", async () => {
      mockFetch(tagRoutes({ "GET /app/api/pools/p1/tags/usage": fail(500, { error: "boom" }) }));
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />, { route: "/?tab=tags" });
      expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    it("opens the questions filtered on a tag, and clearing the chip drops ?tag", async () => {
      const user = userEvent.setup();
      const { calls } = mockFetch(tagRoutes());
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />, {
        route: "/?tab=tags&category=k2",
      });
      await screen.findByRole("table");
      await user.click(screen.getByRole("button", { name: "#pointeurs" }));
      await screen.findByText("ptr-arith-01");
      // The whole pool's questions with the tag: the category is dropped.
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?tag=pointeurs&limit=25")).toBe(
        true,
      );
      const params = new URLSearchParams(window.location.search);
      expect(params.get("tag")).toBe("pointeurs");
      expect(params.get("tab")).toBeNull();
      expect(params.get("category")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Clear filters — #pointeurs" }));
      await waitFor(() => expect(new URLSearchParams(window.location.search).get("tag")).toBeNull());
    });

    it("seeds the tag filter from ?tag on arrival", async () => {
      const { calls } = mockFetch(tagRoutes());
      renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />, { route: "/?tag=pointeurs" });
      await screen.findByText("ptr-arith-01");
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?tag=pointeurs&limit=25")).toBe(
        true,
      );
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?limit=25")).toBe(false);
    });
  });
});

/** The row of the Tags tab's table that carries a tag. */
const rowOfTag = (tag: string) =>
  within(screen.getByRole("table")).getByRole("button", { name: `#${tag}` }).closest("tr")!;
