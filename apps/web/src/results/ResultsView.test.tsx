import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeClassroomDetail, makeCourseSummary } from "../test/fixtures";
import { makeEvaluationDetail, makeFeedback, makeResultsView } from "../test/grading-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { ResultsView } from "./ResultsView";

/*
 * The grade table, the export and the publication.
 *
 * The absent student is in the table AND in the statistics: a class average
 * computed on the students who showed up is a flattering fiction
 * (deviation W6-10).
 */

const VIEW = "/app/api/evaluations/e1/results";

/** The grade table is the last one: the histogram publishes a hidden one too. */
const names = () =>
  within(screen.getAllByRole("table").at(-1)!)
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]?.textContent);

describe("ResultsView", () => {
  it("wears the evaluation's trail: Courses, course, classroom, evaluation, Results", async () => {
    mockFetch({
      [`GET ${VIEW}`]: ok(makeResultsView()),
      "GET /app/api/evaluations/e1": ok(makeEvaluationDetail()),
      "GET /app/api/classrooms/r1": ok(makeClassroomDetail()),
    });
    const navigate = vi.fn();
    renderWithProviders(<ResultsView evaluationId="e1" navigate={navigate} />);

    const trail = await screen.findByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() =>
      expect(within(trail).getAllByRole("listitem").map((li) => li.textContent).filter(Boolean)).toEqual([
        "Courses",
        "PRG1",
        "PRG1-2026",
        "Quiz 3",
        "Results",
      ]),
    );
    expect(within(trail).getByText("Results")).toHaveAttribute("aria-current", "page");
    expect(within(trail).getByRole("link", { name: "Quiz 3" })).toHaveAttribute("href", "/evaluations/e1");
    await userEvent.click(within(trail).getByRole("link", { name: "PRG1-2026" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" });
  });

  it("shows the statistics, the histogram and one row per student", async () => {
    mockFetch({ [`GET ${VIEW}`]: ok(makeResultsView()) });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Results" })).toBeVisible();
    expect(screen.getByText("Mean").nextSibling).toHaveTextContent("3.3");
    // 2 of the 4 rows are at 4.0 or above.
    expect(screen.getByText("Pass rate").nextSibling).toHaveTextContent("50%");
    expect(screen.getByText("absent")).toBeVisible();
    // Default order: by last name, the way a class list is read.
    expect(names()).toEqual(["Zoe Blanc", "Noah Currat", "Adam Perret", "Marie Rochat"]);
  });

  it("sorts on a column and flips it on a second click", async () => {
    mockFetch({ [`GET ${VIEW}`]: ok(makeResultsView()) });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Results" });

    await userEvent.click(screen.getByRole("button", { name: "Grade" }));
    expect(names()).toEqual(["Noah Currat", "Adam Perret", "Marie Rochat", "Zoe Blanc"]);
    await userEvent.click(screen.getByRole("button", { name: "Grade" }));
    expect(names()).toEqual(["Zoe Blanc", "Marie Rochat", "Adam Perret", "Noah Currat"]);
  });

  it("opens a student's copy from their row and walks the table's order", async () => {
    const { evaluation: _e, available: _a, ...copy } = makeFeedback();
    mockFetch({
      [`GET ${VIEW}`]: ok(makeResultsView()),
      [`GET ${VIEW}/attempts/a1`]: ok({ ...copy, attemptId: "a1", grade: 5 }),
      [`GET ${VIEW}/attempts/a2`]: ok({ ...copy, attemptId: "a2", grade: 2 }),
    });
    const navigate = vi.fn();
    renderWithProviders(<ResultsView evaluationId="e1" navigate={navigate} />);
    await screen.findByRole("heading", { name: "Results" });

    // An absent student has no copy, so no way into one.
    expect(screen.getByText("Noah Currat").closest("tr")).not.toHaveAttribute("tabindex");
    await userEvent.click(screen.getByText("Zoe Blanc"));
    const sheet = await screen.findByRole("dialog", { name: "Zoe Blanc" });
    // The whole copy, the teacher's comment included, whatever the policy.
    expect(await within(sheet).findByText("Clean answer.")).toBeVisible();
    expect(within(sheet).getByText("sizeof-ptr")).toBeVisible();
    expect(screen.getByText("Zoe Blanc", { selector: "td *" }).closest("tr")).toHaveAttribute("aria-current", "true");

    // ↓ skips the absent row: by name, Currat has no attempt.
    expect(within(sheet).getByRole("button", { name: "Previous student" })).toBeDisabled();
    await userEvent.click(within(sheet).getByRole("button", { name: "Next student" }));
    expect(await screen.findByRole("dialog", { name: "Adam Perret" })).toBeVisible();

    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Open this question in the grading panel" }),
    );
    expect(navigate).toHaveBeenCalledWith({ view: "grading", evaluationId: "e1", item: "i1" });
  });

  it("exports through a real navigation to the CSV endpoint", async () => {
    mockFetch({ [`GET ${VIEW}`]: ok(makeResultsView()) });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    const link = await screen.findByRole("link", { name: /Export CSV/ });
    expect(link).toHaveAttribute("href", "/app/api/evaluations/e1/results.csv");
    expect(link).toHaveAttribute("download");
  });

  it("publishes only through a confirmation that names the evaluation", async () => {
    const { calls } = mockFetch({
      [`GET ${VIEW}`]: ok(makeResultsView()),
      "GET /app/api/evaluations/e1": ok(makeEvaluationDetail()),
      "GET /app/api/courses": ok([makeCourseSummary()]),
      "POST /app/api/evaluations/e1/release": ok({
        releasedAt: "2026-09-10T08:00:00.000Z",
        rows: 4,
        released: true,
      }),
    });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Publish results/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Publish the results of “Quiz 3”?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ confirm: true }),
    );
  });

  it("offers an assistant of the course neither the publication nor its withdrawal (ADR-068)", async () => {
    mockFetch({
      [`GET ${VIEW}`]: ok(makeResultsView({ released: true, releasedAt: "2026-09-10T08:00:00.000Z" })),
      "GET /app/api/evaluations/e1": ok(makeEvaluationDetail()),
      "GET /app/api/courses": ok([makeCourseSummary({ myRole: "assistant" })]),
    });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Present/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Publish results|Publish again/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Withdraw|Unpublish/ })).toBeNull();
  });

  it("flags a grading that moved after the publication", async () => {
    mockFetch({
      [`GET ${VIEW}`]: ok(
        makeResultsView({
          released: true,
          releasedAt: "2026-09-10T08:00:00.000Z",
          modifiedAfterRelease: true,
        }),
      ),
    });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    expect(await screen.findByText("Modified after publication")).toBeVisible();
  });

  it("offers the empty state rather than an empty table", async () => {
    mockFetch({
      [`GET ${VIEW}`]: ok(makeResultsView({ rows: [] })),
    });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    expect(await screen.findByText("No grade yet")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("offers the projection in the header once the evaluation is over", async () => {
    const navigate = vi.fn();
    mockFetch({
      [`GET ${VIEW}`]: ok(makeResultsView()),
      "GET /app/api/evaluations/e1": ok(makeEvaluationDetail()),
    });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={navigate} />);
    await userEvent.click(await screen.findByRole("button", { name: "Present" }));
    expect(navigate).toHaveBeenCalledWith({ view: "correction", evaluationId: "e1" });
  });

  it("offers no projection while the evaluation runs, the server would refuse it", async () => {
    const running = makeEvaluationDetail();
    running.evaluation.state = "running";
    mockFetch({
      [`GET ${VIEW}`]: ok(makeResultsView()),
      "GET /app/api/evaluations/e1": ok(running),
    });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Results" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Grading panel/ })).toBeVisible());
    expect(screen.queryByRole("button", { name: "Present" })).toBeNull();
  });
});
