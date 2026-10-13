import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ActivitySummary, CourseSummary } from "@quiz/contracts";

import { makeClassroomSummary, makeCourseSummary } from "../test/fixtures";
import { makeQueryClient, renderWithProviders } from "../test/render";
import { ClassroomsPage } from "./ClassroomsPage";

/*
 * The phone's Classrooms page (#449): the sidebar's "right now" list
 * (`rightNowClassrooms`, whose rules Shell.test.tsx walks), one card per
 * course, each row opening its classroom.
 */
function renderPage(courses: CourseSummary[], activities?: ActivitySummary[]) {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(["courses"], courses);
  if (activities) queryClient.setQueryData(["activities"], activities);
  const navigate = vi.fn();
  renderWithProviders(<ClassroomsPage navigate={navigate} />, { queryClient });
  return navigate;
}

describe("ClassroomsPage", () => {
  it("lists the running classrooms under their course, and opens one", async () => {
    const navigate = renderPage([
      makeCourseSummary({
        id: "k1",
        code: "PRG1",
        name: "Programmation C",
        classrooms: [makeClassroomSummary({ id: "c1", name: "PRG1-A", courseId: "k1", courseCode: "PRG1", courseName: "Programmation C" })],
      }),
      makeCourseSummary({ id: "k2", hidden: true, classrooms: [makeClassroomSummary({ id: "c2", name: "Hidden room", courseId: "k2" })] }),
    ]);
    expect(screen.getByText("PRG1 · Programmation C")).toBeInTheDocument();
    // A course the teacher hid is out of the list, as in the sidebar (#155).
    expect(screen.queryByText("Hidden room")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /PRG1-A/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c1" });
  });

  it("says so when no classroom is running, and leads to the courses", async () => {
    const navigate = renderPage([makeCourseSummary({ classrooms: [] })]);
    expect(screen.getByText("No classroom running now")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open courses" }));
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
  });

  const room = makeClassroomSummary({
    id: "c1",
    name: "PRG1-A",
    courseId: "k1",
    students: 24,
    claimed: 18,
    journal: { lastPage: { title: "Week 2", at: "2026-10-01T08:00:00.000Z" }, nextPage: null },
  });
  const grading: ActivitySummary = {
    kind: "evaluation",
    id: "00000000-0000-4000-8000-000000000001",
    title: "Quiz 1",
    mode: "exam",
    state: "grading",
    classroom: { id: "c1", name: "PRG1-A", courseCode: "PRG1" },
    takeHome: false,
    opensAt: null,
    closesAt: null,
    startedAt: null,
    closedAt: null,
    closedBy: null,
    updatedAt: "2026-10-01T08:00:00.000Z",
  };

  it("adds the row's signals once the activities are known, never a zero (#805)", () => {
    renderPage([makeCourseSummary({ id: "k1", classrooms: [room] })], [grading]);
    expect(screen.getByText("1 to grade")).toBeInTheDocument();
    expect(screen.getByText("Journal: Week 2")).toBeInTheDocument();
    expect(screen.getByText("18 of 24 signed in")).toBeInTheDocument();
    expect(screen.getByText("1 evaluation")).toBeInTheDocument();
    expect(screen.queryByText(/live now|project/)).toBeNull();
  });

  it("keeps the row's first line alone while the activities are not known", () => {
    renderPage([makeCourseSummary({ id: "k1", classrooms: [room] })]);
    expect(screen.getByText("PRG1-A")).toBeInTheDocument();
    expect(screen.queryByText("Journal: Week 2")).toBeNull();
    expect(screen.queryByText("18 of 24 signed in")).toBeNull();
  });
});
