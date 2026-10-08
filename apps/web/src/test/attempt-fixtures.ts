import type { AttemptView } from "@quiz/contracts";

/*
 * The student's attempt as `POST /evaluations/:id/attempt` returns it, for the
 * player's tests (`student/Attempt.test.tsx`, `student/Player.test.tsx`).
 * Dates are literals on purpose: the player counts down on the SERVER's
 * clock (`serverNow`), never on the browser's, so they need no anchoring.
 */

type Attempt = AttemptView["attempt"];
type Evaluation = AttemptView["evaluation"];
type Settings = Evaluation["settings"];
export type AttemptItem = AttemptView["items"][number];

/** The single-choice question both player suites open on. */
const ADDRESS_MCQ = {
  prompt: "Quelle expression donne l'adresse de `x` ?",
  mode: "single",
  choices: [
    { id: 0, text: "&x" },
    { id: 1, text: "*x" },
  ],
};

/** One item of the paper: an unanswered, one-point `mcq` unless told otherwise. */
export function makeAttemptItem(
  over: Partial<AttemptItem> & Pick<AttemptItem, "id" | "position">,
): AttemptItem {
  return {
    points: 1,
    type: "mcq",
    milestone: false,
    bonus: false,
    intro: null,
    student: ADDRESS_MCQ,
    answer: null,
    revision: 0,
    markedDone: false,
    skipped: false,
    flagged: false,
    locked: false,
    ...over,
  };
}

export interface AttemptViewOptions {
  attempt?: Partial<Attempt>;
  /** Merged over the evaluation; `settings` is merged separately, below. */
  evaluation?: Partial<Omit<Evaluation, "settings">>;
  settings?: Partial<Settings>;
  /** One unanswered `mcq` by default. */
  items?: AttemptItem[];
}

/**
 * A running exam in the zen player, free navigation. `totalPoints` is the sum
 * of the items' points unless given.
 */
export function makeAttemptView(options: AttemptViewOptions = {}): AttemptView {
  const items = options.items ?? [makeAttemptItem({ id: "i1", position: 1 })];
  return {
    conditions: { announced: [], imposed: [] },
    attempt: {
      id: "a1",
      state: "in_progress",
      startedAt: "2026-09-20T09:50:00.000Z",
      deadlineAt: "2026-09-20T10:20:00.000Z",
      lastItemId: null,
      serverNow: "2026-09-20T10:00:00.000Z",
      preview: false,
      readOnly: false,
      ...options.attempt,
    },
    evaluation: {
      id: "e1",
      title: "Quiz 3 — Pointeurs",
      mode: "exam",
      state: "running",
      feedbackPolicy: {
        when: "on_release",
        showAnswer: true,
        showKey: false,
        showExplanation: false,
        showHiddenCaseNames: true,
        showTeacherComment: true,
      },
      pausedAt: null,
      totalPoints: items.reduce((sum, item) => sum + item.points, 0),
      ...options.evaluation,
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
        ...options.settings,
      },
    },
    items,
  };
}
