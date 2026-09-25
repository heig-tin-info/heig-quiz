import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import type { AttemptView, EvaluationPreview, PreviewCorrection } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { EvaluationPreviewPage } from "./EvaluationPreviewPage";

/*
 * `/evaluations/:id/preview` (issue #75): the teacher walks the whole
 * evaluation in the student player, the answers stay in the tab, and one
 * grading call at the end shows the full correction. The question types are
 * the REAL ones from `@quiz/registry/client`, mounted through the student's
 * own `QuestionHost` by the student's own `PlayerView`.
 */

const EVAL = "e1";
const I1 = "11111111-1111-4111-8111-111111111111";
const I2 = "22222222-2222-4222-8222-222222222222";
const URL = `/app/api/evaluations/${EVAL}/preview`;

const view = (): AttemptView => ({
  attempt: {
    id: "00000000-0000-4000-8000-000000000000",
    state: "in_progress",
    startedAt: "2026-09-20T10:00:00.000Z",
    deadlineAt: null,
    lastItemId: null,
    serverNow: "2026-09-20T10:00:00.000Z",
    preview: true,
    readOnly: false,
  },
  evaluation: {
    id: EVAL,
    title: "Quiz 3 — Pointeurs",
    mode: "exam",
    state: "draft",
    settings: {
      navigation: "free",
      presentation: "zen",
      lobby: "manual",
      shuffleItems: true,
      shuffleChoices: true,
      timing: "duration",
      showProgressBar: true,
      logVisibility: true,
      requireFullscreen: false,
    },
    // The students get nothing before the release: the preview shows
    // everything anyway.
    feedbackPolicy: {
      when: "none",
      showAnswer: false,
      showKey: false,
      showExplanation: false,
      showHiddenCaseNames: false,
      showTeacherComment: false,
    },
    pausedAt: null,
    totalPoints: 3,
  },
  items: [
    {
      id: I1,
      position: 1,
      points: 2,
      type: "mcq",
      milestone: false,
      student: {
        prompt: "Quelle expression donne l'adresse de `x` ?",
        mode: "single",
        choices: [
          { id: 1, text: "*x" },
          { id: 0, text: "&x" },
        ],
      },
      answer: null,
      revision: 0,
      markedDone: false,
      locked: false,
    },
    {
      id: I2,
      position: 2,
      points: 1,
      type: "mcq",
      milestone: false,
      student: {
        prompt: "Quelle est la taille d'un `char` ?",
        mode: "single",
        choices: [
          { id: 0, text: "1 octet" },
          { id: 1, text: "2 octets" },
        ],
      },
      answer: null,
      revision: 0,
      markedDone: false,
      locked: false,
    },
  ],
});

const preview = (seed: number, durationS: number | null = 1800): EvaluationPreview => ({
  seed,
  durationS,
  view: view(),
});

const correction = (seed: number): PreviewCorrection => ({
  seed,
  points: 2,
  totalPoints: 3,
  grade: 4.3,
  scale: { kind: "linear", rounding: "nearest" },
  ungraded: 0,
  items: [
    {
      itemId: I1,
      position: 0,
      type: "mcq",
      status: "graded",
      points: 2,
      maxPoints: 2,
      verdict: "correct",
      student: view().items[0]!.student,
      answer: { selected: [0] },
      solution: { correct: [0] },
      explanation: "`&` prend l'adresse.",
      details: null,
    },
    {
      itemId: I2,
      position: 1,
      type: "mcq",
      status: "graded",
      points: 0,
      maxPoints: 1,
      verdict: "wrong",
      student: view().items[1]!.student,
      answer: null,
      solution: { correct: [0] },
      explanation: null,
      details: null,
    },
  ],
});

describe("EvaluationPreviewPage", () => {
  it("walks the evaluation in the player and shows the full correction", async () => {
    const user = userEvent.setup();
    let seeds = 41;
    const { calls } = mockFetch({
      [`POST ${URL}`]: () => ok(preview((seeds += 1))),
      [`POST ${URL}/grade`]: (call) => ok(correction((call.body as { seed: number }).seed)),
    });
    renderWithProviders(
      <StrictMode>
        <EvaluationPreviewPage id={EVAL} navigate={() => {}} />
      </StrictMode>,
    );

    // The banner, over the student's own player.
    expect(await screen.findByText("Preview — nothing is saved")).toBeInTheDocument();
    expect(screen.getByText("Quiz 3 — Pointeurs")).toBeInTheDocument();
    // One start, StrictMode or not: two would be two seeds for one click.
    expect(calls.filter((c) => c.url === URL)).toHaveLength(1);
    // The countdown of a 30-minute evaluation, counted from now.
    expect(screen.getByText(/^(29|30):\d\d$/)).toBeInTheDocument();

    await user.click(await screen.findByRole("radio", { name: "&x" }));
    await user.click(screen.getByRole("button", { name: "Hand in" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Hand in" }));

    expect(await screen.findByRole("heading", { name: "Preview correction" })).toBeInTheDocument();
    // Answers and the seed, nothing else: the server rebuilds the questions.
    const grading = calls.find((c) => c.url === `${URL}/grade`)!;
    expect(grading).toMatchObject({
      method: "POST",
      body: { seed: 42, answers: { [I1]: { selected: [0] } } },
    });
    // Points per question, and the grade, whatever the feedback policy says.
    expect(screen.getByText("4.3")).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByText("0 / 1")).toBeInTheDocument();
    expect(screen.getByText("Explanation")).toBeInTheDocument();
  });

  it("restarts with a new seed from the correction", async () => {
    const user = userEvent.setup();
    let seeds = 0;
    const { calls } = mockFetch({
      [`POST ${URL}`]: () => ok(preview((seeds += 1))),
      [`POST ${URL}/grade`]: (call) => ok(correction((call.body as { seed: number }).seed)),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Hand in" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hand in" }));
    await user.click(await screen.findByRole("button", { name: "Restart" }));

    expect(await screen.findByText("Preview — nothing is saved")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === URL)).toHaveLength(2);
    // The second walk grades under the second seed.
    await user.click(screen.getByRole("button", { name: "Hand in" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hand in" }));
    await screen.findByRole("heading", { name: "Preview correction" });
    expect(calls.filter((c) => c.url === `${URL}/grade`).map((c) => c.body)).toEqual([
      { seed: 1, answers: {} },
      { seed: 2, answers: {} },
    ]);
  });

  it("hands the paper in by itself when the countdown reaches zero", async () => {
    const { calls } = mockFetch({
      [`POST ${URL}`]: ok(preview(7, 1)),
      [`POST ${URL}/grade`]: ok(correction(7)),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    await screen.findByText("Preview — nothing is saved");
    expect(
      await screen.findByRole("heading", { name: "Preview correction" }, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.url === `${URL}/grade`)).toHaveLength(1);
  });

  it("hands in by itself only once when that grading fails, and Hand in still works", async () => {
    const user = userEvent.setup();
    let failing = true;
    const { calls } = mockFetch({
      [`POST ${URL}`]: ok(preview(9, 1)),
      [`POST ${URL}/grade`]: () =>
        failing ? fail(503, { error: "runner_unavailable" }) : ok(correction(9)),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    expect(await screen.findByText("The grading failed", {}, { timeout: 4000 })).toBeInTheDocument();
    // The clock keeps ticking past zero: no retry every second.
    await new Promise((r) => setTimeout(r, 2500));
    expect(calls.filter((c) => c.url === `${URL}/grade`)).toHaveLength(1);
    // The manual button is the retry.
    failing = false;
    await user.click(screen.getByRole("button", { name: "Hand in" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hand in" }));
    expect(await screen.findByRole("heading", { name: "Preview correction" })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === `${URL}/grade`)).toHaveLength(2);
  });

  it("keeps the answers when the grading fails", async () => {
    const user = userEvent.setup();
    mockFetch({
      [`POST ${URL}`]: ok(preview(3)),
      [`POST ${URL}/grade`]: fail(500, { error: "internal_error" }),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: "&x" }));
    await user.click(screen.getByRole("button", { name: "Hand in" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hand in" }));
    expect(await screen.findByText("The grading failed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("radio", { name: "&x" })).toBeChecked();
  });

  it("answers a teacher off the staff with the page of a missing evaluation", async () => {
    mockFetch({ [`POST ${URL}`]: fail(404, { error: "not_found" }) });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    expect(
      await screen.findByRole("heading", { name: "This evaluation is not available to you" }),
    ).toBeInTheDocument();
  });
});
