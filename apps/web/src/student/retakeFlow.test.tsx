import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AttemptOrLobby,
  AttemptView,
  EvaluationCard,
  Me,
  ReviewItem,
  StudentFeedback,
  StudentHome as StudentHomeData,
} from "@quiz/contracts";

import { attemptEntryKey, attemptKey } from "../queryKeys";
import type { Route } from "../router";
import { makeMe } from "../test/fixtures";
import { makeQueryClient, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { buttonClass } from "../ui";
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

type Keep = "best" | "last";

function view(
  attemptId: string,
  state: AttemptView["attempt"]["state"],
  over: { mode?: "exam" | "exercise"; keep?: Keep; answer?: unknown } = {},
): AttemptView {
  const mode = over.mode ?? "exercise";
  return {
    conditions: { announced: [], imposed: [] },
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
        bonus: false,
        intro: null,
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
        acquired: false,
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
    attemptStartedAt: null,
    grade: null,
    deadlineAt: null,
    retakes: {
      keep,
      maxAttempts: 3,
      scope: "all",
      attemptCount: 1,
      canRetake,
      kept: { attemptId: FIRST, attemptNumber: 1, score: { points: 1, totalPoints: 1, pendingCount: 0 } },
    },
    results: "pending",
    trustedClients: [],
    conditions: null,
  };
}

const home = (c: EvaluationCard): StudentHomeData => ({
  polls: [],
  groupSets: [],
  open: [{ kind: "evaluation", ...c }],
  upcoming: [],
  past: [],
  serverNow: "2026-09-20T10:00:00.000Z",
});

function feedback(
  refusal: "max_attempts" | "closed" | "not_open" | "unfinished" | null,
  over: { keep?: Keep; attemptCount?: number; toReview?: number; review?: ReviewItem[] } = {},
): StudentFeedback {
  return {
    available: false,
    reason: "retakes_open",
    evaluation: { id: EVAL, title: "Série 3 — Entraînement" },
    score: { points: 1, totalPoints: 1, pendingCount: 0 },
    retake: {
      evaluationId: EVAL,
      keep: over.keep ?? "best",
      maxAttempts: 3,
      attemptCount: over.attemptCount ?? 1,
      refusal,
      // ADR-090: `toReview` given is the scope `to_review`.
      scope: over.toReview === undefined ? "all" : "to_review",
      toReview: over.toReview ?? null,
    },
    ...(over.review ? { review: over.review } : {}),
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
      qc.setQueryData(attemptEntryKey(EVAL), attempt(answered));
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

  // Issue #203: the hand-in screen offers the results only when the feedback
  // page has something to show; otherwise Back to home is the one action.
  async function handInExam(feedbackReply: StudentFeedback) {
    const exam = (state: AttemptView["attempt"]["state"]) => view(FIRST, state, { mode: "exam" });
    const { calls } = mockFetch({
      [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(attempt(exam("in_progress"))),
      [`GET /app/api/attempts/${FIRST}`]: ok(attempt(exam("in_progress"))),
      [`POST /app/api/attempts/${FIRST}/submit`]: ok({
        state: "submitted",
        submittedAt: "2026-09-20T10:05:00.000Z",
        serverNow: "2026-09-20T10:05:00.000Z",
      }),
      [`GET /app/api/attempts/${FIRST}/feedback`]: ok(feedbackReply),
      ...playerRoutes(FIRST),
    });
    const mounted = { ...mount({ view: "attempt", evaluationId: EVAL }), calls };
    await userEvent.click(await screen.findByRole("button", { name: "Rendre" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Rendre" }),
    );
    expect(await screen.findByText("Rendu")).toBeInTheDocument();
    return mounted;
  }

  it("keeps the hand-in screen of an exam, with Back to home alone before the release", async () => {
    const { routes, calls } = await handInExam({
      available: false,
      reason: "results_pending",
      evaluation: { id: EVAL, title: "Série 3 — Entraînement" },
    });
    // The screen asked the feedback route; its row shows once the answer is in.
    const home = await screen.findByRole("button", { name: "Retour à l'accueil" });
    expect(calls.some((c) => c.url.endsWith(`${FIRST}/feedback`))).toBe(true);
    expect(home.className).toBe(buttonClass("primary", "md", ""));
    expect(screen.queryByRole("button", { name: "Voir mes résultats" })).toBeNull();
    expect(routes).toEqual([]);
  });

  it("offers the results on the hand-in screen under the immediate policy", async () => {
    const { routes } = await handInExam({
      available: true,
      evaluation: { id: EVAL, title: "Série 3 — Entraînement", releasedAt: null },
      attemptId: FIRST,
      points: 1,
      totalPoints: 1,
      grade: 6,
      pendingCount: 0,
      items: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Voir mes résultats" }));
    expect(routes).toContainEqual({ view: "feedback", attemptId: FIRST });
  });
});

describe("a retake of the questions to review (ADR-090)", () => {
  const REVIEW: ReviewItem[] = [
    { itemId: ITEM, rank: 0, standing: "acquired" },
    { itemId: SECOND, rank: 1, standing: "to_review" },
    { itemId: FIRST, rank: 2, standing: "pending" },
  ];

  it("offers the questions to review first, everything second, and lists each question's standing", async () => {
    const carried = view(SECOND, "in_progress", { answer: { selected: [0] } });
    carried.items[0]!.acquired = true;
    const { calls } = mockFetch({
      [`GET /app/api/attempts/${FIRST}/feedback`]: ok(feedback(null, { toReview: 2, review: REVIEW })),
      [`POST /app/api/evaluations/${EVAL}/retake`]: ok(attempt(carried)),
      [`GET /app/api/attempts/${SECOND}`]: ok(attempt(carried)),
      ...playerRoutes(SECOND),
    });
    mount({ view: "feedback", attemptId: FIRST });

    const partial = await screen.findByRole("button", { name: "Refaire les questions à revoir (2)" });
    const all = screen.getByRole("button", { name: "Tout refaire" });
    expect(partial.className).toBe(buttonClass("primary", "md", ""));
    expect(all.className).toBe(buttonClass("secondary", "md", ""));
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Question 1Acquise",
      "Question 2À revoir",
      "Question 3En attente de correction",
    ]);

    await userEvent.click(partial);
    expect(calls.find((c) => c.url.endsWith("/retake"))?.body).toEqual({ scope: "to_review" });
    // The player: the carried question, read-only and marked.
    expect(await screen.findByText("Acquise")).toBeInTheDocument();
    expect(
      screen.getByText("Acquise lors de votre tentative précédente : conservée telle quelle, avec ses points."),
    ).toBeInTheDocument();
  });

  it("sends Redo everything as a whole retake", async () => {
    const { calls } = mockFetch({
      [`GET /app/api/attempts/${FIRST}/feedback`]: ok(feedback(null, { toReview: 2, review: REVIEW })),
      [`POST /app/api/evaluations/${EVAL}/retake`]: ok(attempt(view(SECOND, "in_progress"))),
      [`GET /app/api/attempts/${SECOND}`]: ok(attempt(view(SECOND, "in_progress"))),
      ...playerRoutes(SECOND),
    });
    mount({ view: "feedback", attemptId: FIRST });
    await userEvent.click(await screen.findByRole("button", { name: "Tout refaire" }));
    expect(await screen.findByText("Question 1")).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith("/retake"))?.body).toEqual({ scope: "all" });
  });

  it("leaves Redo everything alone once every question is acquired", async () => {
    mockFetch({ [`GET /app/api/attempts/${FIRST}/feedback`]: ok(feedback(null, { toReview: 0 })) });
    mount({ view: "feedback", attemptId: FIRST });
    expect(await screen.findByText("Toutes les questions sont acquises.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tout refaire" }).className).toBe(
      buttonClass("primary", "md", ""),
    );
    expect(screen.queryByRole("button", { name: /Refaire les questions/ })).toBeNull();
  });

  it("takes the card's Try again to the results page, where the choice is", async () => {
    const base = card(true);
    const { calls } = mockFetch({
      "GET /app/api/student/home": ok(home({ ...base, retakes: { ...base.retakes!, scope: "to_review" } })),
      "GET /app/api/student/classrooms": ok([]),
      [`GET /app/api/attempts/${FIRST}/feedback`]: ok(feedback(null, { toReview: 2, review: REVIEW })),
    });
    const { routes } = mount({ view: "home" });
    await userEvent.click(await screen.findByRole("button", { name: "Recommencer" }));
    expect(routes.at(-1)).toEqual({ view: "feedback", attemptId: FIRST });
    expect(await screen.findByRole("button", { name: "Refaire les questions à revoir (2)" })).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/retake"))).toBe(false);
  });
});
