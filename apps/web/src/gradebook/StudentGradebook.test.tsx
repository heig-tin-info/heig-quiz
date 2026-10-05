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
  const w = (weight: number, counts = true) => (weights ? { weight, counts } : {});
  return GradebookStudent.parse({
    classroomId: ROOM,
    columns: [
      column(0, "Test 1", "exam", w(1)),
      column(1, "Test 2", "exam", w(2)),
      column(2, "Exercises", "exercise", w(1, false)),
      column(3, "Test 3", "exam", w(1)),
      column(4, "Quick quiz", "exam", w(1)),
    ],
    cells: {
      [IDS[0]!]: cell("grade", 5.5),
      [IDS[1]!]: cell("absent", 1),
      [IDS[2]!]: cell("empty"),
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
    expect(within(await row("Exercises")).getByText("—")).toBeInTheDocument();
    const indicative = await row("Test 3");
    expect(within(indicative).getByText("12 / 20")).toBeInTheDocument();
    expect(within(indicative).getByText("indicative")).toBeInTheDocument();
    expect(within(await row("Quick quiz")).getByText("grade not shared")).toBeInTheDocument();
  });

  it("draws no mean and no weight while the payload has none (the teacher has not published it)", async () => {
    renderTab(book());
    await row("Test 1");
    expect(screen.queryByText("Mean")).toBeNull();
    expect(screen.queryByText(/Weight/)).toBeNull();
    expect(screen.queryByText(/Not counted/)).toBeNull();
  });

  it("draws the mean and the weights once the payload carries them", async () => {
    renderTab(book({ mean: 4.3 }, true));
    expect(await within(await row("Test 2")).findByText(/Weight 2/)).toBeInTheDocument();
    expect(within(await row("Exercises")).getByText(/Not counted/)).toBeInTheDocument();
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
