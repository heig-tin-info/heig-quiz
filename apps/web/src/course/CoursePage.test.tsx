import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeClassroomSummary, makeCourseSummary } from "../test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { CoursePage } from "./CoursePage";

/*
 * The page of one course (F-ORG-12): its classrooms, its pools and its
 * templates, with ONE primary action — a new classroom. The templates
 * section is the one surface that lists them, so it shows even when empty
 * and says where the door is.
 */

const COURSES = "/app/api/courses";
const DETAIL = {
  course: { id: "c1", name: "Programmation C", code: "PRG1" },
  staff: [],
  pools: [{ id: "p1", name: "Pointers", visibility: "private", questionCount: 7 }],
  classrooms: [
    { id: "r1", name: "PRG1-2026", period: "2026-A", archivedAt: null, joinCode: null, joinCodeEnabled: false },
    {
      id: "r0",
      name: "PRG1-2024",
      period: "2024-A",
      archivedAt: "2025-02-01T08:00:00.000Z",
      joinCode: null,
      joinCodeEnabled: false,
    },
  ],
};
const TEMPLATE = {
  id: "t1",
  courseId: "c1",
  title: "Final exam",
  mode: "exam",
  revision: 2,
  itemCount: 3,
  totalPoints: 6,
};

function world(templates: unknown[] = [TEMPLATE]) {
  return {
    [`GET ${COURSES}`]: ok([
      makeCourseSummary({
        classrooms: [makeClassroomSummary({ id: "r1", name: "PRG1-2026", students: 24 })],
      }),
    ]),
    "GET /app/api/courses/c1": ok(DETAIL),
    "GET /app/api/courses/c1/templates": ok(templates),
    "GET /app/api/pools": ok([]),
  };
}

describe("CoursePage", () => {
  it("groups the course's classrooms, pools and templates under its name", async () => {
    mockFetch(world());
    const navigate = vi.fn();
    renderWithProviders(<CoursePage id="c1" navigate={navigate} />);

    expect(await screen.findByRole("heading", { level: 1, name: /Programmation C/ })).toBeVisible();
    for (const name of ["Classrooms", "Pools of this course", "Evaluation templates"]) {
      expect(screen.getByRole("heading", { level: 2, name: new RegExp(name) })).toBeVisible();
    }
    expect(screen.getByText("24 students")).toBeVisible();
    expect(await screen.findByText("Pointers")).toBeVisible();
    expect(await screen.findByText("Final exam")).toBeVisible();
    expect(screen.getByText("3 questions · 6 pts · rev. 2")).toBeVisible();

    // The archived classroom waits behind its toggle, as on the card.
    await userEvent.click(screen.getByRole("button", { name: /Show archived \(1\)/ }));
    await userEvent.click(screen.getByRole("button", { name: /PRG1-2024/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r0" });

    // The way back up is the Courses home.
    await userEvent.click(screen.getByRole("button", { name: "Courses" }));
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
  });

  it("has one primary action, a new classroom", async () => {
    mockFetch(world());
    renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);

    const create = await screen.findAllByRole("button", { name: /New classroom/ });
    expect(create).toHaveLength(1);
    // No "New template" before a template can be written in place (A2).
    expect(screen.queryByRole("button", { name: /template/i })).toBeNull();
    await userEvent.click(create[0]!);
    expect(await screen.findByRole("dialog", { name: "New classroom" })).toBeVisible();
  });

  it("shows the templates section even when empty, and names the door in", async () => {
    mockFetch(world([]));
    renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);

    expect(await screen.findByText("No template yet")).toBeVisible();
    expect(screen.getByText(/“Save as template”, in an evaluation's menu/)).toBeVisible();
  });

  it("says a course it cannot find does not exist, and offers the way back", async () => {
    mockFetch(world());
    const navigate = vi.fn();
    renderWithProviders(<CoursePage id="nope" navigate={navigate} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This course does not exist, or you do not have access to it.",
      }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to the courses" }));
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
  });

  it("says so when the course list cannot be read, and offers a retry", async () => {
    mockFetch({ [`GET ${COURSES}`]: fail(500, { message: "Boom" }) });
    renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);

    expect(await screen.findByText("Boom")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("deletes the course from its menu, naming its templates, then leaves for the home", async () => {
    const { calls } = mockFetch({
      ...world(),
      "DELETE /app/api/courses/c1": noContent(),
    });
    const navigate = vi.fn();
    renderWithProviders(<CoursePage id="c1" navigate={navigate} />);

    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete course/ }));
    const dialog = await screen.findByRole("dialog", { name: /and its evaluation template\./ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "home" }));
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([
      { url: "/app/api/courses/c1", method: "DELETE", body: null },
    ]);
  });
});
