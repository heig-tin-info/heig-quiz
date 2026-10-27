/**
 * An essay graded criterion by criterion (ADR-118 §6, amendment of
 * 2026-10-27): the points of each criterion on the item's scale, the total
 * derived from them and never typed (`breakdownTotal`, the server's rule),
 * and the validated breakdown read back on the panel. Everything here is
 * the teacher's; a student reads a breakdown only through the results'
 * student view.
 */
import { useId } from "react";

import { aiOf, breakdownOf } from "@quiz/contracts";
import { breakdownTotal, criteriaMaxima, formatPoints, type DeclaredCriterion } from "@quiz/domain";

import { useT } from "../i18n";
import { FieldError, fieldErrorProps, PointsPill, Section } from "../ui";
import { PointsByCriterion } from "./PointsByCriterion";

/** What the form starts from, per criterion id: the validated breakdown, else the proposal, else 0. */
export function initialCriteriaPoints(criteria: readonly DeclaredCriterion[], details: unknown): Record<string, string> {
  const given = new Map<string, number>();
  for (const c of aiOf(details)?.criteria ?? []) if (c.id !== undefined) given.set(c.id, c.points);
  for (const line of breakdownOf(details) ?? []) given.set(line.id, line.points);
  return Object.fromEntries(criteria.map((c) => [c.id, formatPoints(given.get(c.id) ?? 0)]));
}

/** A typed value as a number: a comma is a decimal point; anything else is NaN. */
const parsed = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text.replace(",", ".")));

/** The criteria whose typed points lie outside `[0, max]`, by id. */
export function invalidCriteria(
  criteria: readonly DeclaredCriterion[],
  itemPoints: number,
  values: Readonly<Record<string, string>>,
): Set<string> {
  const maxima = criteriaMaxima(criteria, itemPoints);
  return new Set(
    criteria
      .filter((c, i) => {
        const value = parsed(values[c.id] ?? "");
        return !Number.isFinite(value) || value < 0 || value > maxima[i]!;
      })
      .map((c) => c.id),
  );
}

/** The body's `criteria`: every criterion, in order, its typed points. */
export const criteriaBody = (criteria: readonly DeclaredCriterion[], values: Readonly<Record<string, string>>) =>
  criteria.map((c) => ({ id: c.id, points: parsed(values[c.id] ?? "") }));

/**
 * One row per criterion: its title and weight, the model's sentence when it
 * proposed, a points pill bounded by the criterion's maximum; then the
 * total, read-only.
 */
export function CriteriaFields({
  criteria,
  itemPoints,
  values,
  onChange,
  details,
  showErrors,
}: {
  criteria: readonly DeclaredCriterion[];
  itemPoints: number;
  values: Readonly<Record<string, string>>;
  onChange: (id: string, value: string) => void;
  /** The grading's details: the model's sentence per criterion, when it proposed. */
  details: unknown;
  showErrors: boolean;
}) {
  const t = useT();
  const baseId = useId();
  const maxima = criteriaMaxima(criteria, itemPoints);
  const invalid = showErrors ? invalidCriteria(criteria, itemPoints, values) : new Set<string>();
  const sentences = new Map((aiOf(details)?.criteria ?? []).map((c) => [c.id, c.comment]));
  const total = breakdownTotal(
    criteria.map((c) => {
      const value = parsed(values[c.id] ?? "");
      return Number.isFinite(value) ? value : 0;
    }),
    itemPoints,
  );

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium text-fg">{t("grading.criteria.legend")}</legend>
      <ul className="divide-y divide-line">
        {criteria.map((c, i) => {
          const id = `${baseId}-${c.id}`;
          const sentence = sentences.get(c.id);
          const max = maxima[i]!;
          return (
            <li key={c.id} className="flex items-start justify-between gap-4 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium text-fg">{c.title}</p>
                <p className="text-xs text-fg-muted">{t("grading.criteria.weight", { n: c.weight })}</p>
                {sentence ? <p className="text-xs text-fg-muted">{sentence}</p> : null}
                <FieldError id={id}>
                  {invalid.has(c.id) ? t("grading.criteria.pointsInvalid", { max: formatPoints(max) }) : null}
                </FieldError>
              </div>
              <PointsPill
                id={id}
                label={c.title}
                bounds={{ max }}
                autoFocus={i === 0}
                value={values[c.id] ?? ""}
                onChange={(e) => onChange(c.id, e.target.value)}
                {...fieldErrorProps(id, invalid.has(c.id))}
              />
            </li>
          );
        })}
      </ul>
      <p className="flex items-baseline justify-between gap-4 border-t border-line-strong pt-2.5 text-sm">
        <span className="font-medium text-fg">{t("grading.criteria.total")}</span>
        <output className="tabular-nums font-semibold text-fg" aria-label={t("grading.criteria.total")}>
          {formatPoints(total)} / {formatPoints(itemPoints)}
        </output>
      </p>
    </fieldset>
  );
}

/**
 * The validated points per criterion of a grading, read-only, with the AI's
 * sentence under each when it proposed; nothing without a breakdown.
 */
export function ValidatedBreakdown({ details }: { details: unknown }) {
  const t = useT();
  const breakdown = breakdownOf(details);
  if (breakdown === null) return null;
  const sentences = new Map((aiOf(details)?.criteria ?? []).map((c) => [c.id, c.comment]));
  return (
    <Section title={t("grading.criteria.validated")}>
      <PointsByCriterion
        label={t("grading.criteria.validated")}
        lines={breakdown.map((line) => ({ ...line, key: line.id, note: sentences.get(line.id) }))}
      />
    </Section>
  );
}
