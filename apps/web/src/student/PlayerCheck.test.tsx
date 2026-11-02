import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AttemptOrLobby, AttemptView, ItemCorrection } from "@quiz/contracts";

import { makeAttemptItem, makeAttemptView } from "../test/attempt-fixtures";
import { elapse, flowingClock } from "../test/clock";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { AttemptPage } from "./Attempt";

/*
 * The per-question check of an exercise (ADR-124 §3), end to end in the
 * player: Check is offered on an open question of an exercise only — the
 * primary once it holds an answer, disabled on an empty one — and a checked
 * question is locked and shows its correction, the one the server sent:
 * verdict, key through the type's own review, explanation. A verdict to come
 * is read again from the attempt.
 */

const EVAL = "e1";
const ATTEMPT = "a1";
const NOW = "2026-09-20T10:00:01.000Z";

const numberConstraints = { minLength: 0, maxLength: 255, integer: true, min: 0 };

/** Two questions: an mcq (the key is choice 0, "&x") and an empty short. */
function exerciseView(
  mode: "exercise" | "exam" = "exercise",
  over: Partial<AttemptView["items"][number]> = {},
): AttemptView {
  return makeAttemptView({
    attempt: { id: ATTEMPT, lastItemId: "i1" },
    evaluation: { id: EVAL, mode },
    items: [
      makeAttemptItem({ id: "i1", position: 1, points: 2, answer: { selected: [1] }, revision: 3, ...over }),
      makeAttemptItem({
        id: "i2",
        position: 2,
        type: "short",
        student: { prompt: "Combien d'octets pour un `int` ?", kind: "number", constraints: numberConstraints },
      }),
    ],
  });
}

const correction = (over: Partial<ItemCorrection> = {}): ItemCorrection => ({
  verdict: "wrong",
  points: 0,
  maxPoints: 2,
  solution: { correct: [0] },
  explanation: "`&x` donne l'adresse de `x`.",
  details: null,
  ...over,
});

const entry = (view: AttemptView): AttemptOrLobby => ({ kind: "attempt", view });

function stubs(view: AttemptView, overrides: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(entry(view)),
    [`GET /app/api/attempts/${ATTEMPT}`]: ok(entry(view)),
    [`POST /app/api/attempts/${ATTEMPT}/position`]: noContent(),
    [`POST /app/api/attempts/${ATTEMPT}/events`]: noContent(),
    [`PUT /app/api/attempts/${ATTEMPT}/answers/i1`]: ok({ revision: 4, accepted: true, serverNow: NOW }),
    [`POST /app/api/attempts/${ATTEMPT}/answers/i1/check`]: ok({
      revision: 4,
      accepted: true,
      serverNow: NOW,
      correction: correction(),
    }),
    ...overrides,
  });
}

const render = () =>
  renderWithProviders(<AttemptPage evaluationId={EVAL} navigate={() => {}} />, {
    locale: "fr",
    route: `/take/${EVAL}`,
  });

/** `buttonClass` writes the accent fill, and only for `primary`. */
const isPrimary = (el: HTMLElement) => el.classList.contains("bg-accent");

const checkButton = () => screen.findByRole("button", { name: "Vérifier" });

describe("checking a question of an exercise (ADR-124 §3)", () => {
  it("offers Check as the primary on an answered question, and says it locks", async () => {
    stubs(exerciseView());
    render();
    const check = await checkButton();
    expect(check).toBeEnabled();
    expect(isPrimary(check)).toBe(true);
    // One primary: Next steps back while Check holds the accent.
    expect(isPrimary(screen.getByRole("button", { name: /Suivant/ }))).toBe(false);
    expect(screen.getByText(/verrouille votre réponse pour cette tentative/)).toBeInTheDocument();
  });

  it("disables Check on an empty question and says why", async () => {
    stubs(exerciseView("exercise", { answer: null, revision: 0 }));
    render();
    const check = await checkButton();
    expect(check).toBeDisabled();
    expect(screen.getByText("Répondez à la question pour la vérifier.")).toBeInTheDocument();
  });

  it("never offers Check in an exam", async () => {
    stubs(exerciseView("exam"));
    render();
    await screen.findByText("Question 1");
    expect(screen.queryByRole("button", { name: "Vérifier" })).toBeNull();
  });

  it("sends the answer on screen, then locks the question and shows its correction", async () => {
    const { calls } = stubs(exerciseView());
    render();
    await userEvent.click(await checkButton());
    // The verdict above the review, and the review's own word on the ticked
    // choice; then the explanation.
    await waitFor(() => expect(screen.getAllByText("Faux")).toHaveLength(2));
    expect(screen.getByText("Explication")).toBeInTheDocument();
    expect(screen.getByText("Vérifiée")).toBeInTheDocument();
    expect(screen.getByText("Réponse verrouillée jusqu'à la fin de cette tentative.")).toBeInTheDocument();
    // Locked: the player's choices are gone, so is Check; Next takes the accent.
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Vérifier" })).toBeNull();
    expect(isPrimary(screen.getByRole("button", { name: /Suivant/ }))).toBe(true);

    const sent = calls.find((c) => c.url.endsWith("/answers/i1/check"));
    expect(sent?.method).toBe("POST");
    expect(sent?.body).toMatchObject({ payload: { selected: [1] }, revision: 4, coordinates: "position" });
    // No autosave lands on a checked question.
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("shows a correct verdict", async () => {
    stubs(exerciseView("exercise", { answer: { selected: [0] } }), {
      [`POST /app/api/attempts/${ATTEMPT}/answers/i1/check`]: ok({
        revision: 4,
        accepted: true,
        serverNow: NOW,
        correction: correction({ verdict: "correct", points: 2 }),
      }),
    });
    render();
    await userEvent.click(await checkButton());
    await waitFor(() => expect(screen.getAllByText("Juste")).toHaveLength(2));
  });

  it("brings a checked question back locked with its correction on a reload", async () => {
    stubs(exerciseView("exercise", { checked: true, correction: correction({ verdict: "partial", points: 1 }) }));
    render();
    expect(await screen.findByText("Partiellement juste")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Vérifier" })).toBeNull();
  });

  it("reads the attempt again until a pending verdict lands", async () => {
    const user = flowingClock();
    const pending = correction({ verdict: "pending", points: null });
    const resolved = exerciseView("exercise", { checked: true, correction: correction({ verdict: "correct", points: 2 }) });
    let reads = 0;
    stubs(exerciseView(), {
      [`POST /app/api/attempts/${ATTEMPT}/answers/i1/check`]: ok({
        revision: 4,
        accepted: true,
        serverNow: NOW,
        correction: pending,
      }),
      // The runner answers on the second read.
      [`GET /app/api/attempts/${ATTEMPT}`]: () => {
        reads += 1;
        return ok(entry(reads < 2 ? exerciseView("exercise", { checked: true, correction: pending }) : resolved));
      },
    });
    render();
    await user.click(await checkButton());
    expect(await screen.findByText("Pas encore corrigée")).toBeInTheDocument();
    expect(screen.getByText("Vos points s'affichent ici une fois la réponse corrigée.")).toBeInTheDocument();

    await elapse(3_100);
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.getByText("Pas encore corrigée")).toBeInTheDocument();
    await elapse(3_100);
    expect(await screen.findByText("Juste")).toBeInTheDocument();
    // Resolved: the reads stop.
    await elapse(10_000);
    expect(reads).toBe(2);
  });

  it("does not poll on a reload that finds a verdict pending: only a check arms it", async () => {
    flowingClock();
    let reads = 0;
    const pendingView = exerciseView("exercise", {
      checked: true,
      correction: correction({ verdict: "pending", points: null }),
    });
    stubs(pendingView, {
      [`GET /app/api/attempts/${ATTEMPT}`]: () => {
        reads += 1;
        return ok(entry(pendingView));
      },
    });
    render();
    expect(await screen.findByText("Pas encore corrigée")).toBeInTheDocument();
    await elapse(10_000);
    expect(reads).toBe(0);
  });

  it("says a question checked elsewhere is, and reads the attempt again", async () => {
    let reads = 0;
    const checkedView = exerciseView("exercise", { checked: true, correction: correction() });
    stubs(exerciseView(), {
      [`POST /app/api/attempts/${ATTEMPT}/answers/i1/check`]: fail(409, { error: "item_checked" }),
      [`GET /app/api/attempts/${ATTEMPT}`]: () => {
        reads += 1;
        return ok(entry(checkedView));
      },
    });
    render();
    await userEvent.click(await checkButton());
    expect(await screen.findByText("Question déjà vérifiée dans une autre fenêtre.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("Faux")).toHaveLength(2));
    expect(reads).toBeGreaterThan(0);
  });

  it("ends the attempt on a 410 and says the question was not checked", async () => {
    stubs(exerciseView(), {
      [`POST /app/api/attempts/${ATTEMPT}/answers/i1/check`]: fail(410, {
        error: "attempt_closed",
        reason: "deadline",
      }),
    });
    render();
    await userEvent.click(await checkButton());
    expect(await screen.findByText("Tentative fermée : cette question n'a pas été vérifiée.")).toBeInTheDocument();
  });
});
