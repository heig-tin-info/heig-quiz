import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type {
  EvaluationDetail,
  GradingQueue,
  GradingQueueItem,
  GradingSteps,
} from "@quiz/contracts";
import { negativeMarkingOf } from "@quiz/contracts";
import { negativeMarkingOn, overridePointsRange, scoresNegatively } from "@quiz/domain";

import { api } from "../api";
import { evaluationKey, gradingQueueKey, gradingStepsKey } from "../queryKeys";
import { useGradingProgress } from "./progress";

/** A question of the evaluation as the grading screen needs it. */
export interface GradingItem extends GradingQueueItem {
  /** The pool question behind the item: what "Edit question" opens. */
  questionId: string;
}

/** Where a question stands: its answers, and how many are validated. */
export interface StepState {
  total: number;
  validated: number;
}

/**
 * Everything the grading screen reads (ADR-044): the evaluation and its
 * questions, the state of every question (`…/grading/steps`, two counters
 * each, for the selector and its stepper), the answers of the question on
 * screen, and the automatic pass's progress.
 *
 * The answers are read WHOLE — every state, every source — and filtered in
 * the browser: the answer panel resolves its entry in that full list, so an
 * answer validated under "To validate" leaves the table but not the panel.
 *
 * Names are a REQUEST parameter (`?anonymous=0`), never a client-side
 * unmasking: anonymised, the server sends no label at all.
 */
export function useGradingData(evaluationId: string, index: number, named: boolean) {
  const evaluation = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}`),
  });

  const items = useMemo<GradingItem[]>(() => {
    const detail = evaluation.data;
    // ADR-026: a correction may go below 0 on a choice question of an
    // evaluation with negative marking — the server's own rule.
    const negative =
      detail !== undefined &&
      negativeMarkingOn(detail.evaluation.mode, negativeMarkingOf(detail.evaluation.settings));
    return (detail?.items ?? []).map((i) => ({
      id: i.id,
      position: i.position,
      internalName: i.internalName,
      type: i.type,
      points: i.points,
      minPoints: overridePointsRange(i.points, scoresNegatively(i.type, negative)).min,
      questionId: i.questionId,
    }));
  }, [evaluation.data]);

  const item: GradingItem | undefined = items[Math.min(index, Math.max(0, items.length - 1))];

  const steps = useQuery<GradingSteps>({
    queryKey: gradingStepsKey(evaluationId),
    enabled: items.length > 0,
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/grading/steps`),
  });
  const states = useMemo(
    () => new Map<string, StepState>((steps.data?.steps ?? []).map((s) => [s.key, s])),
    [steps.data],
  );

  const anonymous = named ? "0" : "1";
  const queue = useQuery<GradingQueue>({
    queryKey: gradingQueueKey(evaluationId, item?.id ?? null, anonymous),
    enabled: item !== undefined,
    queryFn: () =>
      api(`/app/api/evaluations/${evaluationId}/grading?itemId=${item!.id}&anonymous=${anonymous}`),
    // Switching names on or off keeps the rows on screen while the other
    // reading arrives; another question never shows the last one's answers.
    placeholderData: (previous) => (previous?.items[0]?.id === item?.id ? previous : undefined),
  });

  return {
    evaluation,
    items,
    item,
    states,
    queue,
    entries: queue.data?.entries ?? [],
    /** The question's explanation, an aid beside the answer (ADR-033). */
    explanation: queue.data?.items[0]?.explanation ?? null,
    progress: useGradingProgress(evaluationId),
  };
}
