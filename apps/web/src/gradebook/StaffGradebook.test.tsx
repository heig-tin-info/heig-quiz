import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { GradebookStaff } from "@quiz/contracts";

import { fail, makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { StaffGradebook } from "./StaffGradebook";

/*
 * The staff's Grades tab (F-GBOOK-01, -02, -05, -06, M5-04): the matrix as the
 * server's table says it — a grade, the absence sigil `a1.0` (its own colour,
 * never a grade's), a dash, a column not released marked and out of the mean —
 * and each write it sends: an absence, a score, a cleared mark, the override
 * a `409 grade_exists` asks for, a column's weight and counted flag, the
 * published mean; a refusal worded, an archived classroom read-only.
 */

const ROOM = "0190d3c4-0000-7000-8000-0000000000a1";
const TEST = "0190d3c4-0000-7000-8000-0000000000c1";
const EXERCISE = "0190d3c4-0000-7000-8000-0000000000c2";
const LATER = "0190d3c4-0000-7000-8000-0000000000c3";
const ALICE = "0190d3c4-0000-7000-8000-0000000000e1";
const BOB = "0190d3c4-0000-7000-8000-0000000000e2";
const URL_TABLE = `/app/api/classrooms/${ROOM}/gradebook`;
const URL_MARK = (column: string, eid: string) => `${URL_TABLE}/columns/evaluation/${column}/marks/${eid}`;
const URL_COLUMN = (column: string) => `${URL_TABLE}/columns/evaluation/${column}`;

const empty = { kind: "empty", grade: null, points: null, max: null, source: null, changedAfterRelease: false, hasGrade: false, mark: null } as const;

function makeTable(over: Partial<GradebookStaff> = {}): GradebookStaff {
  return GradebookStaff.parse({
    classroomId: ROOM,
    archived: false,
    meanPublished: false,
    components: [],
    columns: [
      { kind: "evaluation", activityId: TEST, mode: "exam", title: "Test 1", date: "2026-09-10T08:00:00.000Z", released: true, weight: 100, counts: true, position: null, componentId: null, classMean: 3.3 },
      { kind: "evaluation", activityId: EXERCISE, mode: "exercise", title: "Exercises", date: "2026-09-20T08:00:00.000Z", released: true, weight: 100, counts: false, position: null, componentId: null, classMean: null },
      { kind: "evaluation", activityId: LATER, mode: "exam", title: "Test 2", date: "2026-10-01T08:00:00.000Z", released: false, weight: 40, counts: true, position: null, componentId: null, classMean: null },
    ],
    rows: [
      {
        enrollmentId: ALICE,
        email: "alice.dupont@heig-vd.ch",
        nom: "Dupont",
        prenom: "Alice",
        mean: 5.5,
        componentMeans: {},
        cells: {
          [TEST]: { ...empty, kind: "grade", grade: 5.5, points: 18, max: 20, source: "results", hasGrade: true },
          [EXERCISE]: empty,
          [LATER]: empty,
        },
      },
      {
        enrollmentId: BOB,
        email: "bob.favre@heig-vd.ch",
        nom: "Favre",
        prenom: "Bob",
        mean: 1,
        componentMeans: {},
        cells: {
          [TEST]: { ...empty, kind: "absent", grade: 1, source: "derived" },
          [EXERCISE]: empty,
          [LATER]: empty,
        },
      },
    ],
    classMean: 3.3,
    ...over,
  });
}

function renderTab(table: GradebookStaff | ReturnType<typeof fail>, extra: Parameters<typeof mockFetch>[0] = {}) {
  const fetched = mockFetch({ [`GET ${URL_TABLE}`]: "classroomId" in table ? ok(table) : table, ...extra });
  renderWithProviders(<StaffGradebook classroomId={ROOM} />, { queryClient: makeQueryClient() });
  return fetched;
}

const cell = (student: string, column: string) => screen.findByRole("button", { name: `Marks for ${student}, ${column}` });
/** The exercises left out of the mean are hidden by default; the fixture's "Exercises" is one. */
const showExercises = async () => userEvent.click(await screen.findByRole("switch", { name: "Show exercises" }));
const choose = async (button: HTMLElement, item: string) => {
  await userEvent.click(button);
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
};

describe("the matrix", () => {
  it("draws a row per student and a column per activity: a grade, the absence sigil in its own colour, dashes, the mean", async () => {
    renderTab(makeTable());
    await showExercises();
    const alice = await cell("Alice Dupont", "Test 1");
    expect(alice).toHaveTextContent("5.5");
    const absent = await cell("Bob Favre", "Test 1");
    const sigil = within(absent).getByText("a1.0");
    // The sigil wears `info`, a real 1.0 would wear `danger`: they never read alike.
    expect(sigil.className).toContain("text-info");
    expect(sigil.className).not.toContain("text-danger");
    expect(within(await cell("Alice Dupont", "Exercises")).getByText("—")).toBeInTheDocument();
    // The mean, last.
    const row = screen.getByRole("row", { name: /Alice Dupont/ });
    expect(within(row).getAllByRole("cell").at(-1)).toHaveTextContent("5.5");
    // The legend says what a1.0 is.
    expect(screen.getByText(/a1\.0 is an absence/)).toBeInTheDocument();
  });

  it("marks a column not released and one that does not count, with its weight", async () => {
    renderTab(makeTable());
    await showExercises();
    await cell("Alice Dupont", "Test 2");
    const later = screen.getByRole("columnheader", { name: /Test 2/ });
    expect(within(later).getByText("Not released")).toBeInTheDocument();
    expect(within(later).getByText(/40 %/)).toBeInTheDocument();
    expect(within(screen.getByRole("columnheader", { name: /Exercises/ })).getByText(/Not counted/)).toBeInTheDocument();
    expect(within(screen.getByRole("columnheader", { name: /Test 1/ })).queryByText("Not released")).toBeNull();
  });

  it("hides the exercises left out of the mean until asked, keeps one that counts, and leaves the mean alone", async () => {
    renderTab(makeTable());
    await cell("Alice Dupont", "Test 1");
    expect(screen.queryByRole("columnheader", { name: /Exercises/ })).toBeNull();
    const row = screen.getByRole("row", { name: /Alice Dupont/ });
    expect(within(row).getAllByRole("cell").at(-1)).toHaveTextContent("5.5");
    await showExercises();
    expect(screen.getByRole("columnheader", { name: /Exercises/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Show exercises" }));
    expect(screen.queryByRole("columnheader", { name: /Exercises/ })).toBeNull();
  });

  it("offers no exercise switch when every exercise counts", async () => {
    const table = makeTable();
    table.columns[1] = { ...table.columns[1]!, counts: true };
    renderTab(table);
    await cell("Alice Dupont", "Exercises");
    expect(screen.queryByRole("switch", { name: "Show exercises" })).toBeNull();
  });

  it("names a column by its full title and kind, and shows its weight alone", async () => {
    const long = "Exam 1: numeration, types and tools for the first half of the semester";
    const table = makeTable();
    table.columns[0] = { ...table.columns[0]!, title: long };
    renderTab(table);
    const head = await screen.findByRole("button", { name: (name) => name.startsWith(`${long} (Exam)`) });
    expect(head).toHaveTextContent(/100 %$/);
    expect(within(head).queryByText(/Exam ·/)).toBeNull();
  });

  it("lights the column of the hovered head, and only it", async () => {
    renderTab(makeTable());
    const target = (await cell("Alice Dupont", "Test 1")).closest("td")!;
    const other = (await cell("Alice Dupont", "Test 2")).closest("td")!;
    await userEvent.hover(within(screen.getByRole("columnheader", { name: /Test 1/ })).getByText("Test 1"));
    expect(target.className).toContain("bg-accent-soft");
    expect(other.className).not.toContain("bg-accent-soft");
    await userEvent.unhover(within(screen.getByRole("columnheader", { name: /Test 1/ })).getByText("Test 1"));
    expect(target.className).not.toContain("bg-accent-soft");
  });

  it("shows the full title and kind on hover, and keeps it shut while the column menu is open", async () => {
    renderTab(makeTable());
    const head = await screen.findByRole("button", { name: /^Test 1/ });
    await userEvent.hover(head.firstElementChild!);
    expect(await screen.findByText("Test 1 · Exam")).toBeInTheDocument();
    await userEvent.click(head.firstElementChild!);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.queryByText("Test 1 · Exam")).toBeNull();
    await userEvent.unhover(head.firstElementChild!);
    await userEvent.hover(head.firstElementChild!);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByText("Test 1 · Exam")).toBeNull();
  });

  it("closes on the class means: each column's, a dash where there is none, and the overall one under the mean", async () => {
    renderTab(makeTable());
    await showExercises();
    const row = await screen.findByRole("row", { name: /Class mean/ });
    const cells = within(row).getAllByRole("cell");
    // A grade carries its band in words for a screen reader: the figure leads.
    expect(cells.map((c) => c.textContent!.split(" ")[0])).toEqual(["3.3", "—", "—", "3.3"]);
  });

  it("scrolls inside its card, never the page", async () => {
    renderTab(makeTable());
    const table = await screen.findByRole("table");
    expect(table.parentElement!.className).toContain("overflow-x-auto");
    // The cells' sr-only spans are absolute: only a positioned scroller clips them.
    expect(table.parentElement!.className).toContain("relative");
  });

  it("says why there is nothing, and fails readably", async () => {
    renderTab(makeTable({ columns: [], rows: [] }));
    expect(await screen.findByText("Nothing graded yet")).toBeInTheDocument();
  });

  it("asks for a retry on a failed load", async () => {
    renderTab(fail(500, { message: "boom" }));
    expect(await screen.findByText("Could not load the grades.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("says no students when no seat is claimed yet", async () => {
    renderTab(makeTable({ rows: [] }));
    expect(await screen.findByText("No students yet")).toBeInTheDocument();
  });
});

describe("the writes of a cell", () => {
  it("marks an absence: the PUT carries the kind alone, and the table it answers replaces the screen", async () => {
    const after = makeTable();
    after.rows[0]!.cells[EXERCISE] = { ...empty, kind: "absent", grade: 1, source: "mark" };
    const { calls } = renderTab(makeTable(), { [`PUT ${URL_MARK(EXERCISE, ALICE)}`]: ok(after) });
    await showExercises();
    await choose(await cell("Alice Dupont", "Exercises"), "Mark absent (a1.0)");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ kind: "absent" });
    await waitFor(() => expect(within(screen.getByRole("button", { name: "Marks for Alice Dupont, Exercises" })).getByText("a1.0")).toBeInTheDocument());
  });

  it("excuses a student (#969): the PUT carries the kind, and the cell answers a boxed - named Excused", async () => {
    const after = makeTable();
    after.rows[0]!.cells[EXERCISE] = { ...empty, kind: "excused", source: "mark" };
    const { calls } = renderTab(makeTable(), { [`PUT ${URL_MARK(EXERCISE, ALICE)}`]: ok(after) });
    await showExercises();
    await choose(await cell("Alice Dupont", "Exercises"), "Excuse (no mean)");
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ kind: "excused" }));
    const excused = await waitFor(() => within(screen.getByRole("button", { name: "Marks for Alice Dupont, Exercises" })).getByText("-"));
    // Named in words beside the sign, never by its look alone (N-A11Y-03), and never the empty cell's em dash.
    expect(excused.parentElement).toHaveTextContent("Excused. Counts in no mean.");
    expect(within(screen.getByRole("button", { name: "Marks for Alice Dupont, Exercises" })).queryByText("—")).toBeNull();
  });

  it("asks before replacing a real grade (409 grade_exists), then sends it again with override", async () => {
    let attempts = 0;
    const { calls } = renderTab(makeTable(), {
      [`PUT ${URL_MARK(TEST, ALICE)}`]: () => {
        attempts += 1;
        return attempts === 1 ? fail(409, { error: "grade_exists", message: "A grade stands" }) : ok(makeTable());
      },
    });
    await choose(await cell("Alice Dupont", "Test 1"), "Mark absent (a1.0)");
    const dialog = await screen.findByRole("dialog", { name: "Replace the grade?" });
    expect(within(dialog).getByText(/Alice Dupont already has a grade in Test 1/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace the grade" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts[0]!.body).toEqual({ kind: "absent" });
    expect(puts[1]!.body).toEqual({ kind: "absent", override: true });
  });

  it("sends nothing more when the teacher declines the override", async () => {
    const { calls } = renderTab(makeTable(), {
      [`PUT ${URL_MARK(TEST, ALICE)}`]: fail(409, { error: "grade_exists", message: "A grade stands" }),
    });
    await choose(await cell("Alice Dupont", "Test 1"), "Mark absent (a1.0)");
    const dialog = await screen.findByRole("dialog", { name: "Replace the grade?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("words 403 owner_required and 422 score_above_max in the reader's language", async () => {
    renderTab(makeTable(), {
      [`PUT ${URL_MARK(TEST, ALICE)}`]: fail(403, { error: "owner_required", message: "Only an owner" }),
      [`PUT ${URL_MARK(TEST, BOB)}`]: fail(422, { error: "score_above_max", message: "Above" }),
    });
    await choose(await cell("Bob Favre", "Test 1"), "Mark absent (a1.0)");
    expect(await screen.findByText("The points are above the maximum.")).toBeInTheDocument();
    await choose(await cell("Alice Dupont", "Test 1"), "Mark absent (a1.0)");
    // The first PUT of Alice is a 409 in the real API; here the refusal is the owner's.
    expect(await screen.findByText("Only a teacher of the course may replace a released grade.")).toBeInTheDocument();
  });

  it("sets a score: points out of a maximum, a comment, and no submit while the score is above its maximum", async () => {
    const { calls } = renderTab(makeTable(), { [`PUT ${URL_MARK(EXERCISE, BOB)}`]: ok(makeTable()) });
    await showExercises();
    await choose(await cell("Bob Favre", "Exercises"), "Set a score…");
    const dialog = await screen.findByRole("dialog", { name: "Score for Bob Favre" });
    const submit = within(dialog).getByRole("button", { name: "Set the score" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Points"), "25");
    await userEvent.type(within(dialog).getByLabelText("Out of"), "20");
    expect(submit).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText("Points"));
    await userEvent.type(within(dialog).getByLabelText("Points"), "14,5");
    await userEvent.type(within(dialog).getByLabelText("Comment (staff only)"), "  late hand-in ");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ kind: "score", points: 14.5, max: 20, comment: "late hand-in" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears a mark, offered only where there is one", async () => {
    const table = makeTable();
    table.rows[1]!.cells[EXERCISE] = {
      ...empty,
      kind: "absent",
      grade: 1,
      source: "mark",
      mark: { kind: "absent", points: null, max: null, comment: null, setBy: "Ada Lovelace", setAt: "2026-10-02T08:00:00.000Z" },
    };
    const { calls } = renderTab(table, { [`DELETE ${URL_MARK(EXERCISE, BOB)}`]: ok(makeTable()) });
    await showExercises();
    await userEvent.click(await cell("Alice Dupont", "Exercises"));
    expect(screen.queryByRole("menuitem", { name: "Clear the mark" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await choose(await cell("Bob Favre", "Exercises"), "Clear the mark");
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});

describe("the settings of a column and of the mean", () => {
  it("toggles whether a column counts, and sets its weight as a whole percentage", async () => {
    const { calls } = renderTab(makeTable(), {
      [`PATCH ${URL_COLUMN(EXERCISE)}`]: ok(makeTable()),
      [`PATCH ${URL_COLUMN(TEST)}`]: ok(makeTable()),
    });
    await showExercises();
    await cell("Alice Dupont", "Test 1");
    await choose(screen.getByRole("button", { name: /^Exercises/ }), "Count in the mean");
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ counts: true });

    await choose(screen.getByRole("button", { name: /^Test 1/ }), "Set the weight…");
    const dialog = await screen.findByRole("dialog", { name: "Weight of Test 1" });
    const save = within(dialog).getByRole("button", { name: "Save" });
    const field = within(dialog).getByLabelText("Weight (%)");
    for (const bad of ["101", "2.5", "-1"]) {
      await userEvent.clear(field);
      await userEvent.type(field, bad);
      expect(save, bad).toBeDisabled();
    }
    await userEvent.clear(field);
    await userEvent.type(field, "40");
    await userEvent.click(save);
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH")[1]!.body).toEqual({ weight: 40 });
  });

  it("publishes the mean to the students, and stops", async () => {
    const { calls } = renderTab(makeTable(), { [`PATCH ${URL_TABLE}`]: ok(makeTable({ meanPublished: true })) });
    const toggle = await screen.findByRole("switch", { name: "Students see their mean" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ meanPublished: true });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Students see their mean" })).toHaveAttribute("aria-checked", "true"));
  });

  it("is read-only on an archived classroom: no menu on a cell or a column, the switch off", async () => {
    renderTab(makeTable({ archived: true }));
    expect(await screen.findByText("Test 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Marks for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Test 1/ })).toBeNull();
    expect(screen.getByRole("switch", { name: "Students see their mean" })).toBeDisabled();
  });
});

/*
 * A course with components of the mean (ADR-131): the head names a column's
 * component, or warns that a counted column in none counts in no mean (and a
 * line above the matrix counts them); a mean per component stands before the
 * mean; the head opens the column's settings, where "Counts in" is the one
 * control of whether and where it counts.
 */
const COURS = "0190d3c4-0000-7000-8000-0000000000d1";
const LABO = "0190d3c4-0000-7000-8000-0000000000d2";

function componentTable(over: Partial<GradebookStaff> = {}): GradebookStaff {
  const base = makeTable();
  return GradebookStaff.parse({
    ...base,
    components: [
      { id: COURS, name: "Cours", weight: 50, classMean: 3.3 },
      { id: LABO, name: "Labo", weight: 50, classMean: null },
    ],
    // Test 1 in Cours; Exercises does not count; Test 2 counts, in no component.
    columns: [{ ...base.columns[0]!, componentId: COURS }, base.columns[1]!, base.columns[2]!],
    rows: base.rows.map((row) => ({ ...row, componentMeans: { [COURS]: row.mean, [LABO]: null } })),
    ...over,
  });
}

const head = (title: string) => screen.findByRole("button", { name: (name) => name.startsWith(title) });

describe("components of the mean", () => {
  it("names a column's component in its head, warns on a counted column in none, and counts those above the matrix", async () => {
    renderTab(componentTable());
    expect(await head("Test 1")).toHaveAccessibleName(/Counts in Cours/);
    expect(within(await head("Test 1")).getByText("Cours")).toBeInTheDocument();
    expect(await head("Test 2")).toHaveAccessibleName(/In no component: counts in no mean\./);
    expect(screen.getByText("1 activity that counts is in no component, so in no mean.")).toBeInTheDocument();
    await showExercises();
    // Not counted: neither a component nor a warning.
    expect(await head("Exercises")).not.toHaveAccessibleName(/component|Counts in/);
  });

  it("draws a mean per component between the grades and the mean, and their class means in the footer", async () => {
    renderTab(componentTable());
    await cell("Alice Dupont", "Test 1");
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads.slice(-3)).toEqual(["Cours50 %", "Labo50 %", "Mean"]);
    const alice = within(screen.getByRole("row", { name: /Alice Dupont/ })).getAllByRole("cell");
    expect(alice.slice(-3).map((c) => c.textContent!.split(" ")[0])).toEqual(["5.5", "—", "5.5"]);
    const footer = within(screen.getByRole("row", { name: /Class mean/ })).getAllByRole("cell");
    expect(footer.slice(-3).map((c) => c.textContent!.split(" ")[0])).toEqual(["3.3", "—", "3.3"]);
  });

  it("opens the column's settings from its head, with no menu: a component writes counts and the component, Does not count the flag alone", async () => {
    const { calls } = renderTab(componentTable(), {
      [`PATCH ${URL_COLUMN(LATER)}`]: ok(componentTable()),
      [`PATCH ${URL_COLUMN(TEST)}`]: ok(componentTable()),
    });
    await userEvent.click(await head("Test 2"));
    expect(screen.queryByRole("menu")).toBeNull();
    let dialog = await screen.findByRole("dialog", { name: "Settings of Test 2" });
    const countsIn = within(dialog).getByLabelText("Counts in");
    expect(countsIn).toHaveDisplayValue("Choose a component");
    expect(within(dialog).getByText("In no component: counts in no mean.")).toBeInTheDocument();
    await userEvent.selectOptions(countsIn, "Labo");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ counts: true, componentId: LABO });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(await head("Test 1"));
    dialog = await screen.findByRole("dialog", { name: "Settings of Test 1" });
    expect(within(dialog).getByLabelText("Counts in")).toHaveDisplayValue("Cours");
    await userEvent.selectOptions(within(dialog).getByLabelText("Counts in"), "Does not count");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH")[1]!.body).toEqual({ counts: false });
  });

  it("sends nothing when the settings are saved unchanged", async () => {
    const { calls } = renderTab(componentTable());
    await userEvent.click(await head("Test 1"));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });
});

describe("a setting that moves the means students read now", () => {
  it("asks first on a released column that counts while the mean is published, and sends nothing on Cancel", async () => {
    const { calls } = renderTab(componentTable({ meanPublished: true }), {
      [`PATCH ${URL_COLUMN(TEST)}`]: ok(componentTable({ meanPublished: true })),
    });
    await userEvent.click(await head("Test 1"));
    const dialog = await screen.findByRole("dialog", { name: "Settings of Test 1" });
    const weight = within(dialog).getByLabelText("Weight (%)");
    await userEvent.clear(weight);
    await userEvent.type(weight, "40");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    let question = await screen.findByRole("dialog", { name: "Change the students' means?" });
    expect(within(question).getByText(/The results of Test 1 are released/)).toBeInTheDocument();
    await userEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);

    await userEvent.click(within(screen.getByRole("dialog", { name: "Settings of Test 1" })).getByRole("button", { name: "Save" }));
    question = await screen.findByRole("dialog", { name: "Change the students' means?" });
    await userEvent.click(within(question).getByRole("button", { name: "Change now" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ weight: 40 });
  });

  it("asks on a course without components too, from the column's menu", async () => {
    const { calls } = renderTab(makeTable({ meanPublished: true }), {
      [`PATCH ${URL_COLUMN(EXERCISE)}`]: ok(makeTable({ meanPublished: true })),
    });
    await showExercises();
    await cell("Alice Dupont", "Exercises");
    await choose(screen.getByRole("button", { name: /^Exercises/ }), "Count in the mean");
    const question = await screen.findByRole("dialog", { name: "Change the students' means?" });
    await userEvent.click(within(question).getByRole("button", { name: "Change now" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ counts: true }));
  });

  it("does not ask for a column not released", async () => {
    const { calls } = renderTab(componentTable({ meanPublished: true }), {
      [`PATCH ${URL_COLUMN(LATER)}`]: ok(componentTable({ meanPublished: true })),
    });
    await userEvent.click(await head("Test 2"));
    await userEvent.selectOptions(within(await screen.findByRole("dialog")).getByLabelText("Counts in"), "Cours");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Change the students' means?" })).toBeNull();
  });
});
