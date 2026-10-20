import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GradebookStudent } from "@quiz/contracts";

import { fail, makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { StudentGradebook } from "./StudentGradebook";

/*
 * The student's Grades tab (F-GBOOK-05, F-RES-04, M5-04): the cells exactly as
 * the server narrowed them — a grade, the absence `a1.0`, a dash, "grade not
 * shared", "indicative" with its points — and the mean and the weights only
 * when the payload carries them (the teacher publishes them). The tab filters
 * nothing and computes nothing.
 */

const ROOM = "0190d3c4-0000-7000-8000-0000000000a1";
const IDS = [1, 2, 3, 4, 5].map((n) => `0190d3c4-0000-7000-8000-0000000000c${n}`);
const URL_BOOK = `/app/api/student/classrooms/${ROOM}/gradebook`;

const column = (n: number, title: string, mode: "exam" | "exercise" | "project", extra = {}) => ({
  kind: mode === "project" ? "project" : "evaluation",
  activityId: IDS[n]!,
  mode,
  title,
  date: "2026-09-10T08:00:00.000Z",
  ...extra,
});
const cell = (kind: string, grade: number | null = null, points: number | null = null, max: number | null = null) => ({
  kind,
  grade,
  points,
  max,
});

function book(over: Record<string, unknown> = {}, weights = false): GradebookStudent {
  const w = (weight: number, counts = true) => ({ counts, ...(weights ? { weight } : {}) });
  return GradebookStudent.parse({
    classroomId: ROOM,
    columns: [
      column(0, "Test 1", "exam", w(50)),
      column(1, "Test 2", "exam", w(100)),
      column(2, "Series 1", "exercise", w(100, false)),
      column(3, "Test 3", "exam", w(50)),
      column(4, "Quick quiz", "exam", w(50)),
    ],
    cells: {
      [IDS[0]!]: cell("grade", 5.5),
      [IDS[1]!]: cell("absent", 1),
      [IDS[2]!]: cell("grade", 3),
      [IDS[3]!]: cell("indicative", null, 12, 20),
      [IDS[4]!]: cell("withheld"),
    },
    ...over,
  });
}

function renderTab(payload: GradebookStudent | ReturnType<typeof fail>) {
  mockFetch({ [`GET ${URL_BOOK}`]: "classroomId" in payload ? ok(payload) : payload });
  renderWithProviders(<StudentGradebook classroomId={ROOM} />, { queryClient: makeQueryClient() });
}

const row = (title: string) => screen.findByRole("listitem", { name: (_name, el) => el.textContent?.startsWith(title) ?? false });

describe("the student's own cells", () => {
  it("words every kind of cell: a grade, the absence, a dash, indicative with its points, grade not shared", async () => {
    renderTab(book());
    expect(await within(await row("Test 1")).findByText("5.5")).toBeInTheDocument();
    const absent = within(await row("Test 2")).getByText("a1.0");
    expect(absent.className).toContain("text-info");
    const indicative = await row("Test 3");
    expect(within(indicative).getByText("12 / 20")).toBeInTheDocument();
    expect(within(indicative).getByText("indicative")).toBeInTheDocument();
    expect(within(await row("Quick quiz")).getByText("grade withheld")).toBeInTheDocument();
  });

  it("draws no mean and no weight while the payload has none (the teacher has not published it)", async () => {
    renderTab(book());
    await row("Test 1");
    expect(screen.queryByText("Mean")).toBeNull();
    expect(screen.queryByText(/Weight/)).toBeNull();
  });

  it("draws what counts, then what does not, its grade indicative in the ink (#803)", async () => {
    renderTab(book());
    const counting = await screen.findByRole("region", { name: "In the average" });
    const aside = screen.getByRole("region", { name: "Indicative" });
    expect(within(aside).getByText(/Not counted in your average unless your teacher includes them/)).toBeInTheDocument();
    expect(within(counting).queryByText("Series 1")).toBeNull();
    const grade = within(aside).getByText("3.0");
    expect(grade.className).not.toContain("text-danger");
    // The group is the one word for it: no badge on the row.
    expect(within(aside).queryByText("indicative")).toBeNull();
  });

  it("draws no indicative group when everything counts", async () => {
    const all = book();
    renderTab({ ...all, columns: all.columns.filter((c) => c.counts) });
    expect(await screen.findByRole("region", { name: "In the average" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Indicative" })).toBeNull();
  });

  it("draws the mean and the weights once the payload carries them", async () => {
    renderTab(book({ mean: 4.3 }, true));
    expect(await within(await row("Test 2")).findByText(/Weight 100 %/)).toBeInTheDocument();
    // A column that does not count carries no weight: it does not count.
    expect(within(await row("Series 1")).queryByText(/Weight/)).toBeNull();
    const mean = await row("Mean");
    expect(within(mean).getByText("4.3")).toBeInTheDocument();
  });

  it("draws a dash for a published mean with nothing to average yet", async () => {
    renderTab(book({ mean: null }, true));
    expect(within(await row("Mean")).getByText("—")).toBeInTheDocument();
  });

  it("says there is nothing yet, and fails readably", async () => {
    renderTab(book({ columns: [], cells: {} }));
    expect(await screen.findByText("No grades yet")).toBeInTheDocument();
  });

  it("asks for a retry on a failed load", async () => {
    renderTab(fail(500, { message: "boom" }));
    expect(await screen.findByText("Could not load the grades.")).toBeInTheDocument();
  });
});
