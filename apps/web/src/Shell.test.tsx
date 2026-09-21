import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CourseSummary, PoolDetail } from "@quiz/contracts";

import { Shell } from "./Shell";
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
  pool,
  path,
}: {
  route?: Route;
  courses?: CourseSummary[];
  teacherUi?: boolean;
  studentView?: boolean;
  me?: ReturnType<typeof makeMe>;
  navigate?: (r: Route) => void;
  onToggleStudentView?: () => void;
  /** Seeds the pool the sidebar unfolds on a `pool` route. */
  pool?: PoolDetail;
  /** URL the frame reads `?category=` from. */
  path?: string;
} = {}) {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(["courses"], courses);
  if (pool) queryClient.setQueryData(["pool", pool.pool.id], pool);
  renderWithProviders(
    <Shell
      me={me}
      route={route}
      navigate={navigate}
      teacherUi={teacherUi}
      studentView={studentView}
      onToggleStudentView={onToggleStudentView}
    >
      <p>Page content</p>
    </Shell>,
    { queryClient, ...(path ? { route: path } : {}) },
  );
  return { navigate, onToggleStudentView };
}

/** The sidebar of the desktop layout (the drawer renders the same nav). */
const sidebar = () => screen.getAllByRole("navigation")[0]!;

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
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: /^Classroom 2(?!\d)/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.getByRole("button", { name: /^Classroom 1(?!\d)/ })).not.toHaveAttribute("aria-current");
    // The classroom page is not the home page.
    expect(nav.getByRole("button", { name: "Courses" })).not.toHaveAttribute("aria-current");
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
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: /^Classroom 25(?!\d)/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.queryByRole("button", { name: /^Classroom 24(?!\d)/ })).toBeNull();
  });

  it("shows the student navigation, with no classroom list, outside the teacher UI", () => {
    renderShell({ teacherUi: false, me: makeMe({ role: "student" }) });
    const nav = within(sidebar());
    // WP9: "Home" is the student heading; the teacher sections are gone.
    expect(nav.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(nav.queryByRole("button", { name: /^Classroom 1(?!\d)/ })).toBeNull();
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
    expect(nav.getByRole("button", { name: /New category/ })).toBeInTheDocument();
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

  it("keeps every edit of a category in its overflow menu", async () => {
    renderShell({ route: { view: "pool", id: "p1" }, pool: POOL, path: "/pools/p1" });
    await userEvent.click(within(sidebar()).getAllByRole("button", { name: "Actions" })[0]!);
    const menu = within(screen.getByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Rename category" })).toBeVisible();
    expect(menu.getByRole("menuitem", { name: "New subcategory" })).toBeVisible();
    expect(menu.getByRole("menuitem", { name: "Move up" })).toBeVisible();
    expect(menu.getByRole("menuitem", { name: "Move down" })).toBeVisible();
    expect(menu.getByRole("menuitem", { name: "Delete category" })).toBeVisible();
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
    expect(screen.getByText("You are viewing the portal as a student.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to teacher view" }));
    expect(onToggleStudentView).toHaveBeenCalledTimes(1);
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
