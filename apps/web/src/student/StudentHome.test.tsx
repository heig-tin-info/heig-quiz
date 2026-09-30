import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EvaluationCard, Me, StudentHome as StudentHomeData } from "@quiz/contracts";

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

const card = (over: Partial<EvaluationCard>): EvaluationCard => ({
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
  serverNow: "2026-09-20T10:00:00.000Z",
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

  // WP10: the one student results page, `/attempts/:id/feedback`.
  it("opens a past attempt's feedback", async () => {
    mockFetch({
      "GET /app/api/student/home": ok(home),
      "GET /app/api/student/classrooms": ok([]),
    });
    const { navigate } = render();
    await userEvent.click(await screen.findByRole("button", { name: "Voir mes résultats" }));
    expect(navigate).toHaveBeenCalledWith({ view: "feedback", attemptId: "a3" });
  });

  // Issue #203: no button that leads to "not published yet".
  it("says the results are not out, with no button, when the server has none to show", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({
        ...home,
        open: [],
        past: [
          // Handed in while the quiz still runs, `on_release`.
          card({ id: "e5", title: "Quiz 4", attemptId: "a5", attemptState: "submitted", results: "pending" }),
          // Its time ran out, and the teacher closed it without releasing.
          card({
            id: "e6",
            title: "Quiz 5",
            state: "closed",
            attemptId: "a6",
            attemptState: "expired",
            results: "pending",
          }),
          // Closed under `none`: nothing will ever be published, so no "yet".
          card({ id: "e7", title: "Quiz 6", state: "closed", attemptId: "a7", attemptState: "submitted", results: "none" }),
        ],
      }),
      "GET /app/api/student/classrooms": ok([]),
    });
    render();
    const row = async (title: string) =>
      (await screen.findByText(title)).closest("div.rounded-card") as HTMLElement;
    expect(within(await row("Quiz 4")).getByText("rendue · résultats pas encore publiés")).toBeInTheDocument();
    expect(within(await row("Quiz 5")).getByText("temps écoulé · résultats pas encore publiés")).toBeInTheDocument();
    expect(within(await row("Quiz 6")).getByText("rendue")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Voir mes résultats" })).toBeNull();
    // The open section is empty: nothing to do, no Start for a handed-in quiz.
    expect(screen.queryByRole("button", { name: "Commencer" })).toBeNull();
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

  it("shows the empty state when nothing is open", async () => {
    mockFetch({
      "GET /app/api/student/home": ok({ open: [], upcoming: [], past: [], serverNow: "x" }),
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
          kept: { attemptId: "a8", attemptNumber: 1, score: { points: 7.5, totalPoints: 10, pending: false } },
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

    // Issue #203: with none left the server lists it under Past, and the
    // button follows `results`.
    it("shows the kept score under Past once no attempt is left, results only when available", async () => {
      mockFetch({
        "GET /app/api/student/home": ok({
          ...home,
          open: [],
          past: [
            retaking({ canRetake: false, attemptCount: 3, keep: "last" }),
            {
              ...retaking({ canRetake: false, attemptCount: 3 }),
              id: "e10",
              title: "Série 2 — Tableaux",
              state: "closed",
              results: "available",
            },
          ],
        }),
        "GET /app/api/student/classrooms": ok([]),
      });
      const { navigate } = render();
      expect(
        await screen.findByText("Dernier score 7.5 / 10 · tentatives : 3 sur 3"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Recommencer" })).toBeNull();
      const running = screen.getByText("Série 3 — Entraînement").closest("div.rounded-card")!;
      expect(within(running as HTMLElement).queryByRole("button")).toBeNull();
      const closed = screen.getByText("Série 2 — Tableaux").closest("div.rounded-card")!;
      await userEvent.click(within(closed as HTMLElement).getByRole("button", { name: "Voir mes résultats" }));
      expect(navigate).toHaveBeenCalledWith({ view: "feedback", attemptId: "a8" });
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

    it("prints no score the feedback policy hides", async () => {
      mockFetch({
        "GET /app/api/student/home": ok({
          ...home,
          open: [],
          past: [
            {
              ...retaking({
                canRetake: false,
                kept: { attemptId: "a8", attemptNumber: 1, score: null },
              }),
              state: "closed",
              results: "pending",
            },
          ],
        }),
        "GET /app/api/student/classrooms": ok([]),
      });
      render();
      expect(
        await screen.findByText("tentatives : 2 sur 3 · résultats pas encore publiés"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/score/)).toBeNull();
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
