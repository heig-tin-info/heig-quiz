import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolDetail, QuestionPage } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { PoolView } from "./PoolView";

/*
 * The pool screen against a stubbed API: what the table shows, what the
 * filter bar sends, the three actions each row carries, and the bulk bar
 * that only exists once something is ticked.
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
      updatedAt: "2026-09-10T08:00:00.000Z",
      deprecated: false,
      deletedAt: null,
    },
  ],
  nextCursor: null,
};

const EMPTY_PAGE: QuestionPage = { items: [], nextCursor: null };

function routes(over: Record<string, ReturnType<typeof ok>> = {}) {
  return {
    "GET /app/api/pools/p1": ok(POOL),
    "GET /app/api/pools/p1/questions?limit=25": ok(PAGE),
    ...over,
  };
}

describe("PoolView", () => {
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
    expect(screen.getByText("2 questions")).toBeInTheDocument();
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

  it("opens the editor when the row is clicked", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(routes());
    renderWithProviders(<PoolView id="p1" navigate={navigate} />);
    await user.click(await screen.findByText("ptr-null-check"));
    expect(navigate).toHaveBeenCalledWith({ view: "question", id: "q2" });
    // The inspection panel is gone with the click that used to open it.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("carries edit, duplicate and delete on every row", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(
      routes({ "POST /app/api/questions/q1/copy": ok({ meta: { id: "q9" } }) }),
    );
    renderWithProviders(<PoolView id="p1" navigate={navigate} />);
    await screen.findByText("ptr-arith-01");
    // The pencil opens the editor, like the row itself.
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

  it("reports a failed listing with a retry", async () => {
    mockFetch({ "GET /app/api/pools/p1": ok(POOL) });
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
