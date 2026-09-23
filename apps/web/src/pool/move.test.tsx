import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolDetail, PoolSummary, QuestionPage } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders, type RecordedCall } from "../test/render";
import { QUESTION_DRAG_MIME } from "./move";
import { PoolNavTree } from "./PoolNav";
import { PoolView } from "./PoolView";

/*
 * Moving questions to another pool (ADR-017), from both of its two gestures:
 * a drop on a pool of the sidebar, and the bulk bar's dialog. What is worth
 * asserting is the body that leaves — the server owns every rule — and the
 * one refusal the screen answers with a question rather than a message.
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
    { id: "k1", poolId: "p1", parentId: null, name: "Pointeurs", position: 0, children: [] },
  ],
  tags: [],
  questionCount: 2,
};

const TARGET: PoolDetail = {
  ...POOL,
  pool: { ...POOL.pool, id: "p2", name: "Systèmes embarqués" },
  categories: [
    { id: "k6", poolId: "p2", parentId: null, name: "Capteurs", position: 0, children: [] },
  ],
  questionCount: 4,
};

const summary = (detail: PoolDetail, role: PoolSummary["role"] = "owner"): PoolSummary => ({
  ...detail.pool,
  questionCount: detail.questionCount,
  role,
  ownerName: "Prof Démo",
  memberCount: 0,
});

const PAGE: QuestionPage = {
  items: [
    {
      id: "q1",
      type: "code",
      internalName: "ptr-arith-01",
      difficulty: 3,
      tags: [],
      categoryId: "k1",
      latestNumber: 3,
      hasDraftChanges: false,
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
      categoryId: null,
      latestNumber: null,
      hasDraftChanges: true,
      updatedAt: "2026-09-10T08:00:00.000Z",
      deprecated: false,
      deletedAt: null,
    },
  ],
  nextCursor: null,
  total: 2,
};

const moved = (questionIds: string[], targetPoolId: string, linkedCourseIds: string[] = []) =>
  ok({
    moved: questionIds.length,
    questionIds,
    targetPoolId,
    categoryId: null,
    linkedCourseIds,
  });

/** A `DataTransfer` good enough for the handlers: a type list and one string. */
function transfer(payload: unknown) {
  const data = JSON.stringify(payload);
  return {
    types: [QUESTION_DRAG_MIME],
    getData: (type: string) => (type === QUESTION_DRAG_MIME ? data : ""),
    setData: vi.fn(),
    dropEffect: "none",
    effectAllowed: "none",
  };
}

const navRoutes = (over: Record<string, ReturnType<typeof ok>> = {}) => ({
  "GET /app/api/pools": ok([summary(POOL), summary(TARGET)]),
  "GET /app/api/pools/p1": ok(POOL),
  ...over,
});

describe("dragging a question onto another pool", () => {
  it("writes the selection into the drag, not just the row under the pointer", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /app/api/pools/p1": ok(POOL),
      "GET /app/api/pools/p1/questions?limit=25": ok(PAGE),
    });
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    await user.click(screen.getByLabelText("Select ptr-arith-01"));
    await user.click(screen.getByLabelText("Select ptr-null-check"));

    const dataTransfer = transfer(null);
    fireEvent.dragStart(screen.getByText("ptr-arith-01").closest("tr")!, { dataTransfer });
    const written = dataTransfer.setData.mock.calls.find(
      ([type]) => type === QUESTION_DRAG_MIME,
    )![1] as string;
    expect(JSON.parse(written).questionIds).toEqual(["q1", "q2"]);
  });

  it("moves the dragged questions into the pool they were dropped on", async () => {
    const { calls } = mockFetch(
      navRoutes({ "POST /app/api/questions/move": moved(["q1"], "p2") }),
    );
    renderWithProviders(
      <PoolNavTree state="all" route={{ view: "pool", id: "p1" }} navigate={vi.fn()} />,
    );
    const row = await screen.findByRole("button", { name: /Systèmes embarqués/ });
    const dataTransfer = transfer({ questionIds: ["q1"], label: "ptr-arith-01" });
    fireEvent.dragEnter(row, { dataTransfer });
    fireEvent.drop(row, { dataTransfer });

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/questions/move")).toBe(true),
    );
    expect(calls.find((c) => c.url === "/app/api/questions/move")!.body).toEqual({
      questionIds: ["q1"],
      targetPoolId: "p2",
      categoryId: null,
    });
    expect(await screen.findByText(/moved to Systèmes embarqués/)).toBeInTheDocument();
  });

  it("asks before adding the pool to the course of a classroom that plays the question", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      navRoutes({
        "POST /app/api/questions/move": ((call: RecordedCall) =>
          (call.body as { linkCourses?: boolean }).linkCourses
            ? moved(["q1"], "p2", ["c1"])
            : fail(409, {
                error: "pool_not_linked",
                message: "used",
                names: [],
                courses: [
                  {
                    courseId: "c1",
                    courseName: "Programmation C",
                    courseCode: "PRG1",
                    classrooms: [{ id: "r1", name: "PRG1-2026" }],
                    mayLink: true,
                  },
                ],
              })) as never,
      }),
    );
    renderWithProviders(
      <PoolNavTree state="all" route={{ view: "pool", id: "p1" }} navigate={vi.fn()} />,
    );
    const row = await screen.findByRole("button", { name: /Systèmes embarqués/ });
    const dataTransfer = transfer({ questionIds: ["q1"], label: "ptr-arith-01" });
    fireEvent.dragEnter(row, { dataTransfer });
    fireEvent.drop(row, { dataTransfer });

    expect(await screen.findByText(/already used in PRG1-2026/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add the pool and move" }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === "/app/api/questions/move").at(-1)!.body,
      ).toMatchObject({ linkCourses: true }),
    );
  });

  it("says why when the internal name is already taken there, and retries nothing", async () => {
    const { calls } = mockFetch(
      navRoutes({
        "POST /app/api/questions/move": fail(409, {
          error: "name_taken",
          message: "taken",
          courses: [],
          names: ["ptr-arith-01"],
        }),
      }),
    );
    renderWithProviders(
      <PoolNavTree state="all" route={{ view: "pool", id: "p1" }} navigate={vi.fn()} />,
    );
    const row = await screen.findByRole("button", { name: /Systèmes embarqués/ });
    const dataTransfer = transfer({ questionIds: ["q1"], label: "ptr-arith-01" });
    fireEvent.dragEnter(row, { dataTransfer });
    fireEvent.drop(row, { dataTransfer });

    expect(
      await screen.findByText(/already has a question named ptr-arith-01/),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/app/api/questions/move")).toHaveLength(1);
  });

  it("does not accept a drop on a pool the caller only reads", async () => {
    const { calls } = mockFetch({
      "GET /app/api/pools": ok([summary(POOL), summary(TARGET, "reader")]),
      "GET /app/api/pools/p1": ok(POOL),
    });
    renderWithProviders(
      <PoolNavTree state="all" route={{ view: "pool", id: "p1" }} navigate={vi.fn()} />,
    );
    const row = await screen.findByRole("button", { name: /Systèmes embarqués/ });
    const dataTransfer = transfer({ questionIds: ["q1"], label: "ptr-arith-01" });
    fireEvent.dragEnter(row, { dataTransfer });
    fireEvent.drop(row, { dataTransfer });
    await Promise.resolve();
    expect(calls.some((c) => c.url === "/app/api/questions/move")).toBe(false);
  });
});

describe("the bulk bar's move to another pool", () => {
  it("lists the pools the teacher may write to, files into a category and moves", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /app/api/pools/p1": ok(POOL),
      "GET /app/api/pools/p1/questions?limit=25": ok(PAGE),
      "GET /app/api/pools": ok([summary(POOL), summary(TARGET)]),
      "GET /app/api/pools/p2": ok(TARGET),
      "POST /app/api/questions/move": moved(["q1", "q2"], "p2"),
    });
    renderWithProviders(<PoolView id="p1" navigate={vi.fn()} />);
    await screen.findByText("ptr-arith-01");
    await user.click(screen.getByLabelText("Select ptr-arith-01"));
    await user.click(screen.getByLabelText("Select ptr-null-check"));
    await user.click(screen.getByRole("button", { name: "Move to another pool" }));

    const dialog = within(await screen.findByRole("dialog"));
    const pool = dialog.getByLabelText("Target pool");
    // The pool being read is not one of its own targets.
    expect(within(pool as HTMLSelectElement).queryByText("Programmation C")).toBeNull();
    await user.selectOptions(pool, "p2");
    await user.selectOptions(await dialog.findByLabelText("Category"), "k6");
    await user.click(dialog.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/questions/move")).toBe(true),
    );
    expect(calls.find((c) => c.url === "/app/api/questions/move")!.body).toEqual({
      questionIds: ["q1", "q2"],
      targetPoolId: "p2",
      categoryId: "k6",
    });
  });
});
