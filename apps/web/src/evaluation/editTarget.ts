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

import type { Evaluation, EvaluationPatch, TemplatePatch } from "@quiz/contracts";

import type { QuestionOrigin } from "../router";

import {
  courseTemplatesKey,
  evaluationKey,
  evaluationPoolsKey,
  templateKey,
  templatePoolsKey,
} from "../queryKeys";

/** The run's own fields, which a template's patch must never carry. */
type RunField = "opensAt" | "closesAt" | "ipAllowlist";

/**
 * A template's patch body, closed to the run's fields at compile time: with
 * them typed `never`, neither a literal carrying one nor an evaluation's
 * patch (or a writer of one) is accepted where a template's is expected.
 */
export type TemplateBody = TemplatePatch & { readonly [K in RunField]?: never };

/**
 * `P` is the body its `PATCH` takes (`useConfigPatch`): an evaluation's
 * whole patch, or a template's without the run.
 */
export interface EditTarget<P = unknown> {
  /** The API path the items, the pools and the item preview hang off. */
  readonly base: string;
  /** The detail every write refreshes, and the prefix of its item previews. */
  readonly detailKey: ReturnType<typeof evaluationKey> | ReturnType<typeof templateKey>;
  /** The pools the question picker offers: the course's linked pools. */
  readonly poolsKey: readonly unknown[];
  /** What else a write changes: a template's row on its course page (count, points, revision). */
  readonly alsoKeys: readonly (readonly unknown[])[];
  /** Where the question editor leads back to: `?from=` or `?fromTemplate=`. */
  readonly questionFrom: Pick<QuestionOrigin, "from" | "fromTemplate">;
  /** Type only, never set: the body of this target's `PATCH`. */
  readonly patchBody?: P;
}

export function evaluationTarget(id: string): EditTarget<EvaluationPatch> {
  return {
    base: `/app/api/evaluations/${id}`,
    detailKey: evaluationKey(id),
    poolsKey: evaluationPoolsKey(id),
    alsoKeys: [],
    questionFrom: { from: id },
  };
}

export function templateTarget(id: string, courseId: string): EditTarget<TemplateBody> {
  return {
    base: `/app/api/templates/${id}`,
    detailKey: templateKey(id),
    poolsKey: templatePoolsKey(id),
    alsoKeys: [courseTemplatesKey(courseId)],
    questionFrom: { fromTemplate: id },
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
 * evaluation's patch that has nothing to do with a run. `useConfigPatch`
 * gives one for either target.
 */
export interface ConfigPatch {
  mutate(body: TemplatePatch): void;
  readonly error: unknown;
}
