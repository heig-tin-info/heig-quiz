import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GradingPanel } from "./GradingPanel";
import { makeEntry, makeEvaluationDetail, makeGrading, makeQueue } from "./fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";

/*
 * The panel: traversal, keyboard and the one accent action.
 *
 * `v` validates and moves on, `o` opens the adjustment sheet, the arrows walk
 * the list — the three shortcuts docs/08 §8.5 promises the corrector. A batch
 * of more than ten goes through the confirmation dialog.
 */

const EVAL = "/app/api/evaluations/e1";
const QUEUE = (itemId: string) => `${EVAL}/grading?by=question&itemId=${itemId}&anonymous=1`;

const entries = [
  makeEntry({ attemptId: "a1", label: "Swift Otter" }),
  makeEntry({ attemptId: "a2", label: "Calm Ibex", grading: makeGrading({ id: "g2", attemptId: "a2" }) }),
  makeEntry({
    attemptId: "a3",
    label: "Golden Lynx",
    grading: makeGrading({ id: "g3", attemptId: "a3", state: "validated", points: 0, confidence: null }),
  }),
];

function routes(over: Record<string, unknown> = {}) {
  return {
    [`GET ${EVAL}`]: ok(makeEvaluationDetail()),
    [`GET ${QUEUE("i1")}`]: ok(makeQueue(entries)),
    [`GET ${QUEUE("i2")}`]: ok(makeQueue([])),
    [`GET ${EVAL}/grading/progress`]: ok({
      done: 6,
      total: 6,
      pending: { runner: 0, llm: 0 },
      failed: 0,
    }),
    [`GET ${EVAL}/results/by-question`]: ok([]),
    ...over,
  } as Parameters<typeof mockFetch>[0];
}

beforeEach(() => {
  // jsdom has no EventSource; `progress.ts` copes, and so must the test.
  vi.stubGlobal("EventSource", undefined);
});

describe("GradingPanel", () => {
  it("opens on the first question with the proposals first and the first one expanded", async () => {
    mockFetch(routes());
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Grading" })).toBeVisible();
    expect(screen.getByText("Question 1 of 2")).toBeVisible();
    // `findAll`, not `getAll`: the heading and the step counter come from the
    // EVALUATION query, the rows from the separate grading one. On a loaded
    // runner the second lands a tick later, and a synchronous read here saw
    // an empty list about one run in thirty.
    const rows = await screen.findAllByRole("button", { name: /Open the answer of/ });
    // The validated one sits last: proposals are what the teacher came for.
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Open the answer of Swift Otter",
      "Open the answer of Calm Ibex",
      "Open the answer of Golden Lynx",
    ]);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Open the answer of/ })[0]).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
  });

  it("walks the questions from the header", async () => {
    mockFetch(routes());
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await screen.findByText("Question 1 of 2");
    await userEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(await screen.findByText("Question 2 of 2")).toBeVisible();
    expect(await screen.findByText("Nothing left to grade")).toBeVisible();
  });

  it("validates and advances on `v`", async () => {
    const { calls } = mockFetch(routes({ [`POST /app/api/gradings/g1/validate`]: ok(makeGrading()) }));
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    // The rows, not just the step counter: `v` acts on the OPEN entry, and
    // the entries come from the grading query.
    await screen.findAllByRole("button", { name: /Open the answer of/ });

    await userEvent.keyboard("v");
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/gradings/g1/validate")).toBe(true),
    );
    const rows = await screen.findAllByRole("button", { name: /Open the answer of/ });
    expect(rows[0]).toHaveAttribute("aria-expanded", "false");
    expect(rows[1]).toHaveAttribute("aria-expanded", "true");
  });

  it("moves between answers with the arrows without grading anything", async () => {
    const { calls } = mockFetch(routes());
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    // The arrows walk the entries, so they must exist before the keystrokes.
    await screen.findAllByRole("button", { name: /Open the answer of/ });

    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    let rows = await screen.findAllByRole("button", { name: /Open the answer of/ });
    expect(rows[2]).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{ArrowLeft}");
    rows = await screen.findAllByRole("button", { name: /Open the answer of/ });
    expect(rows[1]).toHaveAttribute("aria-expanded", "true");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("opens the adjustment sheet on `o`", async () => {
    mockFetch(routes());
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    // `o` adjusts the OPEN entry, so wait for the entries and not the counter.
    await screen.findAllByRole("button", { name: /Open the answer of/ });

    await userEvent.keyboard("o");
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Adjust this grading");
  });

  it("validates a batch of more than ten behind a confirmation", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      makeEntry({ attemptId: `a${i}`, label: `Student ${i}`, grading: makeGrading({ id: `g${i}` }) }),
    );
    const { calls } = mockFetch(
      routes({
        [`GET ${QUEUE("i1")}`]: ok(makeQueue(many)),
        [`POST ${EVAL}/grading/validate-batch`]: ok({ validated: 12 }),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Validate 12 proposals" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Validate 12 proposals?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Validate them" }));

    await waitFor(() => {
      const call = calls.find((c) => c.url === `${EVAL}/grading/validate-batch`);
      expect(call?.body).toEqual({ itemId: "i1", state: "proposed" });
    });
  });

  it("validates a small batch with no dialog at all", async () => {
    const { calls } = mockFetch(
      routes({ [`POST ${EVAL}/grading/validate-batch`]: ok({ validated: 2 }) }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Validate 2 proposals" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `${EVAL}/grading/validate-batch`)).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks the server again for the names instead of unmasking what it holds", async () => {
    const { calls } = mockFetch(
      routes({
        [`GET ${EVAL}/grading?by=question&itemId=i1&anonymous=0`]: ok(
          makeQueue([makeEntry({ label: "Marie Rochat" })]),
        ),
      }),
    );
    renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
    await screen.findByText("Question 1 of 2");
    await userEvent.click(screen.getByRole("switch", { name: "Show names" }));
    expect(await screen.findByText("Marie Rochat")).toBeVisible();
    expect(calls.some((c) => c.url.includes("anonymous=0"))).toBe(true);
  });
});
