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
  grade: null,
  deadlineAt: null,
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

  it("opens a past attempt's result", async () => {
    mockFetch({
      "GET /app/api/student/home": ok(home),
      "GET /app/api/student/classrooms": ok([]),
    });
    const { navigate } = render();
    await userEvent.click(await screen.findByRole("button", { name: "Voir" }));
    expect(navigate).toHaveBeenCalledWith({ view: "studentResults", attemptId: "a3" });
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
});
