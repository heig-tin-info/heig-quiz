import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EvaluationSummary } from "@quiz/contracts";

import { EVALUATION_ID, id, liveAt } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { EvaluationList } from "./EvaluationList";

/*
 * The list on the classroom page: the badges, the one primary action, and
 * where a row click lands — the dashboard for a quiz with students in it, the
 * configuration for one that is still being written.
 */

const CLASSROOM = id("classroom", 1);

function summary(over: Partial<EvaluationSummary> = {}): EvaluationSummary {
  return {
    id: EVALUATION_ID,
    classroomId: CLASSROOM,
    title: "Quiz 3",
    mode: "exam",
    state: "draft",
    itemCount: 4,
    totalPoints: 7,
    attemptCount: 0,
    opensAt: null,
    closesAt: null,
    createdAt: liveAt(-3600_000),
    ...over,
  };
}

const list = (rows: EvaluationSummary[]) => ({
  [`GET /app/api/classrooms/${CLASSROOM}/evaluations`]: ok(rows),
});

describe("EvaluationList", () => {
  it("shows one badge per state", async () => {
    mockFetch(
      list([
        summary({ state: "draft" }),
        summary({ id: id("evaluation", 2), state: "running", title: "Quiz 4" }),
      ]),
    );
    renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={vi.fn()} />);
    expect(await screen.findByText("draft")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("opens the dashboard for a live one and the configuration for a draft", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(
      list([
        summary({ state: "draft", title: "Draft quiz" }),
        summary({ id: id("evaluation", 2), state: "running", title: "Live quiz" }),
      ]),
    );
    renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={navigate} />);

    await user.click(await screen.findByText("Draft quiz"));
    expect(navigate).toHaveBeenLastCalledWith({ view: "evaluation", id: EVALUATION_ID });
    await user.click(screen.getByText("Live quiz"));
    expect(navigate).toHaveBeenLastCalledWith({ view: "live", id: id("evaluation", 2) });
  });

  it("creates one from the empty state and goes straight to its configuration", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch({
      ...list([]),
      [`POST /app/api/classrooms/${CLASSROOM}/evaluations`]: ok(summary()),
    });
    renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={navigate} />);

    await user.click(await screen.findByRole("button", { name: /new evaluation/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/title/i), "Quiz 5");
    await user.click(within(dialog).getByRole("button", { name: /create evaluation/i }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toMatchObject({
        body: { title: "Quiz 5", mode: "exam", preset: "exam" },
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ view: "evaluation", id: EVALUATION_ID }),
    );
  });

  it("renders the empty and the failed states", async () => {
    mockFetch(list([]));
    const { unmount } = renderWithProviders(
      <EvaluationList classroomId={CLASSROOM} navigate={vi.fn()} />,
    );
    expect(await screen.findByText(/no evaluation yet/i)).toBeInTheDocument();
    unmount();

    mockFetch({});
    renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={vi.fn()} />);
    expect(await screen.findByText(/evaluation not found/i)).toBeInTheDocument();
  });
});
