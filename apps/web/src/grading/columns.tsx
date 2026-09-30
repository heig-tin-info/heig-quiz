import type { GradingEntry } from "@quiz/contracts";
import type { GradingColumn } from "@quiz/core/client";

import type { TFunction } from "../i18n";
import { gradingStrings, questionType } from "../questionTypes";
import { isMissing, verdictRank } from "./rows";

/**
 * The answer columns of one question in the grading table (ADR-044): the
 * question type's own (`QuestionTypeClient.grading`, required), with its
 * words translated here (N-I18N-01). There is no fallback column: a type
 * without columns does not compile. A type this build does not carry has
 * none, and its rows show their verdict and points only.
 */
export function gradingColumns(
  t: TFunction,
  type: string,
  student: unknown,
  solution: unknown,
): GradingColumn[] {
  const client = questionType(type);
  return client ? client.grading.columns(student, solution, gradingStrings[client.id](t)) : [];
}

/**
 * A column the table sorts by: the host's own (verdict, student, points)
 * and the type's, in ONE list, the order of the table. The header is drawn
 * from it and the sort reads it, so a column cannot sort one way and be
 * labelled another.
 */
export interface SortColumn {
  key: string;
  label: string;
  title?: string | undefined;
  align?: "center" | "right" | undefined;
  /** An answer column of the question type (a missing answer spans them all). */
  answer: boolean;
  sortValue(entry: GradingEntry): string | number;
}

export function sortColumns(
  t: TFunction,
  columns: readonly GradingColumn[],
  named: boolean,
  whoOf: (entry: GradingEntry) => string,
): SortColumn[] {
  return [
    { key: "verdict", label: t("grading.col.verdict"), answer: false, sortValue: verdictRank },
    ...(named
      ? [{ key: "name", label: t("grading.col.student"), answer: false, sortValue: whoOf }]
      : []),
    ...columns.map((c) => ({
      key: c.key,
      label: c.label,
      title: c.title,
      align: c.align,
      answer: true,
      sortValue: (e: GradingEntry) => (isMissing(e) ? "" : c.sortKey(e.answer)),
    })),
    {
      key: "points",
      label: t("grading.col.points"),
      align: "right" as const,
      answer: false,
      sortValue: (e: GradingEntry) => e.grading?.points ?? Number.NEGATIVE_INFINITY,
    },
  ];
}
