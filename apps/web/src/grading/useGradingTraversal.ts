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
  GradingSteps,
} from "@quiz/contracts";

import { api } from "../api";
import {
  evaluationKey,
  gradingQueueKey,
  gradingStepsKey,
  resultsByQuestionKey,
} from "../queryKeys";
import { entryKey } from "./EntryList";
import { proposalsFirst, type GradingOrder } from "./labels";
import { useGradingProgress } from "./progress";

/**
 * Everything the grading panel reads, and what it derives from it: the path
 * of steps (questions, or students) with the state of each, the step the
 * teacher is on, the filtered, proposals-first list of that step's answers,
 * and the answer open among them.
 *
 * The panel owns the choices — order, step, open answer, filters, names —
 * and this hook turns them into requests and into a POSITION: which step,
 * which answer, and what lies either side. The step picker, the answer list,
 * the detail's Previous / Next and the keyboard all read that one position,
 * so none of them keeps a copy that could drift from the others. Names in particular are a REQUEST parameter
 * (`?anonymous=0`), never a client-side unmasking (F-GRADE-03, decision D20).
 */

export type StateFilter = "all" | GradingState;

/** The "no filter" value of the source and confidence selects. */
export const ANY = "any";
export type Any = typeof ANY;

export interface TraversalChoices {
  order: GradingOrder;
  index: number;
  /** The open answer (`entryKey`), when there is one. */
  selected?: string | null;
  stateFilter: StateFilter;
  source: GradingSource | Any;
  confidence: GradingConfidence | Any;
  showNames: boolean;
}

/** The cells of one step, counted on the server (#107). */
export interface StepState {
  total: number;
  validated: number;
  proposed: number;
}

export interface Step {
  key: string;
  label: string;
  /** A teacher's own test walk (ADR-018), traversing by student. */
  staff?: boolean;
  /** Absent until the step summary lands, or when it could not be read. */
  state?: StepState;
}

/** What a step still asks for, in the one word the picker shows. */
export type StepStatus = "toValidate" | "done" | "ungraded";

export function stepStatus(state: StepState): StepStatus {
  if (state.proposed > 0) return "toValidate";
  return state.validated >= state.total ? "done" : "ungraded";
}

/**
 * The answer `delta` places away from `selected`, clamped at both ends: the
 * steps wrap (the chevrons go round), the answers of a step do not — past
 * the last one the teacher has finished the step, not started it over.
 */
export function neighbour(
  entries: readonly GradingEntry[],
  selected: string | null,
  delta: number,
): string | null {
  if (entries.length === 0) return null;
  const at = entries.findIndex((e) => entryKey(e) === selected);
  const next = entries[Math.min(entries.length - 1, Math.max(0, at + delta))];
  return next ? entryKey(next) : null;
}

const NO_COUNTS: GradingQueue["counts"] = { total: 0, validated: 0, proposed: 0, missing: 0 };

export function useGradingTraversal(evaluationId: string, choices: TraversalChoices) {
  const { order, index, stateFilter, source, confidence, showNames } = choices;
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
   * The steps and their state (`GET …/grading/steps`): three counters per
   * step, never an answer. By student it is also the roster — the step
   * labels are the server's, by the same rule as the entries' labels, so a
   * pseudonym in the picker is the pseudonym in the list. By question the
   * labels come from the items and only the counters are read here, so the
   * path is drawn before the summary lands, and without it if it fails.
   */
  const summary = useQuery<GradingSteps>({
    queryKey: gradingStepsKey(evaluationId, order, anonymous),
    enabled: items.length > 0,
    queryFn: () =>
      api(`/app/api/evaluations/${evaluationId}/grading/steps?by=${order}&anonymous=${anonymous}`),
  });

  const steps = useMemo<Step[]>(() => {
    const summaries = summary.data?.order === order ? summary.data.steps : [];
    const stateOf = (s: GradingSteps["steps"][number]): StepState => ({
      total: s.total,
      validated: s.validated,
      proposed: s.proposed,
    });
    const byKey = new Map(summaries.map((s) => [s.key, stateOf(s)]));
    return order === "question"
      ? // `position` is 0-based on the wire; every screen of this app numbers
        // questions from 1, and the step counter above this list does too.
        items.map((i) => {
          const state = byKey.get(i.id);
          return { key: i.id, label: `${i.position + 1}. ${i.internalName}`, ...(state ? { state } : {}) };
        })
      : summaries.map((s) => ({ key: s.key, label: s.label, staff: s.staff, state: stateOf(s) }));
  }, [order, items, summary.data]);
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

  // --- The position -----------------------------------------------------

  const selected = choices.selected ?? null;
  const at = entries.findIndex((e) => entryKey(e) === selected);
  const current = at < 0 ? null : { entry: entries[at]!, index: at };

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
    /** The open answer and its place in `entries`; null before one is open. */
    current,
  };
}
