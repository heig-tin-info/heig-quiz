import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TeacherHome } from "./TeacherHome";
import { makeClassroomSummary, makeCourseSummary } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * Teacher home: the courses, each with its classrooms. The page has ONE
 * primary action — creating a course — and every other affordance is
 * secondary; the empty state has to offer that same one.
 */

const COURSES = "/app/api/courses";

describe("TeacherHome", () => {
  it("lists each course with its classrooms and headcount", async () => {
    mockFetch({
      [`GET ${COURSES}`]: ok([
        makeCourseSummary({
          classrooms: [
            makeClassroomSummary({ id: "r1", name: "PRG1-2026", students: 24 }),
            makeClassroomSummary({ id: "r2", name: "PRG1-2025", students: 1 }),
          ],
        }),
      ]),
    });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

    expect(await screen.findByText("Programmation C")).toBeVisible();
    expect(screen.getByText("PRG1")).toBeVisible();
    expect(screen.getByRole("button", { name: /PRG1-2026/ })).toBeVisible();
    // Singular and plural both come from the dictionary, not from a "(s)".
    expect(screen.getByText("24 students")).toBeVisible();
    expect(screen.getByText("1 student")).toBeVisible();
  });

  it("opens the classroom that was picked", async () => {
    mockFetch({ [`GET ${COURSES}`]: ok([makeCourseSummary()]) });
    const navigate = vi.fn();
    renderWithProviders(<TeacherHome navigate={navigate} />);
    await userEvent.click(await screen.findByRole("button", { name: /PRG1-2026/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" });
  });

  it("offers the one action from the empty state, and creates a course with it", async () => {
    const { calls } = mockFetch({
      [`GET ${COURSES}`]: ok([]),
      [`POST ${COURSES}`]: ok(makeCourseSummary()),
    });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

    expect(await screen.findByText("No courses yet")).toBeVisible();
    // ONE "New course" while the list is empty: the header drops its copy of
    // the action the empty state already carries, so the screen has a single
    // accent fill and the squint test points at it (W19).
    const create = screen.getAllByRole("button", { name: /New course/ });
    expect(create).toHaveLength(1);
    await userEvent.click(create[0]!);

    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Name/), "Programmation C");
    await userEvent.type(within(dialog).getByLabelText(/Code/), "PRG1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create course" }));

    expect(calls.filter((c) => c.method === "POST")).toEqual([
      { url: COURSES, method: "POST", body: { name: "Programmation C", code: "PRG1" } },
    ]);
  });

  it("says so when the list cannot be read, and offers a retry", async () => {
    mockFetch({ [`GET ${COURSES}`]: { status: 500, body: { message: "boom" } } });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Retry/ })).toBeVisible();
  });
});
