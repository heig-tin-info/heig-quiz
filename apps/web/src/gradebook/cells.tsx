/*
 * What a gradebook cell looks like, for the staff's matrix and the student's
 * list alike (F-GBOOK-01, ADR-074, M5-04): a grade as every screen writes it,
 * the school's absence mark as a sigil of its own, a dash for nothing.
 */
import type { GradebookColumnKind, GradebookStaffRow } from "@quiz/contracts";

import { Grade } from "../Grade";
import type { Dict } from "../i18n";
import { Dash, Tip } from "../ui";

/** A column's kind, in words: an exam, an exercise or a project. */
export const MODE_LABEL: Record<GradebookColumnKind, keyof Dict> = {
  exam: "shome.mode.exam",
  exercise: "shome.mode.exercise",
  project: "sgrades.kind.project",
};

/**
 * The absence mark, `a1.0` (D06): 1.0 marked as an absence, which counts as
 * 1.0 in the mean. Its colour is its own (`info`, DESIGN.md › The gradebook):
 * a real 1.0 is a grade, in `danger`, and the two must never be read for one
 * another. The sigil is the notation of the school and of the CSV, so it is
 * the same in every language; `why` says in words what it stands for.
 */
export function AbsentSigil({ why }: { why: string }) {
  return (
    <Tip label={why}>
      <span className="inline-flex h-5.5 items-center rounded-md bg-info-soft px-1.5 font-mono text-xs font-semibold text-info">
        a1.0
        <span className="sr-only"> ({why})</span>
      </span>
    </Tip>
  );
}

/** A grade, or a dash where there is none (a null mean, an empty cell). */
export const GradeOrDash = ({ value }: { value: number | null }) =>
  value === null ? <Dash /> : <Grade value={value} />;

/** A student as the matrix and its dialogs name them. */
export const fullName = (row: Pick<GradebookStaffRow, "prenom" | "nom">) => `${row.prenom} ${row.nom}`.trim();
