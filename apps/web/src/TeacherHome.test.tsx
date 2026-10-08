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

  it("opens the course page from the card's title, and lists no template there (F-ORG-12)", async () => {
    const { calls } = mockFetch({ [`GET ${COURSES}`]: ok([makeCourseSummary({ templates: 2 })]) });
    const navigate = vi.fn();
    renderWithProviders(<TeacherHome navigate={navigate} />);
    await userEvent.click(await screen.findByRole("button", { name: "Programmation C" }));
    expect(navigate).toHaveBeenCalledWith({ view: "course", id: "c1" });
    // The course page is the one surface of templates: the card neither
    // shows a section for them nor asks for them.
    expect(screen.queryByText("Evaluation templates")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/templates"))).toBe(false);
    // It counts them, from the course list, and the count opens the page.
    navigate.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "2 templates" }));
    expect(navigate).toHaveBeenCalledWith({ view: "course", id: "c1" });
  });

  it("lists the pools on the card, and leaves classrooms and pool links to the course page", async () => {
    const { calls } = mockFetch({
      [`GET ${COURSES}`]: ok([makeCourseSummary()]),
      "GET /app/api/courses/c1": ok({
        course: { id: "c1", name: "Programmation C", code: "PRG1" },
        staff: [],
        pools: [{ id: "p1", name: "Pointers", questionCount: 7 }],
        classrooms: [],
      }),
    });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /Pointers/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Link a pool" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlink from this course" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New classroom" })).toBeNull();
    // What could be linked is not even read.
    expect(calls.some((c) => c.url === "/app/api/pools")).toBe(false);
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
    await userEvent.type(within(dialog).getByLabelText(/Course code/), "PRG1");
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
    // The course's name is the way into its page, as on the card.
    await userEvent.click(within(row).getByRole("button", { name: "Programmation C" }));
    expect(navigate).toHaveBeenCalledWith({ view: "course", id: "c1" });
    expect(localStorage.getItem("quiz-courses-view")).toBe("list");

    // A habit, not a state of the data: the next visit opens the same way.
    unmount();
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);
    expect(await screen.findByRole("radio", { name: "List" })).toBeChecked();
  });

  it("offers the three course actions in one menu", async () => {
    mockFetch({ [`GET ${COURSES}`]: ok([makeCourseSummary()]) });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

    // Three actions, so a menu: `Actions` decides the shape.
    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: /Add a staff member/ })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /Hide for me/ })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /Delete course/ })).toBeVisible();
  });

  it("hides a course for the caller from its menu (#155)", async () => {
    const { calls } = mockFetch({
      [`GET ${COURSES}`]: ok([makeCourseSummary()]),
      "POST /app/api/courses/c1/hide": ok(undefined),
    });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Hide for me/ }));
    expect(calls.some((c) => c.method === "POST" && c.url === "/app/api/courses/c1/hide")).toBe(
      true,
    );
  });

  it("leaves a hidden course out until “Show hidden”, then offers to show it again", async () => {
    const { calls } = mockFetch({
      [`GET ${COURSES}`]: ok([
        makeCourseSummary(),
        makeCourseSummary({ id: "c3", name: "Algorithmique", code: "ALG", hidden: true, classrooms: [] }),
      ]),
      "POST /app/api/courses/c3/unhide": ok(undefined),
    });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

    expect(await screen.findByText("Programmation C")).toBeVisible();
    expect(screen.queryByText("Algorithmique")).toBeNull();
    const toggle = screen.getByRole("button", { name: /Show hidden \(1\)/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Algorithmique")).toBeVisible();
    expect(screen.getByText("Hidden")).toBeVisible();

    const menus = screen.getAllByRole("button", { name: "Actions" });
    await userEvent.click(menus[1]!);
    await userEvent.click(screen.getByRole("menuitem", { name: /Show again/ }));
    expect(calls.some((c) => c.method === "POST" && c.url === "/app/api/courses/c3/unhide")).toBe(
      true,
    );
  });

  it("says the list is folded away when every course is hidden", async () => {
    mockFetch({ [`GET ${COURSES}`]: ok([makeCourseSummary({ hidden: true })]) });
    renderWithProviders(<TeacherHome navigate={vi.fn()} />);

    expect(await screen.findByText("All your courses are hidden")).toBeVisible();
    expect(screen.queryByText("No courses yet")).toBeNull();
    // One way back, the empty state's: the toolbar chip stands down.
    const back = screen.getAllByRole("button", { name: /Show hidden \(1\)/ });
    expect(back).toHaveLength(1);
    await userEvent.click(back[0]!);
    expect(screen.getByText("Programmation C")).toBeVisible();
  });

  it("lists the archived classrooms behind “Show archived”, each opening its page (#155)", async () => {
    mockFetch({
      [`GET ${COURSES}`]: ok([makeCourseSummary()]),
      "GET /app/api/courses/c1": ok({
        course: { id: "c1", name: "Programmation C", code: "PRG1" },
        staff: [],
        pools: [],
        classrooms: [
          { id: "r1", name: "PRG1-2026", period: "2026-A", archivedAt: null },
          {
            id: "r0",
            name: "PRG1-2024",
            period: "2024-A",
            archivedAt: "2025-02-01T08:00:00.000Z",
          },
        ],
      }),
      "GET /app/api/pools": ok([]),
    });
    const navigate = vi.fn();
    renderWithProviders(<TeacherHome navigate={navigate} />);

    const toggle = await screen.findByRole("button", { name: /Show archived \(1\)/ });
    expect(screen.queryByRole("button", { name: /PRG1-2024/ })).toBeNull();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: /PRG1-2024/ }));
    // Restoring is the classroom page's business: the row only opens it.
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r0" });
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
              role: "owner",
            },
            {
              userId: "u-2",
              givenName: "Pierre",
              familyName: "Roulet",
              email: "pierre.roulet@heig-vd.ch",
              avatarUrl: null,
              role: "owner",
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
              role: "owner",
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
