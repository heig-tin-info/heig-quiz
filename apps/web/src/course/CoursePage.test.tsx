import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CourseSummary } from "@quiz/contracts";

import { candidatesFor } from "../test/candidates";
import { flowingClock } from "../test/clock";
import { makeClassroomSummary, makeCourseSummary, makeMe } from "../test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { CoursePage } from "./CoursePage";

/*
 * The page of one course (F-ORG-12), in tabs: its classrooms, its templates,
 * its linked pools, its members and its settings (which hold its catalog of
 * conditions, F-ORG-16), each tab with ONE primary action in the header
 * (none on Settings). The templates tab is the one
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

const CONDITIONS = [
  { id: "k1", kind: "allowed", text: "One A4 sheet of notes", archivedAt: null },
  { id: "k2", kind: "forbidden", text: "Phones", archivedAt: null },
  { id: "k0", kind: "info", text: "Bring your student card", archivedAt: "2026-02-01T08:00:00.000Z" },
];

/** A concept as the vocabulary lists it, and as a course lists it. */
const vocabulary = (id: string, en: string, fr: string) => ({
  id,
  status: "validated",
  mergedInto: null,
  labels: { en, fr },
  qualifiers: { en: "", fr: "" },
  descriptions: { en: "", fr: "" },
  aliases: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
});
const POINTER = vocabulary("c0c0c0c0-0000-4000-8000-000000000001", "Pointer", "Pointeur");
const ARRAY = vocabulary("c0c0c0c0-0000-4000-8000-000000000002", "Array", "Tableau");
const ref = (c: typeof POINTER) => ({ id: c.id, label: c.labels.en, qualifier: "", status: c.status });
const POINTER_REF = ref(POINTER);

const STAFF_CANDIDATES = "/app/api/courses/c1/staff/candidates";

function world(templates: unknown[] = [TEMPLATE]) {
  return {
    [`GET ${COURSES}`]: ok([
      makeCourseSummary({
        classrooms: [makeClassroomSummary({ id: "r1", name: "PRG1-2026", students: 24 })],
      }),
    ]),
    "GET /app/api/courses/c1": ok({ ...DETAIL, concepts: [POINTER_REF] }),
    "GET /app/api/courses/c1/templates": ok(templates),
    "GET /app/api/pools": ok([]),
    "GET /app/api/courses/c1/conditions": ok(CONDITIONS),
    "GET /app/api/concepts": ok({ concepts: [POINTER, ARRAY] }),
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
          isPublic: true,
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
    // A public pool the teacher only reads is offered read-only (ADR-095): editing it is refused (ADR-013).
    expect(screen.queryByRole("menuitem", { name: "Colleague's public pool" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Colleague's public pool (read-only)" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "Pointers" }));
    // `PUT` replaces the WHOLE set, which is the only route there is.
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { url: "/app/api/courses/c1/pools", method: "PUT", body: { pools: [{ poolId: "p1", mode: "edit" }] } },
    ]);
  });

  it("links a colleague's public pool read-only and keeps the modes of the links already there", async () => {
    const { calls } = mockFetch({
      [`GET ${COURSES}`]: ok([makeCourseSummary()]),
      "GET /app/api/courses/c1": ok({
        course: { id: "c1", name: "Programmation C", code: "PRG1" },
        staff: [],
        pools: [{ id: "p1", name: "Pointers", questionCount: 7, mode: "read" }],
        classrooms: [],
      }),
      "GET /app/api/pools": ok([
        {
          id: "p2",
          name: "Colleague's public pool",
          visibility: "public",
          isPublic: true,
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
    await userEvent.click(screen.getByRole("menuitem", { name: "Colleague's public pool (read-only)" }));
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      {
        url: "/app/api/courses/c1/pools",
        method: "PUT",
        body: {
          pools: [
            { poolId: "p1", mode: "read" },
            { poolId: "p2", mode: "read" },
          ],
        },
      },
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
      { url: "/app/api/courses/c1/pools", method: "PUT", body: { pools: [] } },
    ]);
  });

  it("lists the members with their roles, changes one, removes one and adds one by address", async () => {
    const user = flowingClock();
    const staff: CourseSummary["staff"] = [
      { userId: "u-1", givenName: "Marie", familyName: "Dupont", email: "marie.dupont@heig-vd.ch", avatarUrl: null, role: "owner" },
      { userId: "u-2", givenName: "Paul", familyName: "Martin", email: "paul.martin@heig-vd.ch", avatarUrl: null, role: "assistant" },
    ];
    const { calls } = mockFetch({
      ...world(),
      [`GET ${COURSES}`]: ok([makeCourseSummary({ staff })]),
      ...candidatesFor(STAFF_CANDIDATES, "Anne.Roux@heig-vd.ch", []),
      "POST /app/api/courses/c1/staff": ok({ userId: "u-3", role: "assistant" }),
      "PATCH /app/api/courses/c1/staff/u-2": ok({ userId: "u-2", role: "owner" }),
      "DELETE /app/api/courses/c1/staff/u-2": noContent(),
    });
    renderWithProviders(<CoursePage id="c1" tab="members" navigate={vi.fn()} />);

    expect(await screen.findByText("Marie Dupont")).toBeVisible();
    expect(screen.getByText("paul.martin@heig-vd.ch")).toBeVisible();
    expect(screen.getByText("Teacher")).toBeVisible();
    expect(screen.getByText("Assistant")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Make teacher" }));
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

    await user.click(screen.getByRole("button", { name: /Add a staff member/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a staff member" });
    // A typed address nobody was picked from is still sent, as an address.
    await user.type(within(dialog).getByRole("combobox", { name: "Person" }), "Anne.Roux@heig-vd.ch");
    expect(await within(dialog).findByText("No teacher matches “Anne.Roux@heig-vd.ch”.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
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

  it("adds a teacher picked by name, by account", async () => {
    const user = flowingClock();
    const grace = { userId: "t2", email: "grace.hopper@heig-vd.ch", givenName: "Grace", familyName: "Hopper" };
    const { calls } = mockFetch({
      ...world(),
      ...candidatesFor(STAFF_CANDIDATES, "gra", [grace]),
      "POST /app/api/courses/c1/staff": ok({ userId: "t2", role: "owner" }),
    });
    renderWithProviders(<CoursePage id="c1" tab="members" navigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Add a staff member/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a staff member" });
    const field = within(dialog).getByRole("combobox", { name: "Person" });
    // Nothing typed yet: nothing picked, nothing to send.
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeDisabled();
    await user.type(field, "gra");
    await user.click(await screen.findByRole("option", { name: /Grace Hopper/ }));
    expect(field).toHaveValue("Grace Hopper");
    expect(within(dialog).getByText("grace.hopper@heig-vd.ch")).toBeVisible();
    // An assistant unless the form says otherwise.
    expect(within(dialog).getByRole("radio", { name: "Assistant" })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "Teacher" }));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ userId: "t2", role: "owner" }]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a staff member" })).toBeNull());
  });

  it.each([
    ["already_staff", "This person is already on the staff of the course."],
    ["unknown_account", "No account has signed in with this address yet."],
    ["ambiguous_account", /Several accounts hold this address/],
  ] as const)("words the refusal %s in the dialog", async (code, message) => {
    const user = flowingClock();
    mockFetch({
      ...world(),
      ...candidatesFor(STAFF_CANDIDATES, "marie.dupont@heig-vd.ch", []),
      "POST /app/api/courses/c1/staff": fail(409, { error: code, message: "x" }),
    });
    renderWithProviders(<CoursePage id="c1" tab="members" navigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Add a staff member/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a staff member" });
    await user.type(within(dialog).getByRole("combobox", { name: "Person" }), "marie.dupont@heig-vd.ch");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText(message)).toBeVisible();
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
      expect(screen.queryByRole("button", { name: /Make (teacher|assistant)/ })).toBeNull();
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
      expect(screen.getByText(/are its teachers' to change/)).toBeVisible();
    });

    it("reads the catalog of conditions without its controls, and says why (F-ORG-16)", async () => {
      mockFetch(assistantWorld());
      renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

      expect(await screen.findByText("Phones")).toBeVisible();
      expect(screen.getByText("One A4 sheet of notes")).toBeVisible();
      expect(screen.queryByRole("textbox", { name: /Condition/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Add condition/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Actions on/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Show archived/ })).toBeNull();
      expect(screen.getByText(/The catalog is the course teachers' to change/)).toBeVisible();
    });
  });

  describe("its concepts, in its settings (ADR-081 §8)", () => {
    it("lets an owner pick a concept, saves the whole set, and says only teachers see it", async () => {
      const { calls } = mockFetch({
        ...world(),
        "PUT /app/api/courses/c1/concepts": ok({ concepts: [ref(ARRAY), POINTER_REF] }),
      });
      renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

      expect(await screen.findByRole("heading", { name: "Concepts" })).toBeVisible();
      expect(await screen.findByText("Pointer")).toBeVisible();
      expect(await screen.findByText(/Only its teachers see this list; students never do/)).toBeVisible();

      const field = screen.getByRole("combobox", { name: "Add a concept" });
      await userEvent.type(field, "Arr");
      await userEvent.click(await screen.findByRole("option", { name: /Array/ }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === "PUT" && c.url === "/app/api/courses/c1/concepts")?.body).toEqual({
          conceptIds: [POINTER.id, ARRAY.id],
        }),
      );
    });

    it("lets an assistant read the list as plain text, without its controls, and says why", async () => {
      const staff = [
        { userId: "u-1", givenName: "Ada", familyName: "Lovelace", email: "ada@heig-vd.ch", avatarUrl: null, role: "assistant" },
        { userId: "u-2", givenName: "Paul", familyName: "Martin", email: "paul.martin@heig-vd.ch", avatarUrl: null, role: "owner" },
      ];
      mockFetch({
        ...world(),
        "GET /app/api/me": ok(makeMe()),
        [`GET ${COURSES}`]: ok([makeCourseSummary({ staff, myRole: "assistant" } as Partial<CourseSummary>)]),
      });
      renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

      expect(await screen.findByRole("heading", { name: "Concepts" })).toBeVisible();
      expect(await screen.findByText("Pointer")).toBeVisible();
      expect(screen.queryByRole("combobox", { name: "Add a concept" })).toBeNull();
      expect(screen.getByText("The list is the course teachers' to change.")).toBeVisible();
    });
  });

  describe("its catalog of conditions, in its settings (F-ORG-16)", () => {
    it("lists the active entries, keeps the archived ones collapsed, and says the snapshot rule", async () => {
      const { calls } = mockFetch({
        ...world(),
        "POST /app/api/courses/c1/conditions/k0/unarchive": ok(CONDITIONS[2]),
      });
      renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

      expect(await screen.findByRole("textbox", { name: "Condition 1" })).toHaveValue("One A4 sheet of notes");
      expect(screen.getByRole("textbox", { name: "Condition 2" })).toHaveValue("Phones");
      expect(screen.queryByText("Bring your student card")).toBeNull();
      expect(screen.getByText(/never changes the evaluations and templates that already exist/)).toBeVisible();

      await userEvent.click(screen.getByRole("button", { name: /Show archived \(1\)/ }));
      expect(screen.getByText("Bring your student card")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: /Restore/ }));
      await waitFor(() =>
        expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/k0/unarchive"))).toBe(true),
      );
    });

    it("adds an entry from its section, edits one, moves one and archives one", async () => {
      const { calls } = mockFetch({
        ...world(),
        "POST /app/api/courses/c1/conditions": ok(CONDITIONS[0]),
        "PATCH /app/api/courses/c1/conditions/k2": ok(CONDITIONS[1]),
        "PUT /app/api/courses/c1/conditions/order": noContent(),
        "POST /app/api/courses/c1/conditions/k1/archive": ok(CONDITIONS[0]),
      });
      renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);

      await userEvent.click(await screen.findByRole("button", { name: /Add condition/ }));
      const dialog = await screen.findByRole("dialog", { name: "Add condition" });
      await userEvent.click(within(dialog).getByRole("radio", { name: "Provided" }));
      await userEvent.type(within(dialog).getByRole("textbox", { name: /Condition/ }), "  A formula sheet ");
      await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === "POST" && c.url === "/app/api/courses/c1/conditions")?.body).toEqual({
          kind: "provided",
          text: "A formula sheet",
        }),
      );

      const phones = screen.getByRole("textbox", { name: "Condition 2" });
      await userEvent.type(phones, " and watches");
      await userEvent.tab();
      await waitFor(() =>
        expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ kind: "forbidden", text: "Phones and watches" }),
      );

      await userEvent.click(screen.getByRole("button", { name: "Actions on “One A4 sheet of notes”" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
      await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ ids: ["k2", "k1"] }));

      await userEvent.click(screen.getByRole("button", { name: "Actions on “One A4 sheet of notes”" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
      await waitFor(() =>
        expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/k1/archive"))).toBe(true),
      );
    });

    it("says so when the catalog is empty", async () => {
      mockFetch({ ...world(), "GET /app/api/courses/c1/conditions": ok([]) });
      renderWithProviders(<CoursePage id="c1" tab="settings" navigate={vi.fn()} />);
      expect(await screen.findByText(/No conditions yet/)).toBeVisible();
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
    const code = within(dialog).getByRole("textbox", { name: /^Course code/ });
    await userEvent.clear(code);
    await userEvent.type(code, "prg2");
    // The preview shows the code as the sidebar will: trimmed and upper-cased.
    expect(within(dialog).getByText("PRG2 · Programmation C")).toBeVisible();
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
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Course code/ }), "X");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Another course already uses this code. Make it more specific, e.g. PRG1-IL.")).toBeVisible();
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
