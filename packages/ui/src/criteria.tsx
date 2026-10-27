/**
 * Points per criterion, read-only: one line per criterion, its title, its
 * points over its maximum and, when there is one, the AI's sentence under
 * it. The one list of an AI proposal's breakdown (ADR-063 §4) and of a
 * validated one (ADR-118 §6): the grading panel's, and the essay review's,
 * which a student reads under a shown key — without any sentence, which
 * the caller never passes there.
 */
import type { ReactNode } from "react";

import { formatPoints } from "@quiz/domain";

export interface CriterionLine {
  key: string;
  title: string;
  points: number;
  maxPoints: number;
  /** The AI's sentence on this criterion. */
  note?: string | undefined;
}

export function PointsByCriterion({ label, lines }: { label: string; lines: readonly CriterionLine[] }): ReactNode {
  return (
    <ul className="space-y-2" aria-label={label}>
      {lines.map((line) => (
        <li key={line.key} className="text-[13px]">
          <span className="flex items-baseline justify-between gap-3">
            <span className="font-medium text-fg">{line.title}</span>
            <span className="shrink-0 tabular-nums text-fg-muted">
              {formatPoints(line.points)} / {formatPoints(line.maxPoints)}
            </span>
          </span>
          {line.note ? <span className="block text-fg-muted">{line.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}
