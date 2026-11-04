/** A paper of two mcq questions, as `GET /evaluations/:id/paper/items` answers it (ADR-125). */
import type { PaperItems } from "@quiz/contracts";

export const EVAL = "e1";
export const USER = "aaaaaaaa-0000-4000-8000-000000000001";
export const I1 = "11111111-1111-4111-8111-111111111111";
export const I2 = "22222222-2222-4222-8222-222222222222";
export const ITEMS_URL = `/app/api/evaluations/${EVAL}/paper/items?user=${USER}`;
export const PAPER_URL = `/app/api/evaluations/${EVAL}/paper`;

const mcq = (id: string, prompt: string, choices: string[]) => ({
  id,
  position: id === I1 ? 0 : 1,
  points: 1,
  type: "mcq",
  milestone: false,
  counting: "normal" as const,
  intro: null,
  student: { prompt, mode: "single", choices: choices.map((text, i) => ({ id: i, text })) },
  answer: null,
  revision: 0,
  markedDone: false,
  skipped: false,
  flagged: false,
  locked: false,
  acquired: false,
  checked: false,
  correction: null,
});

export const makePaper = (over: Partial<PaperItems> = {}): PaperItems => ({
  student: { userId: USER, displayName: "Nadia Roux" },
  view: {
    conditions: { announced: [], imposed: [] },
    attempt: {
      id: "00000000-0000-4000-8000-000000000000",
      state: "in_progress",
      startedAt: "2026-11-02T08:00:00.000Z",
      deadlineAt: null,
      lastItemId: null,
      serverNow: "2026-11-02T08:00:00.000Z",
      preview: true,
      readOnly: false,
    },
    evaluation: {
      id: EVAL,
      title: "Quiz 3 — Pointeurs",
      mode: "exam",
      state: "closed",
      settings: {
        // The exam's own navigation; the paper is typed in freely all the same.
        navigation: "forward_only",
        lobby: "manual",
        shuffleItems: true,
        shuffleChoices: true,
        timing: "duration",
        logVisibility: true,
        requireFullscreen: false,
      },
      feedbackPolicy: {
        when: "none",
        showAnswer: false,
        showKey: false,
        showExplanation: false,
        showHiddenCaseNames: false,
        showTeacherComment: false,
      },
      pausedAt: null,
      totalPoints: 2,
    },
    items: [
      mcq(I1, "Quelle expression donne l'adresse de `x` ?", ["*x", "&x"]),
      mcq(I2, "Quelle est la taille d'un `char` ?", ["1 octet", "2 octets"]),
    ],
  },
  solutions: { [I1]: { correct: [1] }, [I2]: { correct: [0] } },
  replaces: null,
  examDate: "2026-11-02",
  ...over,
});
