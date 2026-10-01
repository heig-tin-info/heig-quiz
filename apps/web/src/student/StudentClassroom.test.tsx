import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvaluationCard, StudentClassroomPage, StudentPollCard } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { mostUrgent, StudentClassroom } from "./StudentClassroom";

/*
 * The student's page of one classroom (F-ORG-15, M5-02), in a production
 * build: `CLASSROOM_PAGES` is off here. The Journal tab no longer waits for
 * it (M4-05): it shows exactly when the classroom has a journal, which a
 * platform without Quiz's App never reports. `StudentClassroom.journal.test.tsx`
 * covers the tab itself.
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
  trustedClients: [],
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

  it("shows the Journal tab in a production build, for a classroom that has one (M4-05)", async () => {
    mockFetch({ [URL_R1]: ok(classroomPage({ hasJournal: true })) });
    render();
    expect(await screen.findByRole("tab", { name: "Journal" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Activities" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows no tab at all where the classroom has no journal, as without Quiz's App", async () => {
    mockFetch({ [URL_R1]: ok(classroomPage({ hasJournal: false })) });
    render();
    await screen.findByRole("heading", { level: 1, name: "PRG1-2026" });
    expect(screen.queryByRole("tablist")).toBeNull();
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

// Product owner, 2026-10-01: the Coming up group by day, as on the home.
describe("the classroom page's Coming up group, by day", () => {
  // Sunday 4 October 2026, 20:00 local: tomorrow is next week's Monday.
  const at = (day: number, hh: number) => new Date(2026, 9, day, hh, 0).toISOString();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0));
  });
  afterEach(() => vi.useRealTimers());

  it("files the cards under their day, and draws no empty one", async () => {
    const upcoming = [
      card({ id: "e-tue", title: "Série 5 — Tris", state: "scheduled", opensAt: at(6, 8) }),
      card({ id: "e-mon", title: "Série 4 — Récursivité", state: "scheduled", opensAt: at(5, 8) }),
    ];
    mockFetch({ [URL_R1]: ok(classroomPage({ activities: { polls: [], open: [], upcoming, past: [] } })) });
    render();
    await screen.findByText("Série 4 — Récursivité");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Tomorrow", "Later"]);
    expect(within(screen.getByRole("list", { name: "Tomorrow" })).getByText("Série 4 — Récursivité")).toBeVisible();
    expect(within(screen.getByRole("list", { name: "Later" })).getByText("Série 5 — Tris")).toBeVisible();
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.queryByText("This week")).toBeNull();
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

/*
 * The Past group, which the classroom page keeps once the home's Past moved
 * to the Grades page (F-ORG-14, 2026-10-01): its line and its one button,
 * the shared `pastLine` and `useCardActions().review`. In French, as the
 * home tested them.
 */
describe("the classroom page's Past group (issue #203, F-EVAL-15)", () => {
  const renderFr = (past: EvaluationCard[], navigate = vi.fn()) => {
    const activities = { polls: [], open: [], upcoming: [], past: past.map((c) => ({ ...c, kind: "evaluation" as const })) };
    mockFetch({ [URL_R1]: ok(classroomPage({ activities })) });
    renderWithProviders(<StudentClassroom id="r1" tab="activities" navigate={navigate} />, { locale: "fr" });
    return navigate;
  };

  const retaking = (over: Partial<EvaluationCard["retakes"] & object> = {}) =>
    card({
      id: "e9",
      title: "Série 3 — Entraînement",
      mode: "exercise",
      attemptId: "a9",
      attemptState: "submitted",
      retakes: {
        keep: "best",
        maxAttempts: 3,
        attemptCount: 2,
        canRetake: false,
        kept: { attemptId: "a8", attemptNumber: 1, score: { points: 7.5, totalPoints: 10, pending: false } },
        ...over,
      },
    });

  // WP10: the one student results page, `/attempts/:id/feedback`.
  it("opens a past attempt's feedback", async () => {
    const navigate = renderFr([
      card({ id: "e3", title: "Quiz 2 — Tableaux", state: "released", attemptId: "a3", attemptState: "submitted", results: "available" }),
    ]);
    await userEvent.click(await screen.findByRole("button", { name: "Voir mes résultats" }));
    expect(navigate).toHaveBeenCalledWith({ view: "feedback", attemptId: "a3" });
  });

  // Issue #203: no button that leads to "not published yet".
  it("says the results are not out, with no button, when the server has none to show", async () => {
    renderFr([
      // Handed in while the quiz still runs, `on_release`.
      card({ id: "e5", title: "Quiz 4", attemptId: "a5", attemptState: "submitted", results: "pending" }),
      // Its time ran out, and the teacher closed it without releasing.
      card({ id: "e6", title: "Quiz 5", state: "closed", attemptId: "a6", attemptState: "expired", results: "pending" }),
      // Closed under `none`: nothing will ever be published, so no "yet".
      card({ id: "e7", title: "Quiz 6", state: "closed", attemptId: "a7", attemptState: "submitted", results: "none" }),
    ]);
    expect((await cardOf("Quiz 4")).getByText("rendue · résultats pas encore publiés")).toBeInTheDocument();
    expect((await cardOf("Quiz 5")).getByText("temps écoulé · résultats pas encore publiés")).toBeInTheDocument();
    expect((await cardOf("Quiz 6")).getByText("rendue")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Voir mes résultats" })).toBeNull();
  });

  // Issue #203: with none left the server lists it under Past, and the
  // button follows `results`.
  it("shows the kept score once no attempt is left, results only when available", async () => {
    const navigate = renderFr([
      retaking({ attemptCount: 3, keep: "last" }),
      { ...retaking({ attemptCount: 3 }), id: "e10", title: "Série 2 — Tableaux", state: "closed", results: "available" },
    ]);
    expect(await screen.findByText("Dernier score 7.5 / 10 · tentatives : 3 sur 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recommencer" })).toBeNull();
    expect((await cardOf("Série 3 — Entraînement")).queryByRole("button")).toBeNull();
    await userEvent.click((await cardOf("Série 2 — Tableaux")).getByRole("button", { name: "Voir mes résultats" }));
    expect(navigate).toHaveBeenCalledWith({ view: "feedback", attemptId: "a8" });
  });

  it("prints no score the feedback policy hides", async () => {
    renderFr([
      {
        ...retaking({ kept: { attemptId: "a8", attemptNumber: 1, score: null } }),
        state: "closed",
        results: "pending",
      },
    ]);
    expect(await screen.findByText("tentatives : 2 sur 3 · résultats pas encore publiés")).toBeInTheDocument();
    expect(screen.queryByText(/score/)).toBeNull();
  });
});
