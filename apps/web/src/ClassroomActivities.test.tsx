import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EvaluationSummary, ProjectActivitySummary } from "@quiz/contracts";

import { ClassroomActivities } from "./ClassroomActivities";
import { classroomProjectsKey, evaluationsKey } from "./queryKeys";
import { id, liveAt } from "./test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The classroom's Activities tab: one table per kind or one of everything
 * (Grouped / All), and its "Scheduled" filter (#787): what is in the pipe,
 * evaluations and projects at once.
 */

const CLASSROOM = id("classroom", 1);
const ROOM = { id: CLASSROOM, name: "PRG1-2026", courseCode: "PRG1" };

function evaluation(n: number, over: Partial<EvaluationSummary> = {}): EvaluationSummary {
  return {
    id: id("evaluation", n),
    classroomId: CLASSROOM,
    title: `Quiz ${n}`,
    mode: "exam",
    state: "draft",
    itemCount: 4,
    totalPoints: 7,
    attemptCount: 0,
    participantCount: 0,
    deletionRole: "assistant",
    opensAt: null,
    closesAt: null,
    startedAt: null,
    createdAt: liveAt(-3600_000),
    originRevision: null,
    templateRevision: null,
    ...over,
  };
}

function project(n: number, over: Partial<ProjectActivitySummary> = {}): ProjectActivitySummary {
  return {
    kind: "project",
    id: id("project", n),
    title: `Labo ${n}`,
    state: "published",
    phase: "published",
    classroom: ROOM,
    startAt: liveAt(-86_400_000),
    deadlineAt: liveAt(7 * 86_400_000),
    source: { fullName: "heig/lab-source" },
    distribution: { fullName: "heig/lab-squashed" },
    participantCount: 0,
    ...over,
  };
}

function render(evaluations: EvaluationSummary[], projects: ProjectActivitySummary[]) {
  mockFetch({
    [`GET /app/api/classrooms/${CLASSROOM}/evaluations`]: ok(evaluations),
    [`GET /app/api/classrooms/${CLASSROOM}/projects`]: ok(projects),
  });
  return renderWithProviders(
    <ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />,
  ).queryClient;
}

const section = (name: string) => screen.queryByRole("region", { name });

describe("ClassroomActivities", () => {
  it("narrows both lists to what is scheduled, and drops a list that has none", async () => {
    const user = userEvent.setup();
    render(
      [evaluation(1, { title: "Being written" }), evaluation(2, { title: "Planned exam", state: "scheduled", opensAt: liveAt(86_400_000) })],
      [project(1, { title: "Running lab" }), project(2, { title: "Planned lab", state: "draft", phase: "scheduled" })],
    );
    await user.click(await screen.findByRole("button", { name: "Scheduled", pressed: false }));
    const evaluations = within(section("Exams")!);
    expect(evaluations.getByText("Planned exam")).toBeInTheDocument();
    expect(evaluations.queryByText("Being written")).toBeNull();
    const projects = within(section("Projects")!);
    expect(projects.getByText("Planned lab")).toBeInTheDocument();
    expect(projects.queryByText("Running lab")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Scheduled", pressed: true }));
    expect(within(section("Exams")!).getByText("Being written")).toBeInTheDocument();
  });

  it("keeps the projects alone when only a project is scheduled", async () => {
    const user = userEvent.setup();
    render([evaluation(1)], [project(2, { title: "Planned lab", state: "draft", phase: "scheduled" })]);
    await user.click(await screen.findByRole("button", { name: "Scheduled" }));
    expect(section("Exams")).toBeNull();
    expect(within(section("Projects")!).getByText("Planned lab")).toBeInTheDocument();
  });

  it("drops the filter when the last scheduled row opens, and keeps it off", async () => {
    const user = userEvent.setup();
    const planned = evaluation(2, { title: "Planned exam", state: "scheduled", opensAt: liveAt(60_000) });
    const qc = render([evaluation(1, { title: "Being written" }), planned], [project(1, { title: "Running lab" })]);
    await user.click(await screen.findByRole("button", { name: "Scheduled", pressed: false }));
    expect(screen.queryByText("Being written")).toBeNull();
    // The refetch after its opening: nothing scheduled any more.
    act(() => {
      qc.setQueryData(evaluationsKey(CLASSROOM), [evaluation(1, { title: "Being written" }), { ...planned, state: "running" }]);
    });
    expect(await screen.findByText("Being written")).toBeInTheDocument();
    expect(within(section("Projects")!).getByText("Running lab")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scheduled" })).toBeNull();
    // Something scheduled again later in the visit: the chip is back, unpressed.
    act(() => {
      qc.setQueryData(classroomProjectsKey(CLASSROOM), [
        project(1, { title: "Running lab" }),
        project(2, { title: "Planned lab", state: "draft", phase: "scheduled" }),
      ]);
    });
    expect(await screen.findByRole("button", { name: "Scheduled", pressed: false })).toBeInTheDocument();
    expect(screen.getByText("Being written")).toBeInTheDocument();
  });

  it("still says a failed read of the evaluations while the filter is on", async () => {
    const user = userEvent.setup();
    const qc = render([evaluation(2, { title: "Planned exam", state: "scheduled" })], [project(2, { title: "Planned lab", state: "draft", phase: "scheduled" })]);
    await user.click(await screen.findByRole("button", { name: "Scheduled" }));
    act(() => {
      qc.getQueryCache().find({ queryKey: evaluationsKey(CLASSROOM) })!.setState({ status: "error", error: new Error("boom"), data: undefined });
    });
    expect(await screen.findByRole("region", { name: "Evaluations" })).toBeInTheDocument();
  });

  it("offers no chip where nothing is scheduled", async () => {
    render([evaluation(1, { title: "Being written" })], [project(1)]);
    expect(await screen.findByText("Being written")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scheduled" })).toBeNull();
  });

  it("draws one table per kind by default, exams, exercises, projects then polls, with no Mode column and the Participants", async () => {
    render(
      [
        evaluation(1, { title: "A poll", mode: "poll", participantCount: 31 }),
        evaluation(2, { title: "An exercise", mode: "exercise" }),
        evaluation(3, { title: "An exam", participantCount: 24 }),
      ],
      [project(1, { title: "A lab", participantCount: 12 })],
    );
    await screen.findByText("A lab");
    expect(screen.getByRole("radio", { name: "Grouped" })).toBeChecked();
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"))).toEqual([
      "classroom-exam",
      "classroom-exercise",
      "classroom-project",
      "classroom-poll",
    ]);
    expect(screen.queryByRole("columnheader", { name: /Mode/ })).toBeNull();
    const headers = (name: string) =>
      within(section(name)!)
        .getAllByRole("columnheader")
        .map((h) => h.textContent);
    expect(headers("Exams")).toEqual(["Title", "Start", "End", "Questions", "Points", "Participants", "Actions"]);
    expect(headers("Projects")).toEqual(["Title", "Start", "Deadline", "Participants", "Actions"]);
    expect(headers("Polls")).toEqual(["Title", "Start", "End", "Questions", "Participants", "Actions"]);
    expect(within(section("Exams")!).getByText("24")).toBeInTheDocument();
    expect(within(section("Projects")!).getByText("12")).toBeInTheDocument();
    expect(within(section("Polls")!).getByText("31")).toBeInTheDocument();
  });

  it("merges everything into one table under All, drafts first then the latest start, sorted across both kinds, and remembers it", async () => {
    const user = userEvent.setup();
    render(
      [
        evaluation(1, { title: "Old exam", state: "closed", startedAt: liveAt(-10 * 86_400_000) }),
        evaluation(2, { title: "Being written" }),
        evaluation(3, { title: "A poll", mode: "poll", state: "running", startedAt: liveAt(-60_000) }),
      ],
      [project(1, { title: "Lab", startAt: liveAt(-86_400_000) })],
    );
    await screen.findByText("Lab");
    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(localStorage.getItem("quiz-evaluations-group")).toBe("all");
    expect(screen.getAllByRole("region")).toHaveLength(1);
    const table = within(section("Activities")!);
    expect(table.getByRole("columnheader", { name: /Mode/ })).toBeInTheDocument();
    const titles = () =>
      table
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector(".font-semibold")?.textContent);
    expect(titles()).toEqual(["Being written", "A poll", "Lab", "Old exam"]);
    // Each row keeps its kind: the mode's word, and a dash where the kind has no such count.
    const row = (title: string) => within(table.getByText(title).closest("tr")!);
    expect(row("Lab").getByText("Project")).toBeInTheDocument();
    expect(row("Lab").getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(row("A poll").getByText("Poll")).toBeInTheDocument();
    await user.click(table.getByRole("button", { name: "Title" }));
    expect(titles()).toEqual(["A poll", "Being written", "Lab", "Old exam"]);
  });

  it("reads a stored former grouping as Grouped", async () => {
    localStorage.setItem("quiz-evaluations-group", "status");
    render([evaluation(1, { title: "An exam" }), evaluation(2, { title: "A poll", mode: "poll" })], []);
    await screen.findByText("An exam");
    expect(screen.getByRole("radio", { name: "Grouped" })).toBeChecked();
    expect(section("Exams")).not.toBeNull();
    expect(section("Polls")).not.toBeNull();
  });

  it("keeps the scheduled rows alone in the All table", async () => {
    const user = userEvent.setup();
    localStorage.setItem("quiz-evaluations-group", "all");
    render(
      [evaluation(1, { title: "Being written" }), evaluation(2, { title: "Planned exam", state: "scheduled", opensAt: liveAt(86_400_000) })],
      [project(1, { title: "Running lab" }), project(2, { title: "Planned lab", state: "draft", phase: "scheduled" })],
    );
    await screen.findByText("Running lab");
    await user.click(screen.getByRole("button", { name: "Scheduled", pressed: false }));
    const table = within(section("Activities")!);
    expect(table.getByText("Planned exam")).toBeInTheDocument();
    expect(table.getByText("Planned lab")).toBeInTheDocument();
    expect(table.queryByText("Being written")).toBeNull();
    expect(table.queryByText("Running lab")).toBeNull();
  });

  it("draws the empty state only when there is neither an evaluation nor a project", async () => {
    render([], [project(1, { title: "Only a lab" })]);
    expect(await screen.findByText("Only a lab")).toBeInTheDocument();
    expect(screen.queryByText(/no evaluation yet/i)).toBeNull();
  });
});
