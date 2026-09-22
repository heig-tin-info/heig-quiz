import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AttemptView } from "@quiz/contracts";

import { EVALUATION_ID, id, liveAt } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { PreviewSheet } from "./PreviewSheet";

/*
 * "Preview as student" on an evaluation.
 *
 * The one thing this screen owes the teacher is that it shows what the class
 * will get. It used to mount each type's `Player` by hand, without the
 * `renderMarkdown` the student's `QuestionHost` injects, so a statement
 * written as `# Titre` was printed as its own source. It now goes through
 * that host, and this test is what holds it there.
 */

const ITEM = id("item", 1);

function view(prompt: string): AttemptView {
  return {
    attempt: {
      id: id("attempt", 1),
      state: "in_progress",
      startedAt: liveAt(0),
      deadlineAt: liveAt(45 * 60_000),
      lastItemId: null,
      serverNow: liveAt(0),
      preview: true,
      readOnly: false,
    },
    evaluation: {
      id: EVALUATION_ID,
      title: "Quiz 3 — pointers",
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
      totalPoints: 2,
    },
    items: [
      {
        id: ITEM,
        position: 0,
        points: 2,
        type: "mcq",
        milestone: false,
        student: {
          prompt,
          choices: [
            { id: 0, text: "NULL" },
            { id: 1, text: "Une valeur indéterminée" },
          ],
          mode: "single",
        },
        answer: null,
        revision: 0,
        markedDone: false,
        locked: false,
      },
    ],
  };
}

describe("PreviewSheet", () => {
  it("renders the statement as markdown, like the player does", async () => {
    mockFetch({
      [`POST /app/api/evaluations/${EVALUATION_ID}/preview`]: ok(
        view("# Les pointeurs\n\nQue vaut un pointeur non initialisé ?"),
      ),
    });
    renderWithProviders(<PreviewSheet evaluationId={EVALUATION_ID} onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Les pointeurs" })).toBeInTheDocument();
    // The literal marker never reaches the screen.
    expect(screen.queryByText(/# Les pointeurs/)).toBeNull();
  });

  it("mounts the type's player with the app's own strings", async () => {
    mockFetch({
      [`POST /app/api/evaluations/${EVALUATION_ID}/preview`]: ok(view("Pick one")),
    });
    renderWithProviders(<PreviewSheet evaluationId={EVALUATION_ID} onClose={vi.fn()} />);

    // `qt-mcq`'s instruction line, translated by the host and not the
    // package's own default.
    expect(await screen.findByText("Choose one answer.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Une valeur indéterminée" })).toBeDisabled();
  });
});
