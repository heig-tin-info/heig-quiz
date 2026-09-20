import axe from "axe-core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AttemptOrLobby, AttemptView } from "@quiz/contracts";

import { mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { AttemptPage } from "./Attempt";

/*
 * The player, end to end in jsdom: what a reload brings back (F-LIVE-06), the
 * two keyboard shortcuts of the DoD, and an axe pass on the rendered screen.
 *
 * `POST /evaluations/:id/attempt` is what a reload of `/take/:id` actually
 * calls — it is idempotent and answers with the stored answers and the stored
 * position — so the restore test goes through the real route rather than
 * through a component prop.
 */

const EVAL = "e1";
const ATTEMPT = "a1";

const attemptView = (over: Partial<AttemptView["attempt"]> = {}): AttemptView => ({
  attempt: {
    id: ATTEMPT,
    state: "in_progress",
    startedAt: "2026-09-20T09:50:00.000Z",
    deadlineAt: "2026-09-20T10:20:00.000Z",
    lastItemId: "i2",
    serverNow: "2026-09-20T10:00:00.000Z",
    preview: false,
    ...over,
  },
  evaluation: {
    id: EVAL,
    title: "Quiz 3 — Pointeurs",
    mode: "exam",
    state: "running",
    settings: {
      navigation: "free",
      presentation: "zen",
      lobby: "manual",
      shuffleItems: false,
      shuffleChoices: true,
      timing: "duration",
      showProgressBar: true,
      logVisibility: true,
      requireFullscreen: false,
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
    totalPoints: 4,
  },
  items: [
    {
      id: "i1",
      position: 1,
      points: 2,
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
      answer: { selected: [1] },
      revision: 3,
      markedDone: false,
      locked: false,
    },
    {
      id: "i2",
      position: 2,
      points: 1,
      type: "short",
      milestone: false,
      student: { prompt: "Combien d'octets pour un `int` ?", kind: "number" },
      answer: { text: "4" },
      revision: 2,
      markedDone: false,
      locked: false,
    },
    {
      id: "i3",
      position: 3,
      points: 1,
      type: "short",
      milestone: false,
      student: { prompt: "Et pour un `char` ?", kind: "number" },
      answer: null,
      revision: 0,
      markedDone: false,
      locked: false,
    },
  ],
});

const entry = (view: AttemptView): AttemptOrLobby => ({ kind: "attempt", view });

function stubs(view: AttemptView) {
  return mockFetch({
    [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(entry(view)),
    [`GET /app/api/attempts/${ATTEMPT}`]: ok(view),
    [`POST /app/api/attempts/${ATTEMPT}/position`]: noContent(),
    [`POST /app/api/attempts/${ATTEMPT}/events`]: noContent(),
    [`POST /app/api/attempts/${ATTEMPT}/answers/i1/done`]: ok({
      done: true,
      nextItemId: null,
      serverNow: "2026-09-20T10:00:01.000Z",
    }),
    [`POST /app/api/attempts/${ATTEMPT}/answers/i2/done`]: ok({
      done: true,
      nextItemId: null,
      serverNow: "2026-09-20T10:00:01.000Z",
    }),
  });
}

const render = (view = attemptView()) =>
  renderWithProviders(<AttemptPage evaluationId={EVAL} navigate={() => {}} />, {
    locale: "fr",
    route: `/take/${EVAL}`,
  });

describe("the zen player", () => {
  it("restores the answers and the position after a reload (F-LIVE-06)", async () => {
    const view = attemptView();
    stubs(view);
    render(view);

    // The position the server remembered, not the first question.
    expect(await screen.findByText("Question 2 sur 3")).toBeInTheDocument();
    const field = (await screen.findByLabelText("Votre réponse")) as HTMLInputElement;
    expect(field.value).toBe("4");
    // And the answer of a question the student is not looking at is loaded too.
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(await screen.findByText("Question 1 sur 3")).toBeInTheDocument();
    const chosen = await screen.findByRole("radio", { name: "*x" });
    expect(chosen).toBeChecked();
  });

  it("tells the server where the student is", async () => {
    const view = attemptView();
    const { calls } = stubs(view);
    render(view);
    await screen.findByText("Question 2 sur 3");
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.endsWith("/position") && (c.body as { itemId: string }).itemId === "i2",
        ),
      ).toBe(true),
    );
  });

  it("moves with Alt + arrows and marks as done with Ctrl + Enter", async () => {
    const view = attemptView();
    const { calls } = stubs(view);
    render(view);
    await screen.findByText("Question 2 sur 3");

    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(await screen.findByText("Question 3 sur 3")).toBeInTheDocument();
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(await screen.findByText("Question 2 sur 3")).toBeInTheDocument();

    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/answers/i2/done"))).toBe(true),
    );
  });

  // Real timers, because the debounce is the thing under test. Mounting the
  // lazy player, typing and waiting 300 ms costs more than the 5 s default.
  it("autosaves a change, debounced, with a growing revision", { timeout: 15_000 }, async () => {
    const view = attemptView();
    const saves: unknown[] = [];
    mockFetch({
      [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(entry(view)),
      [`POST /app/api/attempts/${ATTEMPT}/position`]: noContent(),
      [`POST /app/api/attempts/${ATTEMPT}/events`]: noContent(),
      [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: (call) => {
        saves.push(call.body);
        return ok({ revision: 3, accepted: true, serverNow: "2026-09-20T10:00:02.000Z" });
      },
    });
    render(view);
    const field = await screen.findByLabelText("Votre réponse");
    await userEvent.type(field, "2");
    await waitFor(() => expect(saves).toHaveLength(1));
    // Seeded from the view's revision 2, so the first local change is 3.
    expect((saves[0] as { revision: number }).revision).toBe(3);
    expect((saves[0] as { payload: { text: string } }).payload.text).toBe("42");
    // The badge carries the word twice on purpose: visible from `sm` up, and
    // for a screen reader under it, where the bar has no room for it.
    expect(await screen.findAllByText("Sauvegardé")).not.toHaveLength(0);
  });

  it("shows the time-up screen and stops writing once the attempt is closed", async () => {
    const view = attemptView({ state: "expired" });
    const { calls } = stubs(view);
    render(view);
    expect(await screen.findByText("Temps écoulé")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("names the progress strip and its segments for a screen reader", async () => {
    const view = attemptView();
    stubs(view);
    render(view);
    const strip = await screen.findByRole("navigation", {
      name: "Progression : question 2 sur 3",
    });
    expect(within(strip).getAllByRole("button")).toHaveLength(3);
    expect(
      within(strip).getByRole("button", { name: "Question 2, en cours" }),
    ).toBeInTheDocument();
  });

  it("has no axe violation", async () => {
    const view = attemptView();
    stubs(view);
    const { container } = render(view);
    await screen.findByText("Question 2 sur 3");
    const results = await axe.run(container, {
      // jsdom computes no layout and no cascade, so contrast is measured in
      // the screenshots instead (DESIGN.md holds the measured table).
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
