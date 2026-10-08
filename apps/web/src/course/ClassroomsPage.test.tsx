import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CourseSummary } from "@quiz/contracts";

import { makeClassroomSummary, makeCourseSummary } from "../test/fixtures";
import { makeQueryClient, renderWithProviders } from "../test/render";
import { ClassroomsPage } from "./ClassroomsPage";

/*
 * The phone's Classrooms page (#449): the sidebar's "right now" list
 * (`rightNowClassrooms`, whose rules Shell.test.tsx walks), one card per
 * course, each row opening its classroom.
 */
function renderPage(courses: CourseSummary[]) {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(["courses"], courses);
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
});
