import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AttemptOrLobby,
  AttemptView,
  EvaluationCard,
  Me,
  StudentFeedback,
  StudentHome as StudentHomeData,
} from "@quiz/contracts";

import { attemptEntryKey, attemptKey } from "../queryKeys";
import type { Route } from "../router";
import { makeQueryClient, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { AttemptPage } from "./Attempt";
import { Feedback } from "./Feedback";
import { StudentHome } from "./StudentHome";

/*
 * The retake loop of an exercise that allows several attempts (F-EVAL-15,
 * ADR-025), across the three screens it touches: the home card, the player
 * and the results page — mounted under ONE query client, as in the app, so a
 * cache entry left behind by attempt n is still there when attempt n + 1
 * opens (issue #120). Hand in, read the score, try again (issue #121).
 */

const EVAL = "11111111-1111-4111-8111-111111111111";
const FIRST = "22222222-2222-4222-8222-222222222222";
const SECOND = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";

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

type Keep = "best" | "last";

function view(
  attemptId: string,
  state: AttemptView["attempt"]["state"],
  over: { mode?: "exam" | "exercise"; keep?: Keep; answer?: unknown } = {},
): AttemptView {
  const mode = over.mode ?? "exercise";
  return {
    attempt: {
      id: attemptId,
      state,
      startedAt: "2026-09-20T10:01:00.000Z",
      deadlineAt: null,
      lastItemId: null,
      serverNow: "2026-09-20T10:01:00.000Z",
      preview: false,
      readOnly: state !== "in_progress",
    },
    evaluation: {
      id: EVAL,
      title: "Série 3 — Entraînement",
      mode,
      state: "running",
      settings: {
        navigation: "free",
        presentation: "zen",
        lobby: "skip",
        shuffleItems: false,
        shuffleChoices: false,
        timing: "manual",
        showProgressBar: true,
        logVisibility: true,
        requireFullscreen: false,
        ...(mode === "exercise"
          ? { retakes: { enabled: true, keep: over.keep ?? "best", maxAttempts: 3 } }
          : {}),
      },
      feedbackPolicy: {
        when: "on_release",
        showAnswer: true,
        showKey: false,
        showExplanation: false,
        showHiddenCaseNames: true,
        showTeacherComment: true,
      },
      pausedAt: null,
      totalPoints: 1,
    },
    items: [
      {
        id: ITEM,
        position: 1,
        points: 1,
        type: "mcq",
        milestone: false,
        student: {
          prompt: "Quelle expression donne l'adresse de `x` ?",
          mode: "single",
          choices: [
            { id: 0, text: "&x" },
            { id: 1, text: "*x" },
          ],
        },
        answer: over.answer ?? null,
        revision: over.answer === undefined ? 0 : 1,
        markedDone: false,
        skipped: false,
        flagged: false,
        locked: false,
      },
    ],
  };
}

const attempt = (v: AttemptView): AttemptOrLobby => ({ kind: "attempt", view: v });

function card(canRetake: boolean, keep: Keep = "best"): EvaluationCard {
  return {
    id: EVAL,
    title: "Série 3 — Entraînement",
    mode: "exercise",
    state: "running",
    classroomId: "55555555-5555-4555-8555-555555555555",
    classroomName: "PRG1-2026",
    courseCode: "PRG1",
    opensAt: null,
    closesAt: null,
    durationS: null,
    attemptId: FIRST,
    attemptState: "submitted",
    grade: null,
    deadlineAt: null,
    retakes: {
      keep,
      maxAttempts: 3,
      attemptCount: 1,
      canRetake,
      kept: { attemptId: FIRST, attemptNumber: 1, score: { points: 1, totalPoints: 1, pending: false } },
    },
  };
}

const home = (c: EvaluationCard): StudentHomeData => ({
  open: [c],
  upcoming: [],
  past: [],
  serverNow: "2026-09-20T10:00:00.000Z",
});

function feedback(
  refusal: "max_attempts" | "closed" | "not_open" | "unfinished" | null,
  over: { keep?: Keep; attemptCount?: number } = {},
): StudentFeedback {
  return {
    available: false,
    reason: "retakes_open",
    evaluation: { id: EVAL, title: "Série 3 — Entraînement" },
    score: { points: 1, totalPoints: 1, pending: false },
    retake: {
      evaluationId: EVAL,
      keep: over.keep ?? "best",
      maxAttempts: 3,
      attemptCount: over.attemptCount ?? 1,
      refusal,
    },
  };
}

/** The ONE query client and the three screens, routed like `App` does. */
function mount(start: Route, seed?: (qc: ReturnType<typeof makeQueryClient>) => void) {
  const routes: Route[] = [];
  function Flow() {
    const [route, setRoute] = useState<Route>(start);
    const navigate = (r: Route) => {
      routes.push(r);
      setRoute(r);
    };
    if (route.view === "home") return <StudentHome me={me} navigate={navigate} />;
    if (route.view === "attempt") {
      return <AttemptPage evaluationId={route.evaluationId} navigate={navigate} />;
    }
    if (route.view === "feedback") {
      return <Feedback attemptId={route.attemptId} navigate={navigate} />;
    }
    return <p>elsewhere</p>;
  }
  const queryClient = makeQueryClient();
  seed?.(queryClient);
  return { routes, ...renderWithProviders(<Flow />, { locale: "fr", queryClient }) };
}

/** jsdom has no EventSource; the player opens one on its attempt topic. */
const topics: string[] = [];
class FakeStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(readonly url: string) {
    topics.push(decodeURIComponent(url));
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeStream);
});
afterEach(() => {
  topics.length = 0;
  vi.stubGlobal("EventSource", undefined);
});

/** The routes every player mount calls on its own. */
const playerRoutes = (id: string) => ({
  [`POST /app/api/attempts/${id}/position`]: noContent(),
  [`POST /app/api/attempts/${id}/events`]: noContent(),
});

describe("retakes on an exercise (issues #120, #121)", () => {
  it("opens a FRESH attempt from the home card, never the hand-in screen of the last one", async () => {
    const answered = view(FIRST, "submitted", { answer: { selected: [0] } });
    const { calls } = mockFetch({
      "GET /app/api/student/home": ok(home(card(true))),
      "GET /app/api/student/classrooms": ok([]),
      [`POST /app/api/evaluations/${EVAL}/retake`]: ok(attempt(view(SECOND, "in_progress"))),
      [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(attempt(view(SECOND, "in_progress"))),
      [`GET /app/api/attempts/${SECOND}`]: ok(attempt(view(SECOND, "in_progress"))),
      ...playerRoutes(SECOND),
    });
    // Attempt 1 was taken in this very session: its entry is still cached.
    const { routes } = mount({ view: "home" }, (qc) => {
      qc.setQueryData(attemptEntryKey(EVAL, null), attempt(answered));
      qc.setQueryData(attemptKey(FIRST), attempt(answered));
    });

    await userEvent.click(await screen.findByRole("button", { name: "Recommencer" }));

    expect(await screen.findByText("Question 1")).toBeInTheDocument();
    expect(screen.queryByText("Rendu")).toBeNull();
    // Blank: nothing of attempt 1 came along, and nothing was written to it.
    expect(screen.queryByText("Répondue")).toBeNull();
    expect(routes.some((r) => r.view === "feedback")).toBe(false);
    expect(calls.some((c) => c.url.includes(FIRST))).toBe(false);
    // The live channel follows the new attempt.
    await waitFor(() => expect(topics.at(-1)).toContain(`attempt:${SECOND}`));
    expect(topics.some((t) => t.includes(`attempt:${FIRST}`))).toBe(false);
  });

  it("goes from Hand in straight to the score, which offers Try again", async () => {
    mockFetch({
      [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(attempt(view(FIRST, "in_progress"))),
      [`GET /app/api/attempts/${FIRST}`]: ok(attempt(view(FIRST, "in_progress"))),
      [`POST /app/api/attempts/${FIRST}/submit`]: ok({
        state: "submitted",
        submittedAt: "2026-09-20T10:05:00.000Z",
        serverNow: "2026-09-20T10:05:00.000Z",
      }),
      [`GET /app/api/attempts/${FIRST}/feedback`]: ok(feedback(null)),
      [`POST /app/api/evaluations/${EVAL}/retake`]: ok(attempt(view(SECOND, "in_progress"))),
      [`GET /app/api/attempts/${SECOND}`]: ok(attempt(view(SECOND, "in_progress"))),
      ...playerRoutes(FIRST),
      ...playerRoutes(SECOND),
    });
    const { routes } = mount({ view: "attempt", evaluationId: EVAL });

    await userEvent.click(await screen.findByRole("button", { name: "Rendre" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Rendre" }),
    );

    // No "your answers are with your teacher" in between.
    expect(await screen.findByText("Score de cette tentative")).toBeInTheDocument();
    expect(screen.queryByText("Rendu")).toBeNull();
    expect(routes).toContainEqual({ view: "feedback", attemptId: FIRST });
    expect(screen.getByText("tentatives : 1 sur 3")).toBeInTheDocument();

    // Try again, from the results: a blank attempt, not the one just handed in.
    await userEvent.click(screen.getByRole("button", { name: "Recommencer" }));
    expect(await screen.findByText("Question 1")).toBeInTheDocument();
    expect(screen.queryByText("Répondue")).toBeNull();
    expect(routes.at(-1)).toEqual({ view: "attempt", evaluationId: EVAL });
    await waitFor(() => expect(topics.at(-1)).toContain(`attempt:${SECOND}`));
  });

  it("asks first on the results page when the LAST attempt counts", async () => {
    const { calls } = mockFetch({
      [`GET /app/api/attempts/${FIRST}/feedback`]: ok(feedback(null, { keep: "last" })),
      [`POST /app/api/evaluations/${EVAL}/retake`]: ok(attempt(view(SECOND, "in_progress"))),
      [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(attempt(view(SECOND, "in_progress"))),
      [`GET /app/api/attempts/${SECOND}`]: ok(attempt(view(SECOND, "in_progress"))),
      ...playerRoutes(SECOND),
    });
    mount({ view: "feedback", attemptId: FIRST });

    await userEvent.click(await screen.findByRole("button", { name: "Recommencer" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("C'est votre dernière tentative qui compte")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(calls.some((c) => c.url.endsWith("/retake"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Recommencer" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Recommencer" }),
    );
    expect(await screen.findByText("Question 1")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith("/retake"))).toHaveLength(1);
  });

  it.each([
    ["max_attempts", "Vous avez utilisé vos 3 tentatives."],
    ["closed", "L'exercice est terminé : plus de nouvelle tentative."],
    ["not_open", "L'exercice ne prend pas de nouvelle tentative pour l'instant."],
  ] as const)("says why, with no dead button, when the server refuses (%s)", async (refusal, why) => {
    mockFetch({
      [`GET /app/api/attempts/${FIRST}/feedback`]: ok(feedback(refusal, { attemptCount: 3 })),
    });
    mount({ view: "feedback", attemptId: FIRST });
    expect(await screen.findByText(why)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recommencer" })).toBeNull();
  });

  it("offers to continue the attempt already open instead of a second one", async () => {
    mockFetch({
      [`GET /app/api/attempts/${FIRST}/feedback`]: ok(feedback("unfinished", { attemptCount: 2 })),
    });
    const { routes } = mount({ view: "feedback", attemptId: FIRST });
    await userEvent.click(await screen.findByRole("button", { name: "Continuer" }));
    expect(screen.queryByRole("button", { name: "Recommencer" })).toBeNull();
    expect(routes.at(-1)).toEqual({ view: "attempt", evaluationId: EVAL });
  });

  it("keeps the hand-in screen of an exam", async () => {
    const exam = (state: AttemptView["attempt"]["state"]) => view(FIRST, state, { mode: "exam" });
    mockFetch({
      [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(attempt(exam("in_progress"))),
      [`GET /app/api/attempts/${FIRST}`]: ok(attempt(exam("in_progress"))),
      [`POST /app/api/attempts/${FIRST}/submit`]: ok({
        state: "submitted",
        submittedAt: "2026-09-20T10:05:00.000Z",
        serverNow: "2026-09-20T10:05:00.000Z",
      }),
      ...playerRoutes(FIRST),
    });
    const { routes } = mount({ view: "attempt", evaluationId: EVAL });
    await userEvent.click(await screen.findByRole("button", { name: "Rendre" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Rendre" }),
    );
    expect(await screen.findByText("Rendu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Voir mes résultats" })).toBeInTheDocument();
    expect(routes).toEqual([]);
  });
});
