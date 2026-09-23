import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { applyTheme, getThemeChoice } from "./theme";
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

  it("reads the same list as a table, and remembers the choice", async () => {
    mockFetch({
      [`GET ${COURSES}`]: ok([
        makeCourseSummary({ classrooms: [makeClassroomSummary({ id: "r1", name: "PRG1-2026" })] }),
      ]),
    });
    const navigate = vi.fn();
    const { unmount } = renderWithProviders(<TeacherHome navigate={navigate} />);

    await userEvent.click(await screen.findByRole("radio", { name: "List" }));
    // The table answers "which classroom, in which course" in one line, and
    // the classroom name stays the way in.
    const row = screen.getByRole("row", { name: /Programmation C/ });
    await userEvent.click(within(row).getByRole("button", { name: /PRG1-2026/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" });
    expect(localStorage.getItem("quiz-courses-view")).toBe("list");

    // A habit, not a state of the data: the next visit opens the same way.
    unmount();
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);
    expect(await screen.findByRole("radio", { name: "List" })).toBeChecked();
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
        },
      ]),
      "PUT /app/api/courses/c1/pools": ok(undefined),
    });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Link a pool" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Pointers" }));
    // `PUT` replaces the WHOLE set, which is the only route there is.
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { url: "/app/api/courses/c1/pools", method: "PUT", body: { poolIds: ["p1"] } },
    ]);
  });

  it("offers the two course actions as icon buttons, named", async () => {
    mockFetch({ [`GET ${COURSES}`]: ok([makeCourseSummary()]) });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

    // Two actions, so two buttons and NO overflow menu: `Actions` decides the
    // shape, and a course has exactly these two things beyond its classrooms.
    expect(await screen.findByRole("button", { name: "Add a staff member" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete course" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("removes a staff member from that person's own card", async () => {
    const { calls } = mockFetch({
      [`GET ${COURSES}`]: ok([
        makeCourseSummary({
          staff: [
            {
              userId: "u-1",
              givenName: "Marie",
              familyName: "Dupont",
              email: "marie.dupont@heig-vd.ch",
              avatarUrl: null,
            },
            {
              userId: "u-2",
              givenName: "Pierre",
              familyName: "Roulet",
              email: "pierre.roulet@heig-vd.ch",
              avatarUrl: null,
            },
          ],
        }),
      ]),
      "DELETE /app/api/courses/c1/staff/u-2": ok(undefined),
    });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

    // The disc names the colleague; the card behind it holds their address
    // and the one thing that may be done to their seat.
    await userEvent.click(await screen.findByRole("button", { name: "Pierre Roulet" }));
    const card = screen.getByRole("dialog", { name: "Pierre Roulet" });
    expect(within(card).getByText("pierre.roulet@heig-vd.ch")).toBeVisible();
    await userEvent.click(within(card).getByRole("button", { name: "Remove from the staff" }));

    const confirmDialog = await screen.findByRole("dialog", {
      name: /Remove Pierre Roulet from the staff/,
    });
    await userEvent.click(
      within(confirmDialog).getByRole("button", { name: "Remove from the staff" }),
    );
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([
      { url: "/app/api/courses/c1/staff/u-2", method: "DELETE", body: null },
    ]);
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
    });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

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

  it("sorts the table on the column that was clicked", async () => {
    mockFetch({
      [`GET ${COURSES}`]: ok([
        makeCourseSummary({ id: "c1", name: "Algorithmique", code: "ALG", staff: [] }),
        makeCourseSummary({
          id: "c2",
          name: "Programmation C",
          code: "PRG1",
          staff: [
            {
              userId: "u-1",
              givenName: "Marie",
              familyName: "Dupont",
              email: "marie.dupont@heig-vd.ch",
              avatarUrl: null,
            },
          ],
        }),
      ]),
    });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />, { route: "/" });
    await userEvent.click(await screen.findByRole("radio", { name: "List" }));

    // The initial sort is the name, ascending.
    const names = () =>
      screen.getAllByRole("row").slice(1).map((row) => row.textContent ?? "");
    expect(names()[0]).toContain("Algorithmique");

    // Staff ascending puts the course with nobody on it first, and clicking
    // the same column again flips it.
    await userEvent.click(screen.getByRole("button", { name: "Staff" }));
    expect(names()[0]).toContain("Algorithmique");
    await userEvent.click(screen.getByRole("button", { name: "Staff" }));
    expect(names()[0]).toContain("Programmation C");
  });

  it("says so when the list cannot be read, and offers a retry", async () => {
    mockFetch({ [`GET ${COURSES}`]: { status: 500, body: { message: "boom" } } });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Retry/ })).toBeVisible();
  });
});

/*
 * A private window (or blocked site data) makes `localStorage` THROW rather
 * than return null. Before FC-08 the courses-view reader, the locale and the
 * theme all read it unguarded, so this page crashed at boot. The path a
 * teacher takes to it is exercised whole: the theme applied by `main.tsx`,
 * the I18nProvider's initial locale, then the page and its remembered view.
 */
describe("TeacherHome in a private window", () => {
  it("renders when every localStorage access throws", async () => {
    const denied = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    mockFetch({ [`GET ${COURSES}`]: ok([makeCourseSummary()]) });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(denied);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(denied);
    // `renderWithProviders` seeds the locale with setItem before rendering;
    // the theme is applied first, as `main.tsx` does, with setItem refused.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied);
    expect(() => applyTheme(getThemeChoice())).not.toThrow();
    setItem.mockRestore();
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied);

    expect(await screen.findByText("Programmation C")).toBeVisible();
    // The remembered view falls back to cards, and picking one still works.
    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(screen.getByRole("radio", { name: "List" })).toBeChecked();
  });
});
