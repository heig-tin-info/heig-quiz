import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EvaluationCard, Me, StudentHome as StudentHomeData } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { StudentHome } from "./StudentHome";

const me: Me = {
  id: "u1",
  email: "lea.perret@heig-vd.ch",
  givenName: "Léa",
  familyName: "Perret",
  role: "student",
  lastLoginAt: null,
  avatarUrl: null,
  hasUploadedAvatar: false,
  locale: "fr",
  dateFormat: null,
  mcqPolicy: null,
  coach: { enabled: false, seen: [] },
};

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
  ...over,
});

const home: StudentHomeData = {
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
    await userEvent.click(await screen.findByRole("button", { name: "Voir" }));
    expect(navigate).toHaveBeenCalledWith({ view: "feedback", attemptId: "a3" });
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

  it("joins a classroom by code", async () => {
    const { calls } = mockFetch({
      "GET /app/api/student/home": ok(home),
      "GET /app/api/student/classrooms": ok([]),
      "POST /app/api/join/PRG1-2026": ok({
        classroomId: "r1",
        classroomName: "PRG1-2026",
        courseCode: "PRG1",
        status: "joined",
      }),
    });
    render();
    await userEvent.type(await screen.findByLabelText("Code de la classe"), "PRG1-2026");
    await userEvent.click(screen.getByRole("button", { name: "Rejoindre" }));
    expect(calls.some((c) => c.url === "/app/api/join/PRG1-2026" && c.method === "POST")).toBe(
      true,
    );
    expect(await screen.findByText("Vous avez rejoint PRG1-2026.")).toBeInTheDocument();
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

    it("offers the kept attempt's score once no attempt is left", async () => {
      mockFetch({
        "GET /app/api/student/home": ok({
          ...home,
          open: [retaking({ canRetake: false, attemptCount: 3, keep: "last" })],
        }),
        "GET /app/api/student/classrooms": ok([]),
      });
      const { navigate } = render();
      expect(
        await screen.findByText("Dernier score 7.5 / 10 · tentatives : 3 sur 3"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Recommencer" })).toBeNull();
      const row = screen.getByText("Série 3 — Entraînement").closest("div.rounded-card")!;
      await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Voir" }));
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
            },
          ],
        }),
        "GET /app/api/student/classrooms": ok([]),
      });
      render();
      expect(await screen.findByText("tentatives : 2 sur 3")).toBeInTheDocument();
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
