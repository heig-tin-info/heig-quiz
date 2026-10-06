import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CourseSummary } from "@quiz/contracts";

import { makeClassroomSummary, makeCourseSummary, makeMe } from "../test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { CoursePage } from "./CoursePage";

/*
 * The page of one course (F-ORG-12), in tabs: its classrooms, its templates,
 * its linked pools, its members and its settings, each tab with ONE primary
 * action in the header (none on Settings). The templates tab is the one
 * surface that lists them, so it says where the door is when empty.
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
  it("opens on the course's classrooms, with its five tabs under its name", async () => {
    mockFetch(world());
    const navigate = vi.fn();
    renderWithProviders(<CoursePage id="c1" navigate={navigate} />);

    expect(await screen.findByRole("heading", { level: 1, name: /Programmation C/ })).toBeVisible();
    const tabs = screen.getByRole("tablist", { name: "Course sections" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      expect.stringMatching(/^Classrooms/),
      expect.stringMatching(/^Templates/),
      expect.stringMatching(/^Linked pools/),
      expect.stringMatching(/^Members/),
      "Settings",
    ]);
    expect(within(tabs).getByRole("tab", { name: /Classrooms/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("24 students")).toBeVisible();

    // The archived classroom waits behind its toggle, as on the card.
    await userEvent.click(await screen.findByRole("button", { name: /Show archived \(1\)/ }));
    await userEvent.click(screen.getByRole("button", { name: /PRG1-2024/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r0" });

    // A tab is an address of its own.
    await userEvent.click(within(tabs).getByRole("tab", { name: /Members/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "course", id: "c1", tab: "members" });

    // The trail: the Courses home, then the course as the current page.
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByText("PRG1")).toHaveAttribute("aria-current", "page");
    await userEvent.click(within(trail).getByRole("link", { name: "Courses" }));
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
  });

  it.each([
    ["classrooms", "New classroom"],
    ["templates", "New template"],
    ["pools", "Link a pool"],
    ["members", "Add a staff member"],
  ] as const)("has one primary action on %s: %s", async (tab, label) => {
    mockFetch(world());
    renderWithProviders(<CoursePage id="c1" tab={tab} navigate={vi.fn()} />);

    await screen.findByRole("heading", { level: 1, name: /Programmation C/ });
    const accented = screen.getAllByRole("button").filter((b) => /bg-accent\b/.test(b.className));
    expect(accented.map((b) => b.textContent?.trim())).toEqual([label]);
  });

  it("has no primary action on its settings", async () => {
    mockFetch(world());
    renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

    await screen.findByRole("heading", { level: 1, name: /Programmation C/ });
    expect(screen.getAllByRole("button").filter((b) => /bg-accent\b/.test(b.className))).toEqual([]);
  });

  it("opens a new classroom from the header", async () => {
    mockFetch(world());
    renderWithProviders(<CoursePage id="c1" navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: /New classroom/ }));
    expect(await screen.findByRole("dialog", { name: "New classroom" })).toBeVisible();
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

  it("lists the templates, and names the door in when there is none", async () => {
    mockFetch(world([]));
    renderWithProviders(<CoursePage id="c1" tab="templates" navigate={vi.fn()} />);

    expect(await screen.findByText("No template yet")).toBeVisible();
    expect(screen.getByText(/“New template”, or .* “Save as template” in its menu/)).toBeVisible();
    // The empty state's action, beside the header's.
    expect(screen.getAllByRole("button", { name: /New template/ })).toHaveLength(2);
  });

  it("creates an empty template from the header, then opens its editor (F-EVAL-24)", async () => {
    const { calls } = mockFetch({
      ...world([]),
      "POST /app/api/courses/c1/templates": ok({ ...TEMPLATE, id: "t9", itemCount: 0, totalPoints: 0, revision: 1 }),
    });
    const navigate = vi.fn();
    renderWithProviders(<CoursePage id="c1" tab="templates" navigate={navigate} />);

    await userEvent.click((await screen.findAllByRole("button", { name: /New template/ }))[0]!);
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
    renderWithProviders(<CoursePage id="c1" tab="templates" navigate={navigate} />);

    await userEvent.click(await screen.findByRole("button", { name: /Final exam/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "template", id: "t1" });
    expect(screen.getByRole("button", { name: "Use in a classroom" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete template" })).toBeVisible();
  });

  it("links a pool from the header's menu, with no dialog in the way", async () => {
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
    renderWithProviders(<CoursePage id="c1" tab="pools" navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Link a pool" }));
    // A pool the teacher only reads is not offered: linking it is refused (ADR-013).
    expect(screen.queryByRole("menuitem", { name: "Colleague's public pool" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Pointers" }));
    // `PUT` replaces the WHOLE set, which is the only route there is.
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { url: "/app/api/courses/c1/pools", method: "PUT", body: { poolIds: ["p1"] } },
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
      "GET /app/api/courses/c1/templates": ok([]),
    });
    renderWithProviders(<CoursePage id="c1" tab="pools" navigate={vi.fn()} />);

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

  it("lists the members with their roles, changes one, removes one and adds one by address", async () => {
    const staff: CourseSummary["staff"] = [
      { userId: "u-1", givenName: "Marie", familyName: "Dupont", email: "marie.dupont@heig-vd.ch", avatarUrl: null, role: "owner" },
      { userId: "u-2", givenName: "Paul", familyName: "Martin", email: "paul.martin@heig-vd.ch", avatarUrl: null, role: "assistant" },
    ];
    const { calls } = mockFetch({
      ...world(),
      [`GET ${COURSES}`]: ok([makeCourseSummary({ staff })]),
      "POST /app/api/courses/c1/staff": ok({ userId: "u-3", role: "assistant" }),
      "PATCH /app/api/courses/c1/staff/u-2": ok({ userId: "u-2", role: "owner" }),
      "DELETE /app/api/courses/c1/staff/u-2": noContent(),
    });
    renderWithProviders(<CoursePage id="c1" tab="members" navigate={vi.fn()} />);

    expect(await screen.findByText("Marie Dupont")).toBeVisible();
    expect(screen.getByText("paul.martin@heig-vd.ch")).toBeVisible();
    expect(screen.getByText("Owner")).toBeVisible();
    expect(screen.getByText("Assistant")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Make owner" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH")).toEqual([
        { url: "/app/api/courses/c1/staff/u-2", method: "PATCH", body: { role: "owner" } },
      ]),
    );

    await userEvent.click(screen.getByRole("button", { name: "Remove from the staff" }));
    const confirm = await screen.findByRole("dialog", { name: /Remove Paul Martin/ });
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove from the staff" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "DELETE")).toEqual([
        { url: "/app/api/courses/c1/staff/u-2", method: "DELETE", body: null },
      ]),
    );

    await userEvent.click(screen.getByRole("button", { name: /Add a staff member/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a staff member" });
    await userEvent.type(within(dialog).getByRole("textbox"), "anne.roux@heig-vd.ch");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        {
          url: "/app/api/courses/c1/staff",
          method: "POST",
          body: { email: "anne.roux@heig-vd.ch", role: "assistant" },
        },
      ]),
    );
  });

  it("adds an owner when the form says so, and words a second seat", async () => {
    const { calls } = mockFetch({
      ...world(),
      "POST /app/api/courses/c1/staff": fail(409, { error: "already_staff", message: "x" }),
    });
    renderWithProviders(<CoursePage id="c1" tab="members" navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: /Add a staff member/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a staff member" });
    await userEvent.type(within(dialog).getByRole("textbox"), "marie.dupont@heig-vd.ch");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Owner" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText("This person is already on the staff of the course.")).toBeVisible();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { email: "marie.dupont@heig-vd.ch", role: "owner" },
    ]);
  });

  it("offers nothing that would leave the course without an owner", async () => {
    mockFetch(world());
    renderWithProviders(<CoursePage id="c1" tab="members" navigate={vi.fn()} />);

    expect(await screen.findByText("Marie Dupont")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove from the staff" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make assistant" })).toBeNull();
  });

  describe("for an assistant (ADR-068)", () => {
    const staff: CourseSummary["staff"] = [
      { userId: "u-1", givenName: "Marie", familyName: "Dupont", email: "marie.dupont@heig-vd.ch", avatarUrl: null, role: "assistant" },
      { userId: "u-2", givenName: "Paul", familyName: "Martin", email: "paul.martin@heig-vd.ch", avatarUrl: null, role: "owner" },
    ];
    const assistantWorld = () => ({
      ...world(),
      "GET /app/api/me": ok(makeMe()),
      [`GET ${COURSES}`]: ok([
        makeCourseSummary({
          staff,
          myRole: "assistant",
          classrooms: [makeClassroomSummary({ id: "r1", name: "PRG1-2026", students: 24 })],
        }),
      ]),
    });

    it("offers no header action but New template", async () => {
      mockFetch(assistantWorld());
      for (const tab of ["classrooms", "pools", "members"] as const) {
        const { unmount } = renderWithProviders(<CoursePage id="c1" tab={tab} navigate={vi.fn()} />);
        await screen.findByRole("heading", { level: 1, name: /Programmation C/ });
        expect(screen.queryByRole("button", { name: /New classroom/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /Link a pool/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /Add a staff member/ })).toBeNull();
        unmount();
      }
      renderWithProviders(<CoursePage id="c1" tab="templates" navigate={vi.fn()} />);
      expect(await screen.findByRole("button", { name: /New template/ })).toBeVisible();
    });

    it("lists the pools without their unlink", async () => {
      mockFetch(assistantWorld());
      renderWithProviders(<CoursePage id="c1" tab="pools" navigate={vi.fn()} />);
      expect(await screen.findByText("Pointers")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Unlink from this course" })).toBeNull();
    });

    it("offers only their own leaving among the members, then goes home", async () => {
      const { calls } = mockFetch({
        ...assistantWorld(),
        "DELETE /app/api/courses/c1/staff/u-1": noContent(),
      });
      const navigate = vi.fn();
      renderWithProviders(<CoursePage id="c1" tab="members" navigate={navigate} />);

      await userEvent.click(await screen.findByRole("button", { name: "Leave the course" }));
      expect(screen.queryByRole("button", { name: "Remove from the staff" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Make (owner|assistant)/ })).toBeNull();
      const confirm = await screen.findByRole("dialog", { name: /Leave the staff of/ });
      await userEvent.click(within(confirm).getByRole("button", { name: "Leave the course" }));
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "home" }));
      expect(calls.filter((c) => c.method === "DELETE")).toEqual([
        { url: "/app/api/courses/c1/staff/u-1", method: "DELETE", body: null },
      ]);
    });

    it("shows only the visibility in the settings, and says why", async () => {
      mockFetch(assistantWorld());
      renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

      expect(await screen.findByRole("button", { name: /Hide for me/ })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Delete course/ })).toBeNull();
      expect(screen.getByText(/are its owners' to change/)).toBeVisible();
    });
  });

  it("edits the name and the code in its settings, sending only what changed", async () => {
    let course = { name: "Programmation C", code: "PRG1" };
    const { calls } = mockFetch({
      ...world(),
      [`GET ${COURSES}`]: () => ok([makeCourseSummary({ ...course, classrooms: [] })]),
      "PATCH /app/api/courses/c1": (call) => {
        course = { ...course, ...(call.body as object) };
        return ok({ id: "c1", ...course });
      },
    });
    renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

    // The header shows the name; it no longer edits it.
    await screen.findByRole("heading", { level: 1, name: /Programmation C/ });
    expect(screen.queryByRole("button", { name: /^Rename course/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the course" });
    const code = within(dialog).getByRole("textbox", { name: /^Code/ });
    await userEvent.clear(code);
    await userEvent.type(code, "prg2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { url: "/app/api/courses/c1", method: "PATCH", body: { code: "PRG2" } },
    ]);
    expect(await screen.findByText("PRG2 — Programmation C")).toBeVisible();
  });

  it("says a code another course holds, in the dialog", async () => {
    mockFetch({
      ...world(),
      "PATCH /app/api/courses/c1": fail(409, { error: "duplicate_code", message: "A course already uses this code" }),
    });
    renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the course" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Code/ }), "X");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Another course already uses this code.")).toBeVisible();
  });

  it("hides the course for its reader from its settings", async () => {
    const { calls } = mockFetch({ ...world(), "POST /app/api/courses/c1/hide": noContent() });
    renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: /Hide for me/ }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        { url: "/app/api/courses/c1/hide", method: "POST", body: null },
      ]),
    );
  });

  it("deletes the course from its settings, naming its templates, then leaves for the home", async () => {
    const { calls } = mockFetch({
      ...world(),
      "DELETE /app/api/courses/c1": noContent(),
    });
    const navigate = vi.fn();
    renderWithProviders(<CoursePage id="c1" tab="settings" navigate={navigate} />);

    await userEvent.click(await screen.findByRole("button", { name: /Delete course/ }));
    const dialog = await screen.findByRole("dialog", { name: /and its evaluation template\./ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "home" }));
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([
      { url: "/app/api/courses/c1", method: "DELETE", body: null },
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
});
