import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvaluationCard, Me, StudentHome as StudentHomeData, StudentProjectCard } from "@quiz/contracts";

import { makeMe } from "../test/fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { StudentHome } from "./StudentHome";
import { SEB_DOWNLOAD_URL } from "./SebLaunchModal";

const me: Me = makeMe({
  id: "u1",
  email: "lea.perret@heig-vd.ch",
  givenName: "Léa",
  familyName: "Perret",
  role: "student",
  lastLoginAt: null,
  locale: "fr",
  dateFormat: null,
});

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

const home: StudentHomeData = {
  polls: [],
  groupSets: [],
  open: [card({})],
  upcoming: [
    card({ id: "e2", title: "Série 4 — Récursivité", mode: "exercise", state: "scheduled" }),
  ],
  past: [
    card({
      id: "e3",
      title: "Quiz 2 — Tableaux",
      state: "released",
      attemptId: "a3",
      attemptState: "submitted",
      results: "available",
    }),
  ],
  // The page samples it into the server clock (invariant 5): the fixture's
  // clock is this machine's, so every countdown reads as the cards are dated.
  serverNow: new Date().toISOString(),
};

const render = (navigate = vi.fn()) => ({
  navigate,
  ...renderWithProviders(<StudentHome me={me} navigate={navigate} />, { locale: "fr" }),
});

describe("the student home", () => {
  it("greets the student and offers ONE action, on the open evaluation", async () => {
    mockFetch({
      "GET /app/api/student/home": ok(home),
      "GET /app/api/student/classrooms": ok([]),
    });
    const { navigate } = render();
    expect(await screen.findByText("Bonjour, Léa")).toBeInTheDocument();

    const open = (await screen.findByText("Quiz 3 — Pointeurs")).closest("div.rounded-card")!;
    const action = within(open as HTMLElement).getByRole("button", { name: "Commencer" });
    await userEvent.click(action);
    expect(navigate).toHaveBeenCalledWith({ view: "attempt", evaluationId: "e1" });

    // The one coming up carries no button at all: there is nothing to do yet.
    const upcoming = (await screen.findByText("Série 4 — Récursivité")).closest("div.rounded-card")!;
    expect(within(upcoming as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("hands out the Safe Exam Browser file instead of opening an exam that requires it", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({ ...home, open: [card({ trustedClients: ["seb"] })] }),
      "GET /app/api/student/classrooms": ok([]),
    });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const { navigate } = render();
    await userEvent.click(await screen.findByRole("button", { name: "Ouvrir dans Safe Exam Browser" }));
    // Issue #270: the instructions first; nothing is downloaded yet.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Installez Safe Exam Browser.")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "safeexambrowser.org" })).toHaveAttribute(
      "href",
      SEB_DOWNLOAD_URL,
    );
    expect(assign).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Télécharger le fichier d'examen" }));
    expect(assign).toHaveBeenCalledWith("/app/api/evaluations/e1/seb");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("closes the Safe Exam Browser instructions without downloading", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({ ...home, open: [card({ trustedClients: ["seb"] })] }),
      "GET /app/api/student/classrooms": ok([]),
    });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Ouvrir dans Safe Exam Browser" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Annuler" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps the Safe Exam Browser button on an exam that also accepts kiosk stations", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({ ...home, open: [card({ trustedClients: ["seb", "kiosk"] })] }),
      "GET /app/api/student/classrooms": ok([]),
    });
    render();
    expect(await screen.findByRole("button", { name: "Ouvrir dans Safe Exam Browser" })).toBeInTheDocument();
    expect(screen.queryByText(/poste kiosque/)).toBeNull();
  });

  it("opens no attempt on an exam sat on a kiosk station only: it says where, and leads to the pairing (ADR-051)", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({ ...home, open: [card({ trustedClients: ["kiosk"] })] }),
      "GET /app/api/student/classrooms": ok([]),
    });
    const { navigate } = render();
    const line = await screen.findByText(
      "Passez cet examen sur un poste kiosque : scannez le code affiché sur le poste.",
    );
    const row = line.closest("div.rounded-card") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Saisir le code d'un poste" }));
    expect(navigate).toHaveBeenCalledWith({ view: "pair" });
  });

  it("says “resume” on an attempt already started", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({
        ...home,
        open: [card({ attemptId: "a1", attemptState: "in_progress" })],
      }),
      "GET /app/api/student/classrooms": ok([]),
    });
    render();
    expect(await screen.findByRole("button", { name: "Continuer" })).toBeInTheDocument();
  });

  // Issue #126: which attempt "Continue" opens, by when it was started.
  it("says when the attempt in progress was started", async () => {
    // Built from LOCAL time, so the test reads the same in every time zone.
    const startedAt = new Date(2026, 8, 25, 14, 5).toISOString();
    mockFetch({
      "GET /app/api/student/home": ok({
        ...home,
        open: [
          card({ attemptId: "a1", attemptState: "in_progress", attemptStartedAt: startedAt }),
          // Not started: nothing to say.
          card({ id: "e4", title: "Série 5", attemptStartedAt: null }),
        ],
      }),
      "GET /app/api/student/classrooms": ok([]),
    });
    render();
    expect(await screen.findByText(/Commencé le 2026-09-25 à 14:05/)).toBeInTheDocument();
    expect(screen.getAllByText(/Commencé le/)).toHaveLength(1);
  });

  // F-ORG-14 (2026-10-01): what was handed in is the Grades page's, `/grades`.
  it("leaves finished work to the Grades page: no Past section", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({ ...home, open: [] }),
      "GET /app/api/student/classrooms": ok([]),
    });
    render();
    expect(await screen.findByText("Série 4 — Récursivité")).toBeInTheDocument();
    expect(screen.queryByText("Quiz 2 — Tableaux")).toBeNull();
    expect(screen.queryByText("Évaluations passées")).toBeNull();
    expect(screen.queryByRole("button", { name: "Voir mes résultats" })).toBeNull();
    // The open section is empty: nothing to do.
    expect(screen.getByText("Rien à faire pour l'instant")).toBeInTheDocument();
  });

  // Issue #163: a running poll of the classroom, answered on its own page.
  it("offers a running poll under “open now”, whose one button opens /p/:code", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({
        ...home,
        open: [],
        polls: [
          {
            id: "p1",
            code: "NM2X9A",
            classroomId: "r1",
            classroomName: "PRG1-2026",
            courseCode: "PRG1",
          },
        ],
      }),
      "GET /app/api/student/classrooms": ok([]),
    });
    const { navigate } = render();
    const row = (await screen.findByText("Sondage en direct")).closest("div.rounded-card")!;
    expect(within(row as HTMLElement).getByText("Sondage")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("PRG1 · PRG1-2026")).toBeInTheDocument();
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Répondre" }));
    expect(navigate).toHaveBeenCalledWith({ view: "join", code: "NM2X9A" });
    // A running poll is something to do: no "nothing to do" beside it.
    expect(screen.queryByText("Rien à faire pour l'instant")).toBeNull();
  });

  // M3-09a, M3-13 (F-PROJ-04): a project card among the evaluations — title,
  // status, deadline, and its one action; a ready repository is a link.
  it("lists a project among what is open, with its status and its repository", async () => {
    const project: StudentProjectCard = {
      kind: "project",
      seat: "student",
      groupMode: false,
      id: "p1",
      title: "Labo 1 — Pointeurs",
      classroomId: "r1",
      classroomName: "PRG1-2026",
      courseCode: "PRG1",
      startAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      deadlineAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      status: "in_progress",
      invitation: "accepted",
      githubLinked: true,
      repoFullName: "heig/labo-1-lea",
      repoUrl: "https://github.com/heig/labo-1-lea",
    };
    mockFetch({
      "GET /app/api/student/home": ok({ ...home, open: [card({}), project] }),
      "GET /app/api/student/classrooms": ok([]),
    });
    const { navigate } = render();
    const row = (await screen.findByText("Labo 1 — Pointeurs")).closest("div.rounded-card") as HTMLElement;
    expect(within(row).getByText("Projet")).toBeInTheDocument();
    expect(within(row).getByText(/en cours · /)).toBeInTheDocument();
    expect(within(row).queryByRole("button")).toBeNull();
    // The title is the door to the project's page.
    const title = within(row).getByRole("link", { name: "Labo 1 — Pointeurs" });
    expect(title).toHaveAttribute("href", "/projects/p1");
    await userEvent.click(title);
    expect(navigate).toHaveBeenCalledWith({ view: "project", id: "p1" });
    const open = within(row).getByRole("link", { name: "Ouvrir le dépôt" });
    expect(open).toHaveAttribute("href", "https://github.com/heig/labo-1-lea");
    // A ready repository never takes the accent: the evaluation beside it keeps the one red fill.
    expect(open).not.toHaveClass("bg-accent");
    expect(screen.getByRole("button", { name: "Commencer" })).toHaveClass("bg-accent");
  });

  it("shows the empty state when nothing is open", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({ open: [], upcoming: [], past: [], serverNow: new Date().toISOString() }),
      "GET /app/api/student/classrooms": ok([]),
    });
    render();
    expect(await screen.findByText("Rien à faire pour l'instant")).toBeInTheDocument();
    expect(await screen.findByText("Aucune classe")).toBeInTheDocument();
  });

  it("shows the query error with a retry", async () => {
    mockFetch({
      "GET /app/api/student/home": fail(500, { message: "boom" }),
      "GET /app/api/student/classrooms": ok([]),
    });
    render();
    expect(await screen.findByRole("button", { name: "Réessayer" })).toBeInTheDocument();
  });

  // D07 (M5-02): a classroom card is the door to the classroom's page.
  it("opens the classroom's page from its card, by click and by keyboard", async () => {
    mockFetch({
      "GET /app/api/student/home": ok(home),
      "GET /app/api/student/classrooms": ok([
        {
          id: "r1",
          name: "PRG1-2026",
          period: "2026-A",
          courseName: "Programmation C",
          courseCode: "PRG1",
          teachers: ["Prof Démo"],
          timeBonusPercent: 25,
        },
      ]),
    });
    const { navigate } = render();
    const door = await screen.findByRole("link", { name: "PRG1-2026" });
    expect(within(door).getByText("Temps supplémentaire : +25 %")).toBeInTheDocument();
    await userEvent.click(door);
    expect(navigate).toHaveBeenLastCalledWith({ view: "classroom", id: "r1" });
    navigate.mockClear();
    door.focus();
    await userEvent.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" });
  });

  describe("an exercise with retakes (F-EVAL-15)", () => {
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
          canRetake: true,
          kept: { attemptId: "a8", attemptNumber: 1, score: { points: 7.5, totalPoints: 10, pendingCount: 0 } },
          ...over,
        },
      });

    it("shows the kept score and the count, and retakes in one click", async () => {
      const { calls } = mockFetch({
        "GET /app/api/student/home": ok({ ...home, open: [retaking()] }),
        "GET /app/api/student/classrooms": ok([]),
        "POST /app/api/evaluations/e9/retake": ok({ kind: "attempt", view: { attempt: { id: "a10" } } }),
      });
      const { navigate } = render();
      expect(
        await screen.findByText("Meilleur score 7.5 / 10 · tentatives : 2 sur 3"),
      ).toBeInTheDocument();
      const row = screen.getByText("Série 3 — Entraînement").closest("div.rounded-card")!;
      const buttons = within(row as HTMLElement).getAllByRole("button");
      expect(buttons).toHaveLength(1);
      await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Recommencer" }));
      expect(calls.some((c) => c.url === "/app/api/evaluations/e9/retake" && c.method === "POST")).toBe(true);
      await vi.waitFor(() =>
        expect(navigate).toHaveBeenCalledWith({ view: "attempt", evaluationId: "e9" }),
      );
    });

    it("asks first when the LAST attempt counts, and retakes only on confirm", async () => {
      const { calls } = mockFetch({
        "GET /app/api/student/home": ok({ ...home, open: [retaking({ keep: "last" })] }),
        "GET /app/api/student/classrooms": ok([]),
        "POST /app/api/evaluations/e9/retake": ok({ kind: "attempt", view: { attempt: { id: "a10" } } }),
      });
      const { navigate } = render();
      await userEvent.click(await screen.findByRole("button", { name: "Recommencer" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("C'est votre dernière tentative qui compte")).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
      expect(calls.some((c) => c.url.endsWith("/retake"))).toBe(false);

      await userEvent.click(screen.getByRole("button", { name: "Recommencer" }));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Recommencer" }));
      await vi.waitFor(() =>
        expect(navigate).toHaveBeenCalledWith({ view: "attempt", evaluationId: "e9" }),
      );
    });

    it("resumes an attempt in progress like any other", async () => {
      mockFetch({
        "GET /app/api/student/home": ok({
          ...home,
          open: [{ ...retaking({ canRetake: false }), attemptState: "in_progress" }],
        }),
        "GET /app/api/student/classrooms": ok([]),
      });
      render();
      expect(await screen.findByRole("button", { name: "Continuer" })).toBeInTheDocument();
    });
  });
});

// Product owner, 2026-10-01: "Coming up" grouped by the day each card opens,
// in the browser's time zone. Dates are built on the local clock, so the
// test holds in any TZ; only `Date` is faked, the timers stay real.
describe("Coming up, grouped by day", () => {
  // Thursday 1 October 2026, 10:00 local.
  const at = (day: number, hh: number) => new Date(2026, 9, day, hh, 0).toISOString();
  const scheduled = (id: string, title: string, opensAt: string) =>
    card({ id, title, mode: "exercise", state: "scheduled", opensAt });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 1, 10, 0));
  });
  afterEach(() => vi.useRealTimers());

  const renderUpcoming = (upcoming: EvaluationCard[]) => {
    mockFetch({
      // The server's clock is the faked one: the day buckets are judged on it.
      "GET /app/api/student/home": ok({ ...home, open: [], upcoming, serverNow: new Date().toISOString() }),
      "GET /app/api/student/classrooms": ok([]),
    });
    render();
  };

  const groups = async () => {
    await screen.findByText("À venir");
    return screen.getAllByRole("list").map((list) => [
      document.getElementById(list.getAttribute("aria-labelledby")!)?.textContent,
      within(list).getAllByRole("listitem").map((li) => li.querySelector("p")!.textContent),
    ]);
  };

  it("draws Today, Tomorrow, This week and Later, the soonest first in each", async () => {
    renderUpcoming([
      scheduled("e-later", "Série 9", at(20, 9)),
      scheduled("e-today-late", "Quiz 4", at(1, 16)),
      scheduled("e-week", "Série 5", at(3, 9)),
      scheduled("e-today", "Série 4", at(1, 13)),
      scheduled("e-tomorrow", "Quiz 5", at(2, 0)),
    ]);
    expect(await groups()).toEqual([
      ["Aujourd'hui", ["Série 4", "Quiz 4"]],
      ["Demain", ["Quiz 5"]],
      ["Cette semaine", ["Série 5"]],
      ["Plus tard", ["Série 9"]],
    ]);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Aujourd'hui",
      "Demain",
      "Cette semaine",
      "Plus tard",
    ]);
  });
});
