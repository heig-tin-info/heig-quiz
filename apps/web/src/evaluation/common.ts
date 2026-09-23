/*
 * What every evaluation surface needs to agree on: the query keys, the badge
 * tone of a state and the label that goes with it. The label of a question
 * TYPE is not here: it belongs to the registry, and `questionTypes.tsx` is
 * the one place that reads it.
 *
 * It is a module and not a handful of local constants because the list, the
 * configuration screen and the live dashboard all show the same state badge,
 * and three copies of a colour map is three chances to disagree about what
 * "paused" looks like.
 */
import type { EvaluationState, EvaluationSummary } from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";
import type { Tone } from "../ui";

export const evaluationsKey = (classroomId: string) => ["evaluations", classroomId] as const;
export const evaluationKey = (id: string) => ["evaluation", id] as const;
/**
 * Both toggles are in the key because both are in the REQUEST: the answers
 * travel only with `?includeAnswers=1`, and the live verdicts of ADR-020 are
 * computed only with `?results=1`. A cached variant of one is not the other.
 */
export const dashboardKey = (id: string, includeAnswers: boolean, includeResults = false) =>
  ["dashboard", id, includeAnswers, includeResults] as const;

/**
 * Green is running, amber is "waiting for you", zinc is at rest. The accent
 * is NOT used: a badge in the brand red would compete with the one primary
 * action of whatever screen it sits on.
 */
const STATE_TONE: Record<EvaluationState, Tone> = {
  draft: "zinc",
  scheduled: "zinc",
  lobby: "amber",
  running: "green",
  paused: "amber",
  closed: "zinc",
  grading: "amber",
  released: "green",
};

export function stateTone(state: EvaluationState): Tone {
  return STATE_TONE[state];
}

export function stateLabel(state: EvaluationState, t: TFunction): string {
  return t(`eval.state.${state}` as keyof Dict);
}

/** Live means "there are students in it right now", which is what routes the row click. */
export function isLive(state: EvaluationState): boolean {
  return state === "lobby" || state === "running" || state === "paused";
}

/**
 * The states where the second half of an evaluation's life has something to
 * show: the grading panel has answers to correct, the results a table to
 * print. Before `closed` both would be empty by construction.
 */
export function isGraded(state: EvaluationState): boolean {
  return state === "closed" || state === "grading" || state === "released";
}

/** The states whose dashboard is worth opening at all. */
export function hasDashboard(summary: Pick<EvaluationSummary, "state">): boolean {
  return summary.state !== "draft";
}
