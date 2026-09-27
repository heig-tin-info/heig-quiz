import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CourseSummary, PoolDetail, PoolSummary } from "@quiz/contracts";

import { Shell } from "./Shell";
import { resetShortcuts, useShortcuts } from "./shortcuts";
import { modKey } from "./ui";
import { makeClassroomSummary, makeCourseSummary, makeMe } from "./test/fixtures";
import { makeQueryClient, renderWithProviders } from "./test/render";
import type { Route } from "./router";

/*
 * The application frame. The classroom list comes from a seeded query cache
 * rather than from fetch: the point here is the navigation the teacher reads,
 * not the endpoint (which `api.ts` owns).
 *
 * The desktop sidebar and the mobile drawer render the same <Nav>, and both
 * are in the DOM at once while the drawer is open (only CSS hides one), so
 * every drawer assertion is scoped to the drawer dialog.
 */

/** One course carrying `n` classrooms: what the sidebar flattens and lists. */
const rooms = (n: number): CourseSummary[] => [
  makeCourseSummary({
    classrooms: Array.from({ length: n }, (_, i) =>
      makeClassroomSummary({ id: `c${i + 1}`, name: `Classroom ${i + 1}`, period: "" }),
    ),
  }),
];

/** A pool with one two-level category tree, as the sidebar unfolds it. */
const POOL: PoolDetail = {
  pool: {
    id: "p1",
    name: "Pointers",
    visibility: "private",
    ownerId: "u1",
    isPersonal: true,
    createdAt: "2026-01-01T08:00:00.000Z",
  },
  categories: [
    {
      id: "k1",
      poolId: "p1",
      parentId: null,
      name: "Arrays",
      position: 0,
      children: [
        { id: "k2", poolId: "p1", parentId: "k1", name: "Strings", position: 0, children: [] },
      ],
    },
    { id: "k3", poolId: "p1", parentId: null, name: "Structs", position: 1, children: [] },
  ],
  tags: [],
  questionCount: 7,
};

function renderShell({
  route = { view: "home" } as Route,
  courses = rooms(3),
  teacherUi = true,
  studentView = false,
  me = makeMe(),
  navigate = vi.fn(),
  onToggleStudentView = vi.fn(),
  canSwitchView = true,
  pool,
  poolList,
  path,
  wide,
  children,
}: {
  route?: Route;
  courses?: CourseSummary[];
  teacherUi?: boolean;
  studentView?: boolean;
  me?: ReturnType<typeof makeMe>;
  navigate?: (r: Route) => void;
  onToggleStudentView?: () => void;
  /** False is a plain student: the frame gets no switch at all. */
  canSwitchView?: boolean;
  /** Seeds the pool the sidebar unfolds on a `pool` route. */
  pool?: PoolDetail;
  /** Seeds the pool LIST the "all pools" state of the sidebar draws. */
  poolList?: PoolSummary[];
  /** URL the frame reads `?category=` from. */
  path?: string;
  /** The route's opt-out of the reading-width cap (#93). */
  wide?: boolean;
  /** What the frame wraps; a screen registering its own shortcuts, here. */
  children?: ReactNode;
} = {}) {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(["courses"], courses);
  if (pool) queryClient.setQueryData(["pool", pool.pool.id], pool);
  if (poolList) queryClient.setQueryData(["pools"], poolList);
  renderWithProviders(
    <Shell
      me={me}
      route={route}
      navigate={navigate}
      teacherUi={teacherUi}
      studentView={studentView}
      {...(canSwitchView ? { onToggleStudentView } : {})}
      wide={wide}
    >
      {children ?? <p>Page content</p>}
    </Shell>,
    { queryClient, ...(path ? { route: path } : {}) },
  );
  return { navigate, onToggleStudentView };
}

/** The sidebar of the desktop layout (the drawer renders the same nav). */
const sidebar = () => screen.getAllByRole("navigation")[0]!;
/** The flat Classrooms section of the sidebar, under its heading. */
const classroomsSection = () => within(sidebar()).getByText("Classrooms").parentElement!;

describe("Shell content width (#93)", () => {
  it("caps the page at the reading width by default", () => {
    renderShell();
    expect(screen.getByRole("main")).toHaveClass("max-w-280");
  });

  it("lets a wide route take the whole content area", () => {
    renderShell({ route: { view: "live", id: "e1" }, wide: true });
    const main = screen.getByRole("main");
    expect(main).not.toHaveClass("max-w-280");
    expect(main).toHaveClass("max-w-none");
  });
});

describe("Shell sidebar", () => {
  it("shows the teacher navigation and the classrooms of the query", () => {
    renderShell();
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: "Courses" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("button", { name: "Question pools" })).toBeInTheDocument();
    // Settings is not a section of the product: it lives in the account menu
    // at the bottom of the sidebar, and in the palette.
    expect(nav.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(nav.getByRole("button", { name: /^Classroom 1(?!\d)/ })).toBeInTheDocument();
    expect(nav.getByRole("button", { name: /^Classroom 3(?!\d)/ })).toBeInTheDocument();
  });

  it("keeps Administration out of a plain teacher's navigation", () => {
    renderShell();
    expect(within(sidebar()).queryByRole("button", { name: "Administration" })).toBeNull();
  });

  it("offers Administration to an admin", () => {
    renderShell({ me: makeMe({ role: "admin" }) });
    expect(
      within(sidebar()).getByRole("button", { name: "Administration" }),
    ).toBeInTheDocument();
  });

  it("marks the classroom being read with aria-current", () => {
    renderShell({ route: { view: "classroom", id: "c2" } });
    // The course tree above lists it too (#154); this is the flat section.
    const nav = within(classroomsSection());
    expect(nav.getByRole("button", { name: /^Classroom 2(?!\d)/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.getByRole("button", { name: /^Classroom 1(?!\d)/ })).not.toHaveAttribute("aria-current");
    // The classroom page is not the home page.
    expect(within(sidebar()).getByRole("button", { name: "Courses" })).not.toHaveAttribute("aria-current");
  });

  it("leaves the classrooms of a hidden course out of the flat section (#155)", () => {
    renderShell({
      courses: [
        makeCourseSummary({ classrooms: [makeClassroomSummary({ id: "r1", name: "PRG1-2026" })] }),
        makeCourseSummary({
          id: "k9",
          hidden: true,
          classrooms: [makeClassroomSummary({ id: "h1", name: "ALG-2024", courseId: "k9" })],
        }),
      ],
    });
    const nav = within(classroomsSection());
    expect(nav.getByRole("button", { name: /^PRG1-2026/ })).toBeVisible();
    expect(nav.queryByRole("button", { name: /^ALG-2024/ })).toBeNull();
  });

  it("navigates when a classroom is picked", async () => {
    const { navigate } = renderShell();
    await userEvent.click(within(sidebar()).getByRole("button", { name: /^Classroom 2(?!\d)/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c2" });
  });

  it("caps the list at twelve and unfolds it on Show all", async () => {
    renderShell({ courses: rooms(15) });
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: /^Classroom 12(?!\d)/ })).toBeInTheDocument();
    expect(nav.queryByRole("button", { name: /^Classroom 13(?!\d)/ })).toBeNull();
    await userEvent.click(nav.getByRole("button", { name: "Show all (15)" }));
    expect(nav.getByRole("button", { name: /^Classroom 15(?!\d)/ })).toBeInTheDocument();
    expect(nav.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("keeps the classroom being read visible past the cap", () => {
    renderShell({ courses: rooms(30), route: { view: "classroom", id: "c25" } });
    const nav = within(classroomsSection());
    expect(nav.getByRole("button", { name: /^Classroom 25(?!\d)/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.queryByRole("button", { name: /^Classroom 24(?!\d)/ })).toBeNull();
  });

  describe("the dated period (#156)", () => {
    afterEach(() => vi.useRealTimers());
    const dated = (): CourseSummary[] => [
      makeCourseSummary({
        classrooms: [
          makeClassroomSummary({ id: "a", name: "Autumn room", periodStart: "2026-09", periodEnd: "2027-01" }),
          makeClassroomSummary({ id: "s", name: "Spring room", periodStart: "2027-02", periodEnd: "2027-07" }),
          makeClassroomSummary({ id: "u", name: "Undated room", periodStart: null, periodEnd: null }),
        ],
      }),
    ];
    const at = (y: number, m: number) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(y, m - 1, 15));
    };

    it("lists a dated classroom only while its period, margin included, covers today", () => {
      at(2026, 11);
      renderShell({ courses: dated() });
      const nav = within(classroomsSection());
      expect(nav.getByRole("button", { name: /^Autumn room/ })).toBeInTheDocument();
      expect(nav.queryByRole("button", { name: /^Spring room/ })).toBeNull();
      expect(nav.getByRole("button", { name: /^Undated room/ })).toBeInTheDocument();
    });

    it("overlaps two semesters inside the margin", () => {
      at(2027, 2);
      renderShell({ courses: dated() });
      const nav = within(classroomsSection());
      expect(nav.getByRole("button", { name: /^Autumn room/ })).toBeInTheDocument();
      expect(nav.getByRole("button", { name: /^Spring room/ })).toBeInTheDocument();
    });

    it("keeps the classroom being read, even out of its period", () => {
      at(2026, 11);
      renderShell({ courses: dated(), route: { view: "classroom", id: "s" } });
      const nav = within(classroomsSection());
      expect(nav.getByRole("button", { name: /^Spring room/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });

    it("counts only the current classrooms in Show all", () => {
      at(2027, 5);
      const courses = dated();
      courses[0]!.classrooms.push(
        ...Array.from({ length: 13 }, (_, i) =>
          makeClassroomSummary({ id: `x${i}`, name: `Old ${i}`, periodStart: "2025-09", periodEnd: "2026-01" }),
        ),
      );
      renderShell({ courses });
      const nav = within(classroomsSection());
      expect(nav.queryByRole("button", { name: /^Old/ })).toBeNull();
      expect(nav.queryByRole("button", { name: /Show all/ })).toBeNull();
      expect(nav.getByRole("button", { name: /^Spring room/ })).toBeInTheDocument();
    });
  });

  it("shows the student navigation, with no classroom list, outside the teacher UI", () => {
    renderShell({ teacherUi: false, me: makeMe({ role: "student" }) });
    const nav = within(sidebar());
    // WP9: "Home" is the student heading; the teacher sections are gone.
    expect(nav.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(nav.queryByRole("button", { name: /^Classroom 1(?!\d)/ })).toBeNull();
  });
});

/*
 * A classroom name that does not fit 240 px is cut by an ellipsis, and the
 * whole of it has to be readable without opening the classroom. jsdom runs no
 * layout, so the clipping is stated here: a `scrollWidth` wider than the
 * `clientWidth` is exactly what a browser reports for a truncated label.
 * Both navigations (sidebar and drawer) render the list, hence the counting
 * of copies rather than a single match — the bubble is one MORE copy.
 */
describe("Shell sidebar classroom names", () => {
  const measures = (scrollWidth: number, clientWidth: number) => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
  };
  const row = () => within(sidebar()).getByRole("button", { name: /^Classroom 1(?!\d)/ });
  afterEach(() => vi.restoreAllMocks());

  afterEach(() => vi.useRealTimers());

  it("labels a row with the classroom name alone, the course in its description (#153)", () => {
    renderShell();
    const r = within(sidebar()).getByRole("button", { name: "Classroom 1" });
    expect(r).toHaveTextContent(/^Classroom 1$/);
    expect(r).toHaveAttribute("aria-description", "PRG1 · Programmation C");
  });

  it("reveals the full name and the course on hover when the ellipsis cut it", () => {
    measures(240, 120);
    vi.useFakeTimers();
    renderShell();
    fireEvent.mouseEnter(row().parentElement!);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("Classroom 1 — PRG1 · Programmation C")).toBeInTheDocument();
  });

  it("reveals it to the keyboard as well, on the row that takes the focus", () => {
    measures(240, 120);
    vi.useFakeTimers();
    renderShell();
    act(() => row().focus());
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("Classroom 1 — PRG1 · Programmation C")).toBeInTheDocument();
  });

  it("shows only the course when the name fits: repeating a readable label is noise", () => {
    measures(120, 120);
    vi.useFakeTimers();
    renderShell();
    const copies = screen.getAllByText("Classroom 1").length;
    fireEvent.mouseEnter(row().parentElement!);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("PRG1 · Programmation C")).toBeInTheDocument();
    expect(screen.getAllByText("Classroom 1")).toHaveLength(copies);
  });
});

describe("Shell pool categories", () => {
  it("stays folded away outside a pool route", () => {
    renderShell({ pool: POOL });
    expect(within(sidebar()).queryByRole("button", { name: "All questions" })).toBeNull();
  });

  it("unfolds the pool and its categories under Question pools", () => {
    renderShell({ route: { view: "pool", id: "p1" }, pool: POOL, path: "/pools/p1" });
    const nav = within(sidebar());
    expect(nav.getByText("Pointers")).toBeVisible();
    expect(nav.getByRole("button", { name: "All questions" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(nav.getByRole("button", { name: "Arrays" })).toBeInTheDocument();
    expect(nav.getByRole("button", { name: "Strings" })).toBeInTheDocument();
    // Creating is the categories page's job; the sidebar only navigates.
    expect(nav.queryByRole("button", { name: /New category/ })).toBeNull();
    expect(nav.getByRole("button", { name: "Categories" })).not.toHaveAttribute("aria-current");
  });

  it("writes the picked category to the URL the pool page reads", async () => {
    renderShell({ route: { view: "pool", id: "p1" }, pool: POOL, path: "/pools/p1" });
    await userEvent.click(within(sidebar()).getByRole("button", { name: "Structs" }));
    expect(new URLSearchParams(window.location.search).get("category")).toBe("k3");
    expect(within(sidebar()).getByRole("button", { name: "Structs" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("reads the selection back from the URL", () => {
    renderShell({
      route: { view: "pool", id: "p1" },
      pool: POOL,
      path: "/pools/p1?category=k1",
    });
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: "Arrays" })).toHaveAttribute("aria-current", "true");
    expect(nav.getByRole("button", { name: "All questions" })).not.toHaveAttribute("aria-current");
  });

  it("carries no per-category menu: every edit lives on the categories page", async () => {
    const { navigate } = renderShell({
      route: { view: "pool", id: "p1" },
      pool: POOL,
      path: "/pools/p1",
    });
    const nav = within(sidebar());
    expect(nav.queryByRole("button", { name: "Actions" })).toBeNull();
    await userEvent.click(nav.getByRole("button", { name: "Categories" }));
    expect(navigate).toHaveBeenCalledWith({ view: "poolCategories", id: "p1" });
  });

  it("marks Categories on its page, and a pick there goes back to the list", async () => {
    const { navigate } = renderShell({
      route: { view: "poolCategories", id: "p1" },
      pool: POOL,
      path: "/pools/p1/categories",
    });
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: "Categories" })).toHaveAttribute("aria-current", "true");
    expect(nav.getByRole("button", { name: "All questions" })).not.toHaveAttribute("aria-current");
    await userEvent.click(nav.getByRole("button", { name: "Structs" }));
    expect(navigate).toHaveBeenCalledWith({ view: "pool", id: "p1" });
    expect(new URLSearchParams(window.location.search).get("category")).toBe("k3");
  });
});

/*
 * A category name the sidebar cuts reads in full on hover and on focus, and
 * only when it IS cut — the rule of the classroom names above.
 */
describe("Shell sidebar category names", () => {
  const measures = (scrollWidth: number, clientWidth: number) => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
  };
  const open = () =>
    renderShell({ route: { view: "pool", id: "p1" }, pool: POOL, path: "/pools/p1" });
  afterEach(() => vi.restoreAllMocks());

  it("shows the whole name on hover and on keyboard focus when it is cut", () => {
    measures(240, 120);
    vi.useFakeTimers();
    open();
    const row = within(sidebar()).getByRole("button", { name: "Structs" });
    const copies = screen.getAllByText("Structs").length;
    fireEvent.mouseEnter(row.closest("span")!);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getAllByText("Structs")).toHaveLength(copies + 1);
    fireEvent.mouseLeave(row.closest("span")!);
    act(() => row.focus());
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getAllByText("Structs")).toHaveLength(copies + 1);
  });

  it("says nothing when the name fits", () => {
    measures(120, 120);
    vi.useFakeTimers();
    open();
    const row = within(sidebar()).getByRole("button", { name: "Structs" });
    const copies = screen.getAllByText("Structs").length;
    act(() => row.focus());
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getAllByText("Structs")).toHaveLength(copies);
  });
});

describe("Shell mobile drawer", () => {
  it("opens and closes from the top bar, as a modal dialog", async () => {
    renderShell();
    const open = screen.getByRole("button", { name: "Open menu" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(open);
    const drawer = screen.getByRole("dialog");
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(drawer).toHaveAccessibleName("Quiz");
    expect(within(drawer).getByRole("button", { name: /^Classroom 1(?!\d)/ })).toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and after a navigation", async () => {
    const { navigate } = renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Classroom 2(?!\d)/ }),
    );
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c2" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Shell student view banner", () => {
  it("stays out of the way while the teacher UI is on", () => {
    renderShell();
    expect(screen.queryByText(/viewing the portal as a student/)).toBeNull();
  });

  it("says the teacher is in the student view and offers the way back", async () => {
    const { onToggleStudentView } = renderShell({ studentView: true, teacherUi: false });
    const line = screen.getByText("You are viewing the portal as a student.");
    expect(line).toBeVisible();
    // Scoped to the banner: the phone top bar carries a switch with the same
    // label, which is the point — the way out is never one surface only.
    const banner = line.closest("div")!;
    await userEvent.click(within(banner).getByRole("button", { name: "Back to teacher view" }));
    expect(onToggleStudentView).toHaveBeenCalledTimes(1);
  });
});

/*
 * The master switch of the frame (ADR-018 addendum). It is what makes the
 * student view reachable from the live dashboard — the screen a teacher is on
 * once they have launched the quiz, and the one the old button was missing
 * from.
 */
describe("Shell view switch", () => {
  const group = () => screen.getByRole("radiogroup", { name: "View as" });

  it("is in the frame of every teacher page, showing the view on screen", () => {
    renderShell({ route: { view: "live", id: "e1" } });
    expect(within(group()).getByRole("radio", { name: "Teacher" })).toBeChecked();
    expect(within(group()).getByRole("radio", { name: "Student" })).not.toBeChecked();
  });

  it("flips the view, once, from the teacher side", async () => {
    const { onToggleStudentView } = renderShell({ route: { view: "live", id: "e1" } });
    await userEvent.click(within(group()).getByRole("radio", { name: "Student" }));
    expect(onToggleStudentView).toHaveBeenCalledTimes(1);
    // Picking the mode already on screen changes nothing: re-entering would
    // overwrite the way back with the page the teacher is already on.
    await userEvent.click(within(group()).getByRole("radio", { name: "Teacher" }));
    expect(onToggleStudentView).toHaveBeenCalledTimes(1);
  });

  it("is just as reachable from the student shell", async () => {
    const { onToggleStudentView } = renderShell({ studentView: true, teacherUi: false });
    expect(within(group()).getByRole("radio", { name: "Student" })).toBeChecked();
    await userEvent.click(within(group()).getByRole("radio", { name: "Teacher" }));
    expect(onToggleStudentView).toHaveBeenCalledTimes(1);
  });

  it("stays out of a plain student's frame", () => {
    renderShell({ teacherUi: false, canSwitchView: false });
    expect(screen.queryByRole("radiogroup", { name: "View as" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch to student view" })).toBeNull();
  });
});

describe("Shell command palette", () => {
  /** The palette, told apart from the mobile drawer by its own name. */
  const palette = () => screen.queryByRole("dialog", { name: "Command palette" });

  it("opens and closes the palette on Ctrl+K", async () => {
    renderShell();
    expect(palette()).toBeNull();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(palette()).toBeInTheDocument();
    // The caret is in the search field by then, and the shortcut still answers
    // from inside a text field — that is the convention everywhere it exists.
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(palette()).toBeNull();
  });

  it("opens the palette on ⌘+K, for the other half of the room", async () => {
    renderShell();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(palette()).toBeInTheDocument();
  });

  it("leaves Ctrl+Shift+K and Ctrl+Alt+K to the browser", async () => {
    renderShell();
    await userEvent.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    expect(palette()).toBeNull();
    await userEvent.keyboard("{Control>}{Alt>}k{/Alt}{/Control}");
    expect(palette()).toBeNull();
  });

  it("keeps no search trigger in the desktop sidebar", () => {
    renderShell();
    // The sidebar is navigation; the palette answers Ctrl/⌘+K from anywhere,
    // and a permanent button for it was one row of chrome above the nav.
    expect(
      within(sidebar().closest("aside")!).queryByRole("button", { name: /^Search/ }),
    ).toBeNull();
  });

  it("opens the palette from the search button of the mobile top bar", async () => {
    renderShell();
    // A phone has no Ctrl+K, so the top bar keeps its own trigger — and it is
    // now the only "Search" button of the frame.
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(palette()).toBeInTheDocument();
  });

  it("lists the classrooms of the sidebar in the palette", async () => {
    const { navigate } = renderShell();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(
      within(palette()!).getByRole("option", { name: /^Open classroom Classroom 2(?!\d)/ }),
    );
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c2" });
    expect(palette()).toBeNull();
  });
});

/** A screen that answers to two keys while it is on. */
function ScreenWithShortcuts() {
  useShortcuts([
    { keys: "Ctrl+S", label: "Save" },
    { keys: "Ctrl+Shift+P", label: "Publish" },
  ]);
  return <p>Page content</p>;
}

describe("Shell shortcut strip", () => {
  afterEach(() => resetShortcuts());

  /** The strip, named by its own heading. */
  const strip = () => screen.getByText("Shortcuts").closest("div")!;

  it("teaches the palette even when it is the only live shortcut", () => {
    renderShell();
    const caps = within(strip())
      .getAllByRole("listitem")
      .map((el) => el.textContent);
    expect(caps).toEqual([`${modKey()}KCommand palette`]);
    expect(within(strip()).getByText("Command palette")).toBeInTheDocument();
  });

  it("adds what the mounted screen registered, after the palette", () => {
    renderShell({ children: <ScreenWithShortcuts /> });
    const labels = within(strip())
      .getAllByRole("listitem")
      .map((el) => el.textContent);
    expect(labels).toEqual([`${modKey()}KCommand palette`, "CtrlSSave", "CtrlShiftPPublish"]);
  });

  it("splits a combination into one cap per key", () => {
    renderShell({ children: <ScreenWithShortcuts /> });
    const publish = within(strip()).getByText("Publish").closest("li")!;
    expect(within(publish).getAllByText(/^(Ctrl|Shift|P)$/).map((el) => el.tagName)).toEqual([
      "KBD",
      "KBD",
      "KBD",
    ]);
  });

  it("keeps the strip out of the mobile drawer", async () => {
    renderShell({ children: <ScreenWithShortcuts /> });
    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const drawer = screen.getByRole("dialog", { name: "Quiz" });
    expect(within(drawer).queryByText("Shortcuts")).toBeNull();
  });
});

/*
 * The three states the "Question pools" row cycles through (ADR-017):
 * collapsed, the active pool's tree, every pool. The choice is a habit, so it
 * lives in `localStorage` — which is what these tests seed and read back.
 */
describe("Shell pool navigation states", () => {
  const POOLS: PoolSummary[] = [
    {
      ...POOL.pool,
      questionCount: 7,
      role: "owner",
      ownerName: "Prof Démo",
      memberCount: 0,
      updatedAt: "2026-09-18T08:00:00.000Z",
    },
    {
      id: "p2",
      name: "Embedded",
      icon: null,
      visibility: "private",
      ownerId: "u1",
      isPersonal: false,
      createdAt: "2026-01-01T08:00:00.000Z",
      updatedAt: "2026-09-18T08:00:00.000Z",
      questionCount: 4,
      role: "contributor",
      ownerName: "Prof Démo",
      memberCount: 0,
    },
  ];

  afterEach(() => localStorage.removeItem("quiz-pools-nav"));

  const poolsRow = () => within(sidebar()).getByRole("button", { name: "Question pools" });

  it("cycles active → all → collapsed from inside the pool section", async () => {
    renderShell({
      route: { view: "pool", id: "p1" },
      pool: POOL,
      poolList: POOLS,
      path: "/pools/p1",
    });
    // Today's behaviour is the default: the pool being read, with its tree.
    expect(within(sidebar()).getByRole("button", { name: "All questions" })).toBeInTheDocument();
    expect(within(sidebar()).queryByRole("button", { name: /^Embedded/ })).toBeNull();

    await userEvent.click(poolsRow());
    expect(within(sidebar()).getByRole("button", { name: /^Embedded/ })).toBeInTheDocument();
    // The pool being read keeps its folders in the wider list.
    expect(within(sidebar()).getByRole("button", { name: "Arrays" })).toBeInTheDocument();

    await userEvent.click(poolsRow());
    expect(within(sidebar()).queryByRole("button", { name: /^Embedded/ })).toBeNull();
    expect(within(sidebar()).queryByRole("button", { name: "All questions" })).toBeNull();
    expect(poolsRow()).toHaveAttribute("aria-expanded", "false");
  });

  it("remembers the state across a remount", async () => {
    renderShell({ route: { view: "pools" }, poolList: POOLS });
    await userEvent.click(poolsRow());
    expect(localStorage.getItem("quiz-pools-nav")).toBe("all");
  });

  it("navigates, and does not cycle, when the click comes from another section", async () => {
    localStorage.setItem("quiz-pools-nav", "collapsed");
    const { navigate } = renderShell({ route: { view: "home" }, poolList: POOLS });
    await userEvent.click(poolsRow());
    expect(navigate).toHaveBeenCalledWith({ view: "pools" });
    // A collapsed section opens rather than staying shut behind the arrival.
    expect(localStorage.getItem("quiz-pools-nav")).toBe("active");
  });

  it("opens the pool a row of the all-pools list names", async () => {
    localStorage.setItem("quiz-pools-nav", "all");
    const { navigate } = renderShell({ route: { view: "pools" }, poolList: POOLS });
    await userEvent.click(within(sidebar()).getByRole("button", { name: /^Embedded/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "pool", id: "p2" });
  });
});

/*
 * #154: the course → classroom tree under "Courses", cycling like the pools.
 * The flat Classrooms section below lists the same classrooms, so a name is
 * counted in the whole sidebar: one copy there, a second one in the tree.
 */
describe("Shell course tree", () => {
  const COURSES: CourseSummary[] = [
    makeCourseSummary({
      id: "k1",
      code: "PRG1",
      name: "Programmation C",
      classrooms: [
        makeClassroomSummary({ id: "r1", name: "PRG1-2026", courseId: "k1" }),
        makeClassroomSummary({ id: "r2", name: "PRG1-2025", courseId: "k1" }),
      ],
    }),
    makeCourseSummary({
      id: "k2",
      code: "EMB",
      name: "Systèmes embarqués",
      classrooms: [
        makeClassroomSummary({ id: "r3", name: "EMB-2026", courseId: "k2", courseCode: "EMB" }),
      ],
    }),
  ];
  const KEY = "quiz-courses-nav";
  afterEach(() => localStorage.removeItem(KEY));

  const coursesRow = () => within(sidebar()).getByRole("button", { name: "Courses" });
  const copies = (name: string) => within(sidebar()).queryAllByRole("button", { name }).length;

  it("shows the course being read with its classrooms by default", () => {
    renderShell({ courses: COURSES, route: { view: "classroom", id: "r1" } });
    expect(coursesRow()).toHaveAttribute("aria-expanded", "true");
    // The course heads its classrooms and names itself fully to a reader.
    expect(within(sidebar()).getByText("PRG1").parentElement).toHaveAttribute(
      "aria-description",
      "Programmation C",
    );
    // Tree + flat section: the second copy is the tree's, by design.
    expect(copies("PRG1-2025")).toBe(2);
    expect(copies("EMB-2026")).toBe(1);
    expect(within(sidebar()).queryByText("EMB")).toBeNull();
  });

  it("cycles active → all → collapsed from inside the section, without navigating", async () => {
    const { navigate } = renderShell({ courses: COURSES, route: { view: "classroom", id: "r1" } });
    await userEvent.click(coursesRow());
    expect(localStorage.getItem(KEY)).toBe("all");
    // Every course, the one being read unfolded (always: its row is no
    // control), the others folded.
    expect(within(sidebar()).queryByRole("button", { name: "PRG1" })).toBeNull();
    expect(copies("PRG1-2025")).toBe(2);
    expect(within(sidebar()).getByRole("button", { name: "EMB" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(copies("EMB-2026")).toBe(1);

    await userEvent.click(coursesRow());
    expect(localStorage.getItem(KEY)).toBe("collapsed");
    expect(coursesRow()).toHaveAttribute("aria-expanded", "false");
    expect(copies("PRG1-2025")).toBe(1);

    await userEvent.click(coursesRow());
    expect(localStorage.getItem(KEY)).toBe("active");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("counts the course list as inside the section: a click there cycles", async () => {
    localStorage.setItem(KEY, "active");
    const { navigate } = renderShell({ courses: COURSES, route: { view: "home" } });
    await userEvent.click(coursesRow());
    expect(localStorage.getItem(KEY)).toBe("all");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates, and opens a collapsed tree, when the click comes from another section", async () => {
    localStorage.setItem(KEY, "collapsed");
    const { navigate } = renderShell({ courses: COURSES, route: { view: "pools" } });
    await userEvent.click(coursesRow());
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
    expect(localStorage.getItem(KEY)).toBe("active");
  });

  it("navigates without cycling from an evaluation screen, where an open tree stays open", async () => {
    localStorage.setItem(KEY, "all");
    const { navigate } = renderShell({ courses: COURSES, route: { view: "evaluation", id: "e1" } });
    await userEvent.click(coursesRow());
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
    expect(localStorage.getItem(KEY)).toBe("all");
  });

  it("unfolds another course on demand in all, and opens a classroom from it", async () => {
    localStorage.setItem(KEY, "all");
    const { navigate } = renderShell({ courses: COURSES, route: { view: "home" } });
    const emb = within(sidebar()).getByRole("button", { name: "EMB" });
    expect(emb).toHaveAttribute("aria-description", "Systèmes embarqués");
    await userEvent.click(emb);
    expect(emb).toHaveAttribute("aria-expanded", "true");
    expect(copies("EMB-2026")).toBe(2);
    await userEvent.click(within(sidebar()).getAllByRole("button", { name: "EMB-2026" })[0]!);
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r3" });
    await userEvent.click(emb);
    expect(emb).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a course unfolded once the classroom opened from it is the page", async () => {
    // A frame whose route really follows `navigate`, as the app's does.
    function Routed() {
      const [route, setRoute] = useState<Route>({ view: "classroom", id: "r1" });
      return (
        <Shell me={makeMe()} route={route} navigate={setRoute} teacherUi studentView={false}>
          <p>Page content</p>
        </Shell>
      );
    }
    localStorage.setItem(KEY, "all");
    const queryClient = makeQueryClient();
    queryClient.setQueryData(["courses"], COURSES);
    renderWithProviders(<Routed />, { queryClient });
    await userEvent.click(within(sidebar()).getByRole("button", { name: "EMB" }));
    await userEvent.click(within(sidebar()).getAllByRole("button", { name: "EMB-2026" })[0]!);
    // EMB is now the course being read: still unfolded, its classroom current.
    expect(copies("EMB-2026")).toBe(2);
    for (const row of within(sidebar()).getAllByRole("button", { name: "EMB-2026" })) {
      expect(row).toHaveAttribute("aria-current", "page");
    }
    // And PRG1, no longer read nor opened by a click, folds back.
    expect(within(sidebar()).getByRole("button", { name: "PRG1" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("leaves a hidden course out of all (#155)", () => {
    localStorage.setItem(KEY, "all");
    renderShell({ courses: [COURSES[0]!, { ...COURSES[1]!, hidden: true }], route: { view: "home" } });
    expect(within(sidebar()).getByRole("button", { name: "PRG1" })).toBeVisible();
    expect(within(sidebar()).queryByRole("button", { name: "EMB" })).toBeNull();
  });

  it("keeps a hidden course in the tree while one of its classrooms is the page", () => {
    localStorage.setItem(KEY, "all");
    renderShell({
      courses: [COURSES[0]!, { ...COURSES[1]!, hidden: true }],
      route: { view: "classroom", id: "r3" },
    });
    // The tree says where the reader is before it offers where to go.
    expect(within(sidebar()).getByText("EMB")).toBeVisible();
  });

  it("is teacher UI only", () => {
    localStorage.setItem(KEY, "all");
    renderShell({ courses: COURSES, teacherUi: false, me: makeMe({ role: "student" }) });
    expect(within(sidebar()).getByRole("button", { name: "Home" })).not.toHaveAttribute(
      "aria-expanded",
    );
    expect(within(sidebar()).queryByRole("button", { name: "PRG1" })).toBeNull();
  });
});
