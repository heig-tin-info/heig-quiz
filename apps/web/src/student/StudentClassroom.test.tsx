import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EvaluationCard, StudentClassroomPage, StudentPollCard } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { mostUrgent, StudentClassroom } from "./StudentClassroom";

/*
 * The student's page of one classroom (F-ORG-15, M5-02), in a production
 * build: `CLASSROOM_PAGES` is off here, so the Journal tab never shows —
 * its API (M4-02) does not exist yet. `StudentClassroom.journal.test.tsx`
 * covers the tab with the flag on.
 */

const card = (over: Partial<EvaluationCard>): EvaluationCard & { kind: "evaluation" } => ({
  kind: "evaluation",
  id: "e1",
  title: "Quiz 3 — Pointeurs",
  mode: "exam",
  state: "running",
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  opensAt: null,
  closesAt: null,
  durationS: 1200,
  attemptId: null,
  attemptState: null,
  attemptStartedAt: null,
  grade: null,
  deadlineAt: null,
  retakes: null,
  results: "none",
  ...over,
});

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

const classroomPage = (over: Partial<StudentClassroomPage> = {}): StudentClassroomPage => ({
  classroom: {
    id: "r1",
    name: "PRG1-2026",
    period: "2026-A",
    courseName: "Programmation C",
    courseCode: "PRG1",
    teachers: ["Prof Démo", "Pierre Roulet"],
    timeBonusPercent: 25,
    archived: false,
  },
  activities: {
    polls: [],
    open: [
      card({ id: "e-late", title: "Série 3 — Pointeurs", mode: "exercise", closesAt: inMinutes(3 * 24 * 60) }),
      card({ id: "e-soon", title: "Quiz 3 — Pointeurs", closesAt: inMinutes(20) }),
    ],
    upcoming: [card({ id: "e-next", title: "Série 4 — Récursivité", state: "scheduled", opensAt: inMinutes(600) })],
    past: [
      card({
        id: "e-past",
        title: "Quiz 2 — Tableaux",
        state: "released",
        attemptId: "a2",
        attemptState: "submitted",
        results: "available",
      }),
    ],
  },
  hasJournal: false,
  hasProjects: false,
  serverNow: new Date().toISOString(),
  ...over,
});

const URL_R1 = "GET /app/api/student/classrooms/r1";

const render = (navigate = vi.fn()) => ({
  navigate,
  ...renderWithProviders(<StudentClassroom id="r1" tab="activities" navigate={navigate} />),
});

/** The card holding `title`. */
const cardOf = async (title: string) =>
  within((await screen.findByText(title)).closest("div.rounded-card") as HTMLElement);

describe("the student classroom page", () => {
  it("names the classroom, its course, period and teachers, and the student's time bonus", async () => {
    mockFetch({ [URL_R1]: ok(classroomPage()) });
    const { navigate } = render();
    expect(await screen.findByRole("heading", { level: 1, name: "PRG1-2026" })).toBeVisible();
    expect(screen.getByText("PRG1 — Programmation C · 2026-A")).toBeVisible();
    expect(screen.getByText("Taught by Prof Démo, Pierre Roulet")).toBeVisible();
    expect(screen.getByText("Extra time: +25%")).toBeVisible();
    expect(screen.queryByText("archived")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Courses" }));
    expect(navigate).toHaveBeenCalledWith({ view: "studentCourses" });
  });

  it("says an archived classroom is archived", async () => {
    const page = classroomPage();
    mockFetch({ [URL_R1]: ok({ ...page, classroom: { ...page.classroom, archived: true } }) });
    render();
    expect(await screen.findByText("archived")).toBeVisible();
  });

  it("groups the activities, and lights ONE button: the open one that closes first", async () => {
    mockFetch({ [URL_R1]: ok(classroomPage()) });
    const { navigate } = render();
    await screen.findByText("Quiz 3 — Pointeurs");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Open now",
      "Coming up",
      "Past evaluations",
    ]);

    const soon = (await cardOf("Quiz 3 — Pointeurs")).getByRole("button", { name: "Start" });
    const late = (await cardOf("Série 3 — Pointeurs")).getByRole("button", { name: "Start" });
    const review = (await cardOf("Quiz 2 — Tableaux")).getByRole("button", { name: "See my results" });
    expect(soon).toHaveClass("bg-accent");
    for (const other of [late, review]) expect(other).not.toHaveClass("bg-accent");
    expect(document.querySelectorAll("button.bg-accent")).toHaveLength(1);

    // The page is the classroom's: no row repeats its name.
    expect(screen.queryByText("PRG1 · PRG1-2026")).toBeNull();

    await userEvent.click(soon);
    expect(navigate).toHaveBeenCalledWith({ view: "attempt", evaluationId: "e-soon" });
  });

  it("says there is nothing to do, and leaves out the empty groups", async () => {
    mockFetch({ [URL_R1]: ok(classroomPage({ activities: { polls: [], open: [], upcoming: [], past: [] } })) });
    render();
    expect(await screen.findByText("Nothing to do in this classroom right now")).toBeVisible();
    expect(screen.queryByText("Coming up")).toBeNull();
    expect(screen.queryByText("Past evaluations")).toBeNull();
    expect(document.querySelectorAll("button.bg-accent")).toHaveLength(0);
  });

  it("shows no Journal tab while its API is not deployed, even for a classroom that has one", async () => {
    mockFetch({ [URL_R1]: ok(classroomPage({ hasJournal: true })) });
    render();
    await screen.findByRole("heading", { level: 1, name: "PRG1-2026" });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Journal" })).toBeNull();
  });

  it("reads a 404 as a classroom that does not exist, with the way back to Courses", async () => {
    mockFetch({ [URL_R1]: fail(404, { message: "Not found" }) });
    const { navigate } = render();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This classroom does not exist, or you do not have access to it.",
      }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to courses" }));
    expect(navigate).toHaveBeenCalledWith({ view: "studentCourses" });
  });

  it("shows any other failure with a retry", async () => {
    mockFetch({ [URL_R1]: fail(500, { message: "Boom" }) });
    render();
    expect(await screen.findByRole("heading", { level: 1, name: "Could not load this classroom" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

describe("mostUrgent", () => {
  const poll: StudentPollCard = { id: "p1", code: "ABC123", classroomId: "r1", classroomName: "PRG1-2026", courseCode: "PRG1" };

  it("is nothing when nothing is open", () => {
    expect(mostUrgent({ polls: [], open: [] })).toBeNull();
  });

  it("takes the card to do whose deadline comes first, the attempt's before the closing", () => {
    const open = [
      card({ id: "a", closesAt: inMinutes(60) }),
      card({ id: "b", closesAt: inMinutes(120), attemptState: "in_progress", deadlineAt: inMinutes(10) }),
    ];
    expect(mostUrgent({ polls: [poll], open })).toBe("b");
  });

  it("puts a running poll before a card with no deadline, and that card before a retake", () => {
    const open = [
      card({ id: "retake", closesAt: inMinutes(5), attemptId: "a1", attemptState: "submitted" }),
      card({ id: "free", closesAt: null }),
    ];
    expect(mostUrgent({ polls: [poll], open })).toBe("p1");
    expect(mostUrgent({ polls: [], open })).toBe("free");
    expect(mostUrgent({ polls: [], open: [open[0]!] })).toBe("retake");
  });

  it("keeps the server's order on a tie", () => {
    expect(mostUrgent({ polls: [], open: [card({ id: "x" }), card({ id: "y" })] })).toBe("x");
  });
});
