import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  AttemptView,
  EvaluationDetail,
  EvaluationPreview,
  ItemRow,
  PreviewCorrection,
} from "@quiz/contracts";

import { makeEvaluationDetail } from "../test/grading-fixtures";

import { elapse, flowingClock } from "../test/clock";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { viewport } from "../test/viewport";
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
      bonus: false,
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
      skipped: false,
      flagged: false,
      locked: false,
    },
    {
      id: I2,
      position: 2,
      points: 1,
      type: "mcq",
      milestone: false,
      bonus: false,
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
      skipped: false,
      flagged: false,
      locked: false,
    },
  ],
});

const preview = (seed: number, durationS: number | null = 1800): EvaluationPreview => ({
  seed,
  durationS,
  view: view(),
  versions: { [I1]: 1, [I2]: 1 },
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

    // The student's own player, under the preview's strip: nothing laid over the question.
    expect(await screen.findByText("Quiz 3 — Pointeurs")).toBeInTheDocument();
    const strip = screen.getByRole("region", { name: "Preview — nothing is saved" });
    expect(within(strip).getByRole("button", { name: "Restart" })).toBeInTheDocument();
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

  it("shows the points of the question on screen without handing in", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`POST ${URL}`]: ok(preview(5)),
      [`POST ${URL}/grade`]: ok(correction(5)),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: "&x" }));
    await user.click(screen.getByRole("button", { name: "Show the points" }));

    expect(await screen.findByText("This question: 2 / 2 points")).toBeInTheDocument();
    // The one answer on screen, graded by the preview's own route.
    expect(calls.find((c) => c.url === `${URL}/grade`)).toMatchObject({
      body: { seed: 5, answers: { [I1]: { selected: [0] } } },
    });
    // Still the walk, not the correction.
    expect(screen.queryByRole("heading", { name: "Preview correction" })).toBeNull();

    // Another answer, stale points: they go away until asked again.
    await user.click(screen.getByRole("radio", { name: "*x" }));
    expect(screen.queryByText("This question: 2 / 2 points")).toBeNull();
  });

  it("stands the question's tools beside its points on a wide screen", async () => {
    const narrow = window.matchMedia;
    viewport(1280);
    try {
      mockFetch({ [`POST ${URL}`]: ok(preview(5)) });
      const { container } = renderWithProviders(
        <EvaluationPreviewPage id={EVAL} navigate={() => {}} />,
      );
      const show = await screen.findByRole("button", { name: "Show the points" });
      expect(show.closest("aside")).not.toBeNull();
      expect(container.querySelector("main")).not.toContainElement(show);
    } finally {
      vi.stubGlobal("matchMedia", narrow);
    }
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

    // The walk again: the correction has no Hand in.
    expect(await screen.findByRole("button", { name: "Hand in" })).toBeInTheDocument();
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

  it("restarts from the strip, after asking once the paper has an answer", async () => {
    const user = userEvent.setup();
    let seeds = 0;
    const { calls } = mockFetch({ [`POST ${URL}`]: () => ok(preview((seeds += 1))) });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: "&x" }));
    const strip = screen.getByRole("region", { name: "Preview — nothing is saved" });
    await user.click(within(strip).getByRole("button", { name: "Restart" }));

    const dialog = await screen.findByRole("dialog", { name: "Restart the preview?" });
    await user.click(within(dialog).getByRole("button", { name: "Restart" }));
    // A new seed, an empty paper.
    await waitFor(() => expect(calls.filter((c) => c.url === URL)).toHaveLength(2));
    expect(await screen.findByRole("radio", { name: "&x" })).not.toBeChecked();
  });

  it("hands the paper in by itself when the countdown reaches zero", async () => {
    // A one-second countdown, jumped on a flowing clock.
    flowingClock();
    const { calls } = mockFetch({
      [`POST ${URL}`]: ok(preview(7, 1)),
      [`POST ${URL}/grade`]: ok(correction(7)),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    await screen.findByRole("button", { name: "Hand in" });
    await elapse(1_000);
    expect(await screen.findByRole("heading", { name: "Preview correction" })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === `${URL}/grade`)).toHaveLength(1);
  });

  it("hands in by itself only once when that grading fails, and Hand in still works", async () => {
    const user = flowingClock();
    let failing = true;
    const { calls } = mockFetch({
      [`POST ${URL}`]: ok(preview(9, 1)),
      [`POST ${URL}/grade`]: () =>
        failing ? fail(503, { error: "runner_unavailable" }) : ok(correction(9)),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    await screen.findByRole("button", { name: "Hand in" });
    await elapse(1_000);
    expect(await screen.findByText("The grading failed")).toBeInTheDocument();
    // The clock keeps ticking past zero: no retry every second.
    await elapse(3_000);
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

/*
 * Fixing a question from the walk (ADR-018, sixth addendum): the editor opens
 * in another tab, and a newer version is swapped in for that one question,
 * from the walk's own seed, without touching the other answers.
 */
describe("EvaluationPreviewPage — fixing a question", () => {
  const row = (id: string, questionId: string, over: Partial<ItemRow> = {}): ItemRow => ({
    id,
    position: 0,
    points: 1,
    milestone: false,
    bonus: false,
    questionId,
    questionVersionId: "00000000-0000-4000-8000-00000000000" + questionId.slice(-1),
    type: "mcq",
    internalName: questionId,
    versionNumber: 1,
    latestVersionNumber: 1,
    ...over,
    deprecated: false,
  });
  const detailOf = (items: ItemRow[], over: Partial<EvaluationDetail> = {}) =>
    makeEvaluationDetail({
      evaluation: { ...makeEvaluationDetail().evaluation, id: EVAL, state: "draft" },
      items,
      attemptCount: 0,
      editable: true,
      editableQuestionIds: ["q1", "q2"],
      ...over,
    });
  const DETAIL = `GET /app/api/evaluations/${EVAL}`;

  it("opens the editor in a new tab and swaps in the new version, keeping the other answers", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    let detail = detailOf([row(I1, "q1", { latestVersionNumber: 2 }), row(I2, "q2")]);
    const updated = preview(42);
    updated.view.items[0]!.student = {
      prompt: "Quelle expression donne l'adresse de `y` ?",
      mode: "single",
      choices: [
        { id: 0, text: "&y" },
        { id: 1, text: "*y" },
      ],
    };
    updated.versions = { [I1]: 2, [I2]: 1 };
    const { calls } = mockFetch({
      [`POST ${URL}`]: (call) => ok((call.body as { seed?: number } | null)?.seed === 42 ? updated : preview(42)),
      [DETAIL]: () => ok(detail),
      [`POST /app/api/evaluations/${EVAL}/items/update-versions`]: () => {
        detail = detailOf([row(I1, "q1", { versionNumber: 2, latestVersionNumber: 2 }), row(I2, "q2")]);
        return ok([]);
      },
      [`POST ${URL}/grade`]: (call) => ok(correction((call.body as { seed: number }).seed)),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "Edit question" }));
    expect(open).toHaveBeenCalledWith(`/questions/q1?from=${EVAL}`, "_blank", "noopener");
    expect(await screen.findByText("Version 2 of this question is published")).toBeInTheDocument();

    // An answer on each question, then back to the first one.
    await user.click(screen.getByRole("radio", { name: "&x" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(await screen.findByRole("radio", { name: "1 octet" }));
    // The notice is about the question on screen: this one is up to date.
    expect(screen.queryByText("Version 2 of this question is published")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous" }));

    await user.click(await screen.findByRole("button", { name: "Use the new version" }));
    expect(await screen.findByRole("radio", { name: "&y" })).not.toBeChecked();
    expect(calls.find((c) => c.url.endsWith("/items/update-versions"))?.body).toEqual({ itemIds: [I1] });
    expect(calls.filter((c) => c.url === URL).map((c) => c.body)).toEqual([null, { seed: 42 }]);
    await waitFor(() =>
      expect(screen.queryByText("Version 2 of this question is published")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("The evaluation changed since this preview started")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hand in" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hand in" }));
    await screen.findByRole("heading", { name: "Preview correction" });
    // The replaced question's answer is gone; the other one is handed in.
    expect(calls.find((c) => c.url === `${URL}/grade`)?.body).toEqual({
      seed: 42,
      answers: { [I2]: { selected: [0] } },
    });
    open.mockRestore();
  });

  it("offers nothing that would be refused once students have taken it, and no Edit without the pool's right", async () => {
    mockFetch({
      [`POST ${URL}`]: () => ok(preview(42)),
      [DETAIL]: () =>
        ok(
          detailOf([row(I1, "q1", { latestVersionNumber: 2 }), row(I2, "q2")], {
            attemptCount: 3,
            editable: false,
            editableQuestionIds: ["q2"],
          }),
        ),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    expect(await screen.findByText(/re-grade the question from the grading panel/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use the new version" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit question" })).not.toBeInTheDocument();
  });

  it("offers to restart when the evaluation changed under the walk", async () => {
    mockFetch({
      [`POST ${URL}`]: () => ok(preview(42)),
      [DETAIL]: () =>
        ok(detailOf([row(I1, "q1"), row(I2, "q2"), row("33333333-3333-4333-8333-333333333333", "q3")])),
    });
    renderWithProviders(<EvaluationPreviewPage id={EVAL} navigate={() => {}} />);
    expect(await screen.findByText("The evaluation changed since this preview started")).toBeInTheDocument();
  });
});
