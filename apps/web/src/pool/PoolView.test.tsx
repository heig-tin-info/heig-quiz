import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolDetail, QuestionPage } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { PoolView } from "./PoolView";

/*
 * The pool screen against a stubbed API: what the table shows, what the
 * filter bar sends, and the two surfaces that only exist on demand — the
 * preview panel and the bulk bar.
 */

const POOL: PoolDetail = {
  pool: {
    id: "p1",
    name: "Programmation C",
    visibility: "private",
    ownerId: "u-me",
    isPersonal: false,
    createdAt: "2026-01-01T08:00:00.000Z",
  },
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
  it("lists the questions and the category tree", async () => {
    mockFetch(routes());
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Programmation C" })).toBeInTheDocument();
    expect(await screen.findByText("ptr-arith-01")).toBeInTheDocument();
    expect(screen.getByText("ptr-null-check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pointeurs" })).toBeInTheDocument();
    // A question with no published version reads as a draft, not as "v0".
    expect(screen.getByText("draft")).toBeInTheDocument();
    // A row with no tag shows a dash rather than an empty cell.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
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
    await user.click(within(sheet).getByLabelText("Code"));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/pools/p1/questions?type=code&limit=25")).toBe(
        true,
      ),
    );
  });

  it("opens the preview panel on the selected question", async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({
        "POST /app/api/questions/q2/preview": ok({
          student: { prompt: "Que vaut un pointeur non initialisé ?", choices: [], mode: "single" },
          itemPoints: 1,
        }),
        "GET /app/api/questions/q2": ok({
          meta: {},
          draft: {},
          versions: [],
          latestPublished: null,
        }),
      }),
    );
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await user.click(await screen.findByText("ptr-null-check"));
    const panel = await screen.findByRole("dialog");
    expect(panel).toHaveAccessibleName("ptr-null-check");
    expect(await within(panel).findByText(/pointeur non initialisé/)).toBeInTheDocument();
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
