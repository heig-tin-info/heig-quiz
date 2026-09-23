import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolCategories, PoolDetail } from "@quiz/contracts";

import { mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { CategoriesPage } from "./CategoriesPage";

/*
 * The categories page of a pool against a stubbed API: the tree with its
 * counts, rename in place, the keyboard moves, delete, and a reader's page
 * that shows the same tree and offers none of it.
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
  categories: [],
  tags: [],
  questionCount: 6,
};

const node = (
  id: string,
  parentId: string | null,
  name: string,
  position: number,
  questionCount: number,
  children: PoolCategories["categories"] = [],
) => ({
  id,
  poolId: "p1",
  parentId,
  name,
  position,
  questionCount,
  children,
});

const TREE: PoolCategories = {
  categories: [
    node("k1", null, "Pointeurs", 0, 1, [node("k2", "k1", "Arithmétique", 0, 2)]),
    node("k3", null, "Numération et codage des entiers", 1, 0),
  ],
  rootQuestionCount: 3,
};

function routes(over: Record<string, ReturnType<typeof ok>> = {}) {
  return {
    "GET /app/api/pools/p1": ok(POOL),
    "GET /app/api/pools/p1/categories": ok(TREE),
    ...over,
  };
}

describe("CategoriesPage", () => {
  it("draws the tree with each category's question count, and the root's", async () => {
    mockFetch(routes());
    renderWithProviders(<CategoriesPage id="p1" navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Categories" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Rename Pointeurs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename Arithmétique" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show the questions of Arithmétique" }),
    ).toHaveTextContent("2");
    // An empty folder is not a link to an empty list.
    expect(
      screen.queryByRole("button", {
        name: "Show the questions of Numération et codage des entiers",
      }),
    ).toBeNull();
    expect(screen.getByText("Without a category").parentElement).toHaveTextContent("3");
    expect(screen.getByText("3 categories · 6 questions")).toBeInTheDocument();
    // The one primary action.
    expect(screen.getByRole("button", { name: /New category/ })).toBeInTheDocument();
  });

  it("opens the question list filtered on a category from its count", async () => {
    mockFetch(routes());
    const navigate = vi.fn();
    renderWithProviders(<CategoriesPage id="p1" navigate={navigate} />, {
      route: "/pools/p1/categories",
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Show the questions of Arithmétique" }),
    );
    expect(navigate).toHaveBeenCalledWith({ view: "pool", id: "p1" });
    expect(new URLSearchParams(window.location.search).get("category")).toBe("k2");
  });

  it("renames in place: Enter saves once, Escape cancels", async () => {
    const { calls } = mockFetch(routes({ "PATCH /app/api/categories/k1": ok({}) }));
    renderWithProviders(<CategoriesPage id="p1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Rename Pointeurs" }));
    const input = screen.getByRole("textbox", { name: "Category name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Pointeurs et adresses{Enter}");
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH")).toEqual([
        expect.objectContaining({
          url: "/app/api/categories/k1",
          body: { name: "Pointeurs et adresses" },
        }),
      ]),
    );

    await userEvent.click(screen.getByRole("button", { name: "Rename Arithmétique" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Category name" }), "x{Escape}");
    expect(screen.queryByRole("textbox", { name: "Category name" })).toBeNull();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("moves with the keyboard: Alt+↓ reorders among the siblings", async () => {
    const { calls } = mockFetch(routes({ "PUT /app/api/pools/p1/categories/order": ok([]) }));
    renderWithProviders(<CategoriesPage id="p1" navigate={vi.fn()} />);
    const pointeurs = await screen.findByRole("button", { name: "Rename Pointeurs" });
    fireEvent.keyDown(pointeurs, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      items: [
        { id: "k3", parentId: null, position: 0 },
        { id: "k1", parentId: null, position: 1 },
      ],
    });
  });

  it("files a folder into the one above from its menu", async () => {
    const { calls } = mockFetch(routes({ "PUT /app/api/pools/p1/categories/order": ok([]) }));
    renderWithProviders(<CategoriesPage id="p1" navigate={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for Numération et codage des entiers" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Move into Pointeurs" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      items: [
        { id: "k2", parentId: "k1", position: 0 },
        { id: "k3", parentId: "k1", position: 1 },
        // The list it left, renumbered too.
        { id: "k1", parentId: null, position: 0 },
      ],
    });
  });

  it("deletes after a confirmation that counts what goes back to the root", async () => {
    const { calls } = mockFetch(routes({ "DELETE /app/api/categories/k1": noContent() }));
    renderWithProviders(<CategoriesPage id="p1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Pointeurs" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete category" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete “Pointeurs” and its subcategory?");
    expect(dialog).toHaveTextContent("(3)");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("shows a reader the tree and nothing to change it with", async () => {
    mockFetch(routes({ "GET /app/api/pools/p1": ok({ ...POOL, role: "reader" }) }));
    renderWithProviders(<CategoriesPage id="p1" navigate={vi.fn()} />);
    expect(await screen.findByText("Pointeurs")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Rename|Actions for|New category/ })).toBeNull();
  });

  it("offers the first category from an empty state", async () => {
    mockFetch(
      routes({ "GET /app/api/pools/p1/categories": ok({ categories: [], rootQuestionCount: 6 }) }),
    );
    renderWithProviders(<CategoriesPage id="p1" navigate={vi.fn()} />);
    expect(await screen.findByText("No categories yet")).toBeInTheDocument();
    // One "New category", in the empty state, not a second one in the header.
    expect(screen.getAllByRole("button", { name: /New category/ })).toHaveLength(1);
  });
});
