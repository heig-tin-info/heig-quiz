import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EvaluationSummary, ProjectActivitySummary } from "@quiz/contracts";

import { ClassroomActivities } from "./ClassroomActivities";
import { id, liveAt } from "./test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The classroom's Activities tab and its "Scheduled" filter (#787): what is
 * in the pipe, evaluations and projects at once.
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
    ...over,
  };
}

function render(evaluations: EvaluationSummary[], projects: ProjectActivitySummary[]) {
  mockFetch({
    [`GET /app/api/classrooms/${CLASSROOM}/evaluations`]: ok(evaluations),
    [`GET /app/api/classrooms/${CLASSROOM}/projects`]: ok(projects),
  });
  renderWithProviders(
    <ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} evaluations={{ onNew: vi.fn() }} />,
  );
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
    const evaluations = within(section("Evaluations")!);
    expect(evaluations.getByText("Planned exam")).toBeInTheDocument();
    expect(evaluations.queryByText("Being written")).toBeNull();
    const projects = within(section("Projects")!);
    expect(projects.getByText("Planned lab")).toBeInTheDocument();
    expect(projects.queryByText("Running lab")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Scheduled", pressed: true }));
    expect(within(section("Evaluations")!).getByText("Being written")).toBeInTheDocument();
  });

  it("keeps the projects alone when only a project is scheduled", async () => {
    const user = userEvent.setup();
    render([evaluation(1)], [project(2, { title: "Planned lab", state: "draft", phase: "scheduled" })]);
    await user.click(await screen.findByRole("button", { name: "Scheduled" }));
    expect(section("Evaluations")).toBeNull();
    expect(within(section("Projects")!).getByText("Planned lab")).toBeInTheDocument();
  });

  it("offers no chip where nothing is scheduled", async () => {
    render([evaluation(1, { title: "Being written" })], [project(1)]);
    expect(await screen.findByText("Being written")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scheduled" })).toBeNull();
  });
});
