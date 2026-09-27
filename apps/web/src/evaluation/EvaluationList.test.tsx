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

  // WP10: the second half of an evaluation's life.
  it("sends a closed one to the grading and a published one to the results", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(
      list([
        summary({ state: "closed", title: "Closed quiz", attemptCount: 12 }),
        summary({ id: id("evaluation", 2), state: "released", title: "Published quiz" }),
      ]),
    );
    renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={navigate} />);

    await user.click(await screen.findByText("Closed quiz"));
    expect(navigate).toHaveBeenLastCalledWith({ view: "grading", evaluationId: EVALUATION_ID });
    await user.click(screen.getByText("Published quiz"));
    expect(navigate).toHaveBeenLastCalledWith({
      view: "results",
      evaluationId: id("evaluation", 2),
    });
  });

  it("offers both grading destinations in a closed row's menu, and neither in a draft's", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(
      list([
        summary({ state: "closed", title: "Closed quiz" }),
        summary({ id: id("evaluation", 2), state: "draft", title: "Draft quiz" }),
      ]),
    );
    renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={navigate} />);

    await user.click(await screen.findByRole("button", { name: /Closed quiz/ }));
    expect(await screen.findByRole("menuitem", { name: "Results" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Grading" }));
    expect(navigate).toHaveBeenLastCalledWith({ view: "grading", evaluationId: EVALUATION_ID });

    await user.click(screen.getByRole("button", { name: /Draft quiz/ }));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    expect(screen.queryByRole("menuitem", { name: "Grading" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Results" })).not.toBeInTheDocument();
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

  it("stands in the server's order until a column label is clicked", async () => {
    const user = userEvent.setup();
    mockFetch(
      list([
        summary({ title: "Zebra", state: "draft" }),
        summary({ id: id("evaluation", 2), title: "Alpha", state: "closed" }),
      ]),
    );
    renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={vi.fn()} />);
    await screen.findByText("Zebra");

    // The list arrives the way the classroom works through it, and stays there.
    const titles = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
    expect(titles()[0]).toContain("Zebra");

    await user.click(screen.getByRole("button", { name: "Title" }));
    expect(titles()[0]).toContain("Alpha");
    expect(screen.getByRole("columnheader", { name: "Title" })).toHaveAttribute(
      "aria-sort",
      "ascending",
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

  // ADR-031: "Start from" exists only when the course has a template.
  describe("start from a template", () => {
    const COURSE = id("course", 1);
    const TEMPLATE = id("template", 1);
    const classroom = {
      [`GET /app/api/classrooms/${CLASSROOM}`]: ok({
        id: CLASSROOM,
        name: "A",
        period: "",
        archivedAt: null,
        course: { id: COURSE, name: "Programmation C", code: "PRG1" },
        roster: [],
      }),
    };
    const template = {
      id: TEMPLATE,
      courseId: COURSE,
      title: "Final exam",
      mode: "exam",
      revision: 2,
      itemCount: 3,
      totalPoints: 6,
      createdAt: liveAt(-3600_000),
      updatedAt: liveAt(-3600_000),
    };

    it("leaves the dialog unchanged when the course has none", async () => {
      const user = userEvent.setup();
      mockFetch({
        ...list([summary()]),
        ...classroom,
        [`GET /app/api/courses/${COURSE}/templates`]: ok([]),
      });
      renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={vi.fn()} />);
      await user.click(await screen.findByRole("button", { name: /new evaluation/i }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByLabelText("Start from")).not.toBeInTheDocument();
      expect(within(dialog).getByText("Mode")).toBeInTheDocument();
    });

    it("instantiates the chosen template and opens the new evaluation", async () => {
      const user = userEvent.setup();
      const navigate = vi.fn();
      const created = id("evaluation", 9);
      const { calls } = mockFetch({
        ...list([summary()]),
        ...classroom,
        [`GET /app/api/courses/${COURSE}/templates`]: ok([template]),
        [`POST /app/api/templates/${TEMPLATE}/instances`]: {
          status: 201,
          body: { evaluation: { id: created }, deprecatedItems: [] },
        },
      });
      renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={navigate} />);
      await user.click(await screen.findByRole("button", { name: /new evaluation/i }));
      const select = await screen.findByLabelText("Start from");
      await user.selectOptions(select, TEMPLATE);
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("textbox")).toHaveValue("Final exam");
      expect(within(dialog).queryByText("Mode")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Create evaluation" }));
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "evaluation", id: created }));
      const post = calls.find((c) => c.method === "POST");
      expect(post?.body).toEqual({ classroomId: CLASSROOM, title: "Final exam" });
    });
  });
});
