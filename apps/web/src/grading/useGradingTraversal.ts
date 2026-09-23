import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type {
  ByQuestion,
  EvaluationDetail,
  GradingConfidence,
  GradingEntry,
  GradingQueue,
  GradingQueueItem,
  GradingSource,
  GradingState,
} from "@quiz/contracts";

import { api } from "../api";
import {
  evaluationKey,
  gradingQueueKey,
  gradingRosterKey,
  resultsByQuestionKey,
} from "../queryKeys";
import { proposalsFirst, type GradingOrder } from "./labels";
import { useGradingProgress } from "./progress";

/**
 * Everything the grading panel reads, and what it derives from it: the path
 * of steps (questions, or students), the step the teacher is on, and the
 * filtered, proposals-first list of that step's answers.
 *
 * The panel owns the choices — order, step, filters, names — and this hook
 * turns them into requests. Names in particular are a REQUEST parameter
 * (`?anonymous=0`), never a client-side unmasking (F-GRADE-03, decision D20).
 */

export type StateFilter = "all" | GradingState;

/** The "no filter" value of the source and confidence selects. */
export const ANY = "any";
export type Any = typeof ANY;

export interface TraversalChoices {
  order: GradingOrder;
  index: number;
  stateFilter: StateFilter;
  source: GradingSource | Any;
  confidence: GradingConfidence | Any;
  showNames: boolean;
}

export interface Step {
  key: string;
  label: string;
}

const NO_COUNTS: GradingQueue["counts"] = { total: 0, validated: 0, proposed: 0, missing: 0 };

export function useGradingTraversal(
  evaluationId: string,
  { order, index, stateFilter, source, confidence, showNames }: TraversalChoices,
) {
  // --- The evaluation and its items -------------------------------------

  const evaluation = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}`),
  });

  const items = useMemo<GradingQueueItem[]>(
    () =>
      (evaluation.data?.items ?? []).map((i) => ({
        id: i.id,
        position: i.position,
        internalName: i.internalName,
        type: i.type,
        points: i.points,
      })),
    [evaluation.data],
  );
  const anonymous = showNames ? "0" : "1";

  /**
   * The students, read from the queue of the FIRST question: one entry per
   * attempt, already carrying the label the server decided to show. It saves
   * an endpoint, and the pseudonyms cannot drift from the ones the list
   * below prints, because they come from the same place.
   */
  const roster = useQuery<GradingQueue>({
    queryKey: gradingRosterKey(evaluationId, items[0]?.id ?? "", anonymous),
    enabled: order === "student" && items.length > 0,
    queryFn: () =>
      api(
        `/app/api/evaluations/${evaluationId}/grading?by=question&itemId=${items[0]!.id}&anonymous=${anonymous}`,
      ),
  });
  const students = useMemo(
    () => (roster.data?.entries ?? []).map((e) => ({ key: e.attemptId, label: e.label })),
    [roster.data],
  );

  const steps = useMemo<Step[]>(
    () =>
      order === "question"
        ? // `position` is 0-based on the wire; every screen of this app numbers
          // questions from 1, and the step counter above this list does too.
          items.map((i) => ({ key: i.id, label: `${i.position + 1}. ${i.internalName}` }))
        : students,
    [order, items, students],
  );
  const step: Step | undefined = steps[Math.min(index, Math.max(0, steps.length - 1))];

  // --- The queue of the current step -------------------------------------

  const scopeParam =
    step === undefined
      ? null
      : order === "question"
        ? `by=question&itemId=${step.key}`
        : `by=student&attemptId=${step.key}`;

  const queue = useQuery<GradingQueue>({
    queryKey: gradingQueueKey(evaluationId, scopeParam, stateFilter, anonymous),
    enabled: scopeParam !== null,
    queryFn: () =>
      api(
        `/app/api/evaluations/${evaluationId}/grading?${scopeParam}&anonymous=${anonymous}` +
          (stateFilter === "all" ? "" : `&state=${stateFilter}`),
      ),
  });

  const progress = useGradingProgress(evaluationId);

  /**
   * The explanations, taken from the per-question results view. It is an
   * aid, not the screen: a failure here shows nothing extra and never an
   * error state, so a grading session is not interrupted by a secondary read.
   */
  const byQuestion = useQuery<ByQuestion[]>({
    queryKey: resultsByQuestionKey(evaluationId),
    retry: false,
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/results/by-question`),
  });
  const explanations = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of byQuestion.data ?? []) {
      if (q.explanation) map.set(q.item.id, q.explanation);
    }
    return map;
  }, [byQuestion.data]);

  // --- Filtering and ordering -------------------------------------------

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const matches = useCallback(
    (e: GradingEntry) =>
      (source === ANY || e.grading?.source === source) &&
      (confidence === ANY || e.grading?.confidence === confidence),
    [source, confidence],
  );

  const entries = useMemo(
    () => proposalsFirst((queue.data?.entries ?? []).filter(matches)),
    [queue.data, matches],
  );

  return {
    evaluation,
    items,
    itemsById,
    steps,
    step,
    queue,
    entries,
    counts: queue.data?.counts ?? NO_COUNTS,
    progress,
    explanations,
  };
}
