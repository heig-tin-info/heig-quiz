import { useState } from "react";

import type { GradingEntry, GradingQueueItem, ManualGradingBody } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { useT } from "../i18n";
import { numberOf, PointsField } from "../ui";
import { CriteriaFields, criteriaBody, initialCriteriaPoints, invalidCriteria } from "./EssayCriteria";

type Criteria = NonNullable<GradingQueueItem["criteria"]>;

/** The points a teacher gives a cell by hand: a number, or an essay's points per criterion (ADR-118 §6). */
export type PointsPart = Pick<ManualGradingBody, "points" | "criteria">;

export interface PointsDraft {
  /** An essay graded criterion by criterion, its total derived. */
  graded: boolean;
  values: Record<string, string>;
  setValue: (id: string, text: string) => void;
  points: string;
  setPoints: (text: string) => void;
  invalid: boolean;
  /** The points as the wire writes them (`ManualGradingBody`'s fields). */
  body: () => PointsPart;
  criteria: Criteria;
  maxPoints: number;
  minPoints: number;
  details: unknown;
}

/**
 * The points of one cell being typed (F-GRADE-05): the adjustment form's,
 * and the new points an accepted contestation may carry (ADR-139), which
 * become the same manual override. Starts from the grading in force.
 */
export function usePointsDraft({
  entry,
  criteria,
  maxPoints,
  minPoints,
}: {
  entry: GradingEntry;
  criteria: Criteria;
  maxPoints: number;
  /** 0, or `-maxPoints` for a choice question under negative marking (ADR-026). */
  minPoints: number;
}): PointsDraft {
  const graded = criteria.length > 0;
  const details = entry.grading?.details ?? null;
  const [values, setValues] = useState(() => initialCriteriaPoints(criteria, details));
  const [points, setPoints] = useState(() => (entry.grading ? formatPoints(entry.grading.points) : "0"));
  const value = numberOf(points);
  const invalid = graded ? invalidCriteria(criteria, maxPoints, values).size > 0 : !(value >= minPoints && value <= maxPoints);
  return {
    graded,
    values,
    setValue: (id, text) => setValues((v) => ({ ...v, [id]: text })),
    points,
    setPoints,
    invalid,
    body: () => (graded ? { criteria: criteriaBody(criteria, values) } : { points: value }),
    criteria,
    maxPoints,
    minPoints,
    details,
  };
}

/**
 * The fields of a {@link PointsDraft}: one pill over the maximum, or one per
 * criterion. The check is quiet until `showErrors`, then marks what is wrong.
 */
export function PointsFields({
  draft,
  showErrors,
  autoFocus = false,
}: {
  draft: PointsDraft;
  showErrors: boolean;
  autoFocus?: boolean;
}) {
  const t = useT();
  const range = { min: formatPoints(draft.minPoints), max: formatPoints(draft.maxPoints) };
  // The points over their maximum, one pill (F-PROJ-25 as amended): the
  // maximum is its suffix, so the label line says the range only when the
  // floor is not 0 (negative marking).
  if (draft.graded) {
    return (
      <CriteriaFields
        criteria={draft.criteria}
        itemPoints={draft.maxPoints}
        values={draft.values}
        onChange={draft.setValue}
        details={draft.details}
        showErrors={showErrors}
      />
    );
  }
  return (
    <PointsField
      label={t("grading.override.points")}
      hint={draft.minPoints < 0 ? t("grading.override.range", range) : undefined}
      bounds={{ max: draft.maxPoints }}
      autoFocus={autoFocus}
      value={draft.points}
      onChange={draft.setPoints}
      error={showErrors && draft.invalid ? t("grading.override.pointsInvalid", range) : null}
    />
  );
}
