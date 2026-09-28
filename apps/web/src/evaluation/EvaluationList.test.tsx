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
    originRevision: null,
    templateRevision: null,
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

  // F-EVAL-26: the badge is the pull's door, shown only where the pull is accepted.
  describe("behind its template", () => {
    const BEHIND = { originRevision: 1, templateRevision: 3 };
    const PULL = `/app/api/evaluations/${EVALUATION_ID}/pull-template`;
    const item = (position: number, name: string, extra: Record<string, unknown> = {}) => ({
      position,
      questionId: id("question", position),
      internalName: name,
      versionNumber: 1,
      points: 2,
      milestone: false,
      ...extra,
    });
    const preview = {
      templateId: id("template", 1),
      templateTitle: "Final exam",
      from: 1,
      to: 3,
      added: [item(3, "loops")],
      removed: [item(4, "local-extra")],
      changed: [{ from: item(0, "sizeof-ptr"), to: item(0, "sizeof-ptr", { points: 3, versionNumber: 2 }) }],
      reordered: true,
      deprecatedItems: [],
      unlinkedItems: [],
    };

    it("shows the badge only on a pullable row that is behind", async () => {
      mockFetch(
        list([
          summary({ title: "Behind draft", ...BEHIND }),
          summary({ id: id("evaluation", 2), title: "Up to date", originRevision: 3, templateRevision: 3 }),
          summary({ id: id("evaluation", 3), title: "Behind but taken", attemptCount: 1, ...BEHIND }),
          summary({ id: id("evaluation", 4), title: "Behind but open", state: "lobby", ...BEHIND }),
          summary({ id: id("evaluation", 5), title: "Scheduled behind", state: "scheduled", ...BEHIND }),
        ]),
      );
      renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={vi.fn()} />);
      await screen.findByText("Behind draft");
      const badges = screen.getAllByRole("button", { name: /from its template/i });
      expect(badges.map((b) => b.getAttribute("aria-label"))).toEqual([
        "Update “Behind draft” from its template (rev. 1 → 3)",
        "Update “Scheduled behind” from its template (rev. 1 → 3)",
      ]);
      expect(badges[0]).toHaveTextContent("template rev. 1 → 3");
    });

    it("confirms with the two-way summary, pulls, and loses the badge", async () => {
      const user = userEvent.setup();
      const navigate = vi.fn();
      let pulled = false;
      const { calls } = mockFetch({
        [`GET /app/api/classrooms/${CLASSROOM}/evaluations`]: () =>
          ok([summary({ title: "Behind draft", ...BEHIND, ...(pulled ? { originRevision: 3 } : {}) })]),
        [`GET ${PULL}`]: ok(preview),
        [`POST ${PULL}`]: () => {
          pulled = true;
          return ok({ detail: {}, deprecatedItems: [] });
        },
      });
      renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={navigate} />);

      await user.click(await screen.findByRole("button", { name: /from its template/i }));
      // The badge opens the confirmation, not the evaluation.
      expect(navigate).not.toHaveBeenCalled();
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("rev. 1 → 3")).toBeInTheDocument();
      expect(within(dialog).getByText("Added (1): loops")).toBeInTheDocument();
      expect(within(dialog).getByText("Removed (1): local-extra")).toBeInTheDocument();
      expect(within(dialog).getByText("Changed (1): sizeof-ptr (v1 → v2, 2 → 3 pts)")).toBeInTheDocument();
      expect(within(dialog).getByText(/order of the questions changes/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/are replaced/i)).toBeInTheDocument();

      await user.click(within(dialog).getByRole("button", { name: "Replace questions" }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: PULL, body: { revision: 3 } }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /from its template/i })).not.toBeInTheDocument(),
      );
    });

    it("says only the revision is recorded when no question differs, and refuses an unlinked pool", async () => {
      const user = userEvent.setup();
      mockFetch({
        ...list([summary({ title: "Behind draft", ...BEHIND })]),
        [`GET ${PULL}`]: ok({
          ...preview,
          added: [],
          removed: [],
          changed: [],
          reordered: false,
          unlinkedItems: [{ position: 0, questionId: id("question", 0), internalName: "sizeof-ptr" }],
        }),
      });
      renderWithProviders(<EvaluationList classroomId={CLASSROOM} navigate={vi.fn()} />);
      await user.click(await screen.findByRole("button", { name: /from its template/i }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByText(/only the new revision is recorded/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/no longer linked to the course: sizeof-ptr/i)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Record revision" })).toBeDisabled();
    });
  });
});
