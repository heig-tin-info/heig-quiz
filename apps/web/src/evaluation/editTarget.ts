/*
 * What the editor's building blocks edit: an evaluation of a classroom, or a
 * template of a course (F-EVAL-25). The two are the same row in the database
 * and the same controls on the screen, but their routes are parallel and
 * never shared (ADR-031, addendum c): `/evaluations/:id/...` for one,
 * `/templates/:id/...` for the other.
 *
 * So the item list, the question picker, the item preview and the settings
 * are parametrized by DATA — which base URL, which cache — and not by a flag
 * that asks "is this a template?" at every site. `EvaluationConfig` hands
 * them an `evaluationTarget`, `TemplateEditor` a `templateTarget`, and the
 * components never learn which one they were given.
 */
import { useQueryClient } from "@tanstack/react-query";

import type { Evaluation, TemplatePatch } from "@quiz/contracts";

import {
  courseTemplatesKey,
  evaluationKey,
  evaluationPoolsKey,
  templateKey,
  templatePoolsKey,
} from "../queryKeys";

export interface EditTarget {
  /** The API path the items, the pools and the item preview hang off. */
  readonly base: string;
  /** The detail every write refreshes, and the prefix of its item previews. */
  readonly detailKey: ReturnType<typeof evaluationKey> | ReturnType<typeof templateKey>;
  /** The pools the question picker offers: the course's linked pools. */
  readonly poolsKey: readonly unknown[];
  /** What else a write changes: a template's row on its course page (count, points, revision). */
  readonly alsoKeys: readonly (readonly unknown[])[];
  /** The evaluation the question editor leads back to (`?from=`), when there is one. */
  readonly questionFrom?: string;
}

export function evaluationTarget(id: string): EditTarget {
  return {
    base: `/app/api/evaluations/${id}`,
    detailKey: evaluationKey(id),
    poolsKey: evaluationPoolsKey(id),
    alsoKeys: [],
    questionFrom: id,
  };
}

export function templateTarget(id: string, courseId: string): EditTarget {
  return {
    base: `/app/api/templates/${id}`,
    detailKey: templateKey(id),
    poolsKey: templatePoolsKey(id),
    alsoKeys: [courseTemplatesKey(courseId)],
  };
}

/** Refreshes everything a write to `target` changed. */
export function useTargetRefresh(target: EditTarget) {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [target.detailKey, ...target.alsoKeys].map((queryKey) => qc.invalidateQueries({ queryKey })),
    );
}

/** What the shared settings controls read: the configuration both kinds carry. */
export type ConfigView = Pick<
  Evaluation,
  "mode" | "settings" | "durationS" | "feedbackPolicy" | "mcqPolicy" | "gradingScale"
>;

/**
 * What they write: a template's patch, which is exactly the part of an
 * evaluation's patch that has nothing to do with a run. An evaluation's
 * `useEvaluationPatch` is one, and so is a template's `useTemplatePatch`.
 */
export interface ConfigPatch {
  mutate(body: TemplatePatch): void;
  readonly error: unknown;
}
