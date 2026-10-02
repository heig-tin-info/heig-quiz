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
    { id: "r1", name: "PRG1-2026", period: "2026-A", archivedAt: null },
    {
      id: "r0",
      name: "PRG1-2024",
      period: "2024-A",
      archivedAt: "2025-02-01T08:00:00.000Z",
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
    // "New template" is the templates section's own action, not a second primary.
    const newTemplate = await screen.findByRole("button", { name: "New template" });
    expect(newTemplate.className).not.toMatch(/bg-accent/);
    expect(create[0]!.className).toMatch(/bg-accent/);
    await userEvent.click(create[0]!);
    expect(await screen.findByRole("dialog", { name: "New classroom" })).toBeVisible();
  });

  it("renames the course where its name is written, never its code (#294)", async () => {
    // Stateful, so the refetch that follows the save answers with the new name.
    let name = "Programmation C";
    const { calls } = mockFetch({
      ...world(),
      [`GET ${COURSES}`]: () =>
        ok([makeCourseSummary({ name, classrooms: [makeClassroomSummary({ id: "r1" })] })]),
      "PATCH /app/api/courses/c1": (call) => {
        name = (call.body as { name: string }).name;
        return ok({ id: "c1", name, code: "PRG1" });
      },
    });
    renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Rename course “Programmation C”" }),
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveValue("Programmation C");
    await userEvent.clear(input);
    await userEvent.type(input, "Programmation C avancée{Enter}");

    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { url: "/app/api/courses/c1", method: "PATCH", body: { name: "Programmation C avancée" } },
    ]);
    expect(
      await screen.findByRole("button", { name: "Rename course “Programmation C avancée”" }),
    ).toBeVisible();
    // The code is text, not a control.
    expect(screen.getByText("PRG1").closest("button")).toBeNull();
  });

  it("reports a failed course rename in a toast", async () => {
    mockFetch({ ...world(), "PATCH /app/api/courses/c1": fail(500, {}) });
    renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: /^Rename course/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), " 2{Enter}");
    expect(await screen.findByText("Could not rename this course.")).toBeVisible();
  });

  it("shows the templates section even when empty, and names the door in", async () => {
    mockFetch(world([]));
    renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);

    expect(await screen.findByText("No template yet")).toBeVisible();
    expect(screen.getByText(/“New template”, or .* “Save as template” in its menu/)).toBeVisible();
    // The empty state's action, beside the section's own.
    expect(screen.getAllByRole("button", { name: "New template" })).toHaveLength(2);
  });

  it("creates an empty template from the section, then opens its editor (F-EVAL-24)", async () => {
    const { calls } = mockFetch({
      ...world([]),
      "POST /app/api/courses/c1/templates": ok({ ...TEMPLATE, id: "t9", itemCount: 0, totalPoints: 0, revision: 1 }),
    });
    const navigate = vi.fn();
    renderWithProviders(<CoursePage id="c1" navigate={navigate} />);

    await userEvent.click((await screen.findAllByRole("button", { name: "New template" }))[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New template" });
    const submit = within(dialog).getByRole("button", { name: "Create template" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Title/), "Series 3");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Exercise" }));
    await userEvent.click(submit);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "template", id: "t9" }));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      title: "Series 3",
      mode: "exercise",
      preset: "exercise",
    });
  });

  it("opens a template's editor from its row, and keeps its two actions beside it", async () => {
    mockFetch(world());
    const navigate = vi.fn();
    renderWithProviders(<CoursePage id="c1" navigate={navigate} />);

    await userEvent.click(await screen.findByRole("button", { name: /Final exam/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "template", id: "t1" });
    expect(screen.getByRole("button", { name: "Use in a classroom" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete template" })).toBeVisible();
  });

  it("links a pool straight from the menu, with no dialog in the way", async () => {
    const { calls } = mockFetch({
      [`GET ${COURSES}`]: ok([makeCourseSummary()]),
      "GET /app/api/courses/c1": ok({
        course: { id: "c1", name: "Programmation C", code: "PRG1" },
        staff: [],
        pools: [],
        classrooms: [],
      }),
      "GET /app/api/pools": ok([
        {
          id: "p1",
          name: "Pointers",
          visibility: "private",
          ownerId: "u-1",
          isPersonal: true,
          createdAt: "2026-01-01T08:00:00.000Z",
          questionCount: 7,
          role: "owner",
        },
        {
          id: "p2",
          name: "Colleague's public pool",
          visibility: "public",
          ownerId: "u-2",
          isPersonal: false,
          createdAt: "2026-01-01T08:00:00.000Z",
          questionCount: 3,
          role: "reader",
        },
      ]),
      "PUT /app/api/courses/c1/pools": ok(undefined),
      "GET /app/api/courses/c1/templates": ok([]),
    });
    renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Link a pool" }));
    // A pool the teacher only reads is not offered: linking it is refused (ADR-013).
    expect(screen.queryByRole("menuitem", { name: "Colleague's public pool" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Pointers" }));
    // `PUT` replaces the WHOLE set, which is the only route there is.
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { url: "/app/api/courses/c1/pools", method: "PUT", body: { poolIds: ["p1"] } },
    ]);
  });

  it("prefills a new classroom with the current semester, dates and label (#156)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 7, 20)); // August: the coming autumn
    try {
      const { calls } = mockFetch({
        [`GET ${COURSES}`]: ok([makeCourseSummary()]),
        "POST /app/api/courses/c1/classrooms": ok({ id: "r9" }),
        "GET /app/api/courses/c1": ok(DETAIL),
        "GET /app/api/courses/c1/templates": ok([]),
        "GET /app/api/pools": ok([]),
      });
      renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);
      await userEvent.click(await screen.findByRole("button", { name: "New classroom" }));
      const dialog = await screen.findByRole("dialog", { name: "New classroom" });
      expect(within(dialog).getByLabelText("First month")).toHaveValue("2026-09");
      expect(within(dialog).getByLabelText("Last month")).toHaveValue("2027-01");
      expect(within(dialog).getByRole("textbox", { name: "Period label" })).toHaveValue(
        "Autumn 2026",
      );
      await userEvent.type(within(dialog).getByRole("textbox", { name: /^Name/ }), "PRG1-2026");
      await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        name: "PRG1-2026",
        period: "Autumn 2026",
        periodStart: "2026-09",
        periodEnd: "2027-01",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("unlinks a pool from the icon beside it", async () => {
    const { calls } = mockFetch({
      [`GET ${COURSES}`]: ok([makeCourseSummary()]),
      "GET /app/api/courses/c1": ok({
        course: { id: "c1", name: "Programmation C", code: "PRG1" },
        staff: [],
        pools: [{ id: "p1", name: "Pointers", questionCount: 7 }],
        classrooms: [],
      }),
      "GET /app/api/pools": ok([]),
      "PUT /app/api/courses/c1/pools": ok(undefined),
      "GET /app/api/courses/c1/templates": ok([]),
    });
    renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);

    // One action, one icon: no menu to open on the way to it.
    await userEvent.click(await screen.findByRole("button", { name: "Unlink from this course" }));
    const dialog = await screen.findByRole("dialog", { name: /Unlink from this course/ });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unlink from this course" }),
    );
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { url: "/app/api/courses/c1/pools", method: "PUT", body: { poolIds: [] } },
    ]);
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
