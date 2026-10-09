/*
 * What every evaluation surface needs to agree on: the badge tone of a state
 * and the label that goes with it. The query keys are in `queryKeys.ts`, with
 * every other family's. The label of a question TYPE is not here: it belongs
 * to the registry, and `questionTypes.tsx` is the one place that reads it.
 *
 * It is a module and not a handful of local constants because the list, the
 * configuration screen and the live dashboard all show the same state badge,
 * and three copies of a colour map is three chances to disagree about what
 * "paused" looks like.
 */
import type { Evaluation, EvaluationMode, EvaluationState, EvaluationSummary } from "@quiz/contracts";
import { isDebriefOpen, isEvaluationOpen, isEvaluationOver } from "@quiz/domain";

import { gradingLinks } from "../grading";
import type { Dict, TFunction } from "../i18n";
import type { Route } from "../router";
import type { Tone } from "../ui";

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

export function evaluationStateLabel(state: EvaluationState, t: TFunction): string {
  return t(`eval.state.${state}` as keyof Dict);
}

/**
 * Whether the correction (the Questions tab, its projection) can be read:
 * once the evaluation is over, or once an exercise's correction has been
 * published while it runs (ADR-050) — the server's own `not_over` rule.
 */
export function hasCorrection(evaluation: Pick<Evaluation, "state" | "correctionPublishedAt">): boolean {
  return isDebriefOpen({
    state: evaluation.state,
    correctionPublished: evaluation.correctionPublishedAt !== null,
  });
}

/** The states whose dashboard is worth opening at all. */
export function hasDashboard(summary: Pick<EvaluationSummary, "state">): boolean {
  return summary.state !== "draft";
}

/**
 * Where a click on an evaluation leads, in a classroom's list as in the
 * Activities section (#190): the dashboard while the class is in it, the
 * grading panel once it is closed — that is the work waiting — the results
 * once they are published, and the configuration screen before any of that.
 * A poll has no configuration screen and no grid: it IS its projection,
 * whether it is still running or already over (F-LIVE-13).
 */
export function evaluationHome(row: { id: string; mode: EvaluationMode; state: EvaluationState }): Route {
  if (row.mode === "poll") return { view: "poll", id: row.id };
  if (isEvaluationOpen(row.state)) return { view: "live", id: row.id };
  if (!isEvaluationOver(row.state)) return { view: "evaluation", id: row.id };
  const links = gradingLinks(row.id);
  return row.state === "released" ? links.results : links.grading;
}
