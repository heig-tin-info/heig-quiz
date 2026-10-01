import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { GradeGroup, GradeRow } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { StudentGrades } from "./StudentGrades";

/*
 * The student's Grades (F-ORG-14, F-RES-04): the page draws what the server
 * says and computes nothing — a grade only where the row carries one, a row
 * that opens only where it names an attempt.
 */

const URL = "GET /app/api/student/results";

const row = (over: Partial<GradeRow> & Pick<GradeRow, "evaluationId" | "title">): GradeRow => ({
  mode: "exam",
  date: "2026-09-20T10:00:00.000Z",
  status: "released",
  feedbackAttemptId: null,
  score: null,
  ...over,
});

const groups: GradeGroup[] = [
  {
    classroom: {
      id: "r1",
      name: "PRG1-2026",
      courseCode: "PRG1",
      courseName: "Programmation C",
      period: "2026-A",
      archived: false,
    },
    rows: [
      row({ evaluationId: "e1", title: "Quiz 3bis", status: "pending" }),
      row({
        evaluationId: "e2",
        title: "Quiz 2",
        feedbackAttemptId: "a2",
        score: { points: 8.5, totalPoints: 12, grade: 4.5 },
      }),
      // Released under the policy `none`: the server sends no score.
      row({ evaluationId: "e3", title: "Série 8", mode: "exercise" }),
    ],
  },
  {
    classroom: {
      id: "r6",
      name: "PRG1-2024",
      courseCode: "PRG1",
      courseName: "Programmation C",
      period: "2024-A",
      archived: true,
    },
    rows: [row({ evaluationId: "e4", title: "Examen final", status: "missed", score: { points: 0, totalPoints: 40, grade: 1 } })],
  },
];

const render = (props: { classroomId?: string } = {}, navigate = vi.fn()) => ({
  navigate,
  ...renderWithProviders(<StudentGrades navigate={navigate} {...props} />),
});

/** The table row of `title` (the desktop rendering; the phone list repeats it). */
const tableRow = async (title: string) =>
  within((await screen.findAllByText(title))[0]!.closest("tr") as HTMLElement);

describe("the student's Grades", () => {
  it("groups by classroom, names the course and period, and marks an archived classroom", async () => {
    mockFetch({ [URL]: ok(groups) });
    render();
    expect(await screen.findByRole("heading", { level: 2, name: "PRG1-2026" })).toBeInTheDocument();
    expect(screen.getByText("PRG1 — Programmation C · 2026-A")).toBeInTheDocument();
    const archived = screen.getByRole("heading", { level: 2, name: /PRG1-2024/ });
    expect(within(archived).getByText("archived")).toBeInTheDocument();
  });

  it("prints the points and the grade the server sent, and a dash where it sent none", async () => {
    mockFetch({ [URL]: ok(groups) });
    render();
    const released = await tableRow("Quiz 2");
    expect(released.getByText("8.5 / 12")).toBeInTheDocument();
    expect(released.getByText("4.5")).toBeInTheDocument();
    expect(released.getByText("released")).toBeInTheDocument();
    for (const title of ["Quiz 3bis", "Série 8"]) {
      expect((await tableRow(title)).getAllByText("—")).toHaveLength(2);
    }
    expect((await tableRow("Quiz 3bis")).getByText("results pending")).toBeInTheDocument();
    expect((await tableRow("Examen final")).getByText("not taken")).toBeInTheDocument();
  });

  it("opens the feedback of a row that names an attempt, and of no other", async () => {
    mockFetch({ [URL]: ok(groups) });
    const { navigate } = render();
    await userEvent.click((await tableRow("Quiz 2")).getByText("Quiz 2"));
    expect(navigate).toHaveBeenCalledWith({ view: "feedback", attemptId: "a2" });
    navigate.mockClear();
    await userEvent.click((await tableRow("Série 8")).getByText("Série 8"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("narrows to one classroom when the classroom's tab asks", async () => {
    mockFetch({ [URL]: ok(groups) });
    render({ classroomId: "r6" });
    expect(await screen.findByRole("heading", { level: 2, name: /PRG1-2024/ })).toBeInTheDocument();
    expect(screen.queryByText("PRG1-2026")).toBeNull();
  });

  it("says there is nothing yet", async () => {
    mockFetch({ [URL]: ok([]) });
    render();
    expect(await screen.findByText("No grades yet")).toBeInTheDocument();
  });

  it("shows the query error with a retry", async () => {
    mockFetch({ [URL]: fail(500, "boom") });
    render();
    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
