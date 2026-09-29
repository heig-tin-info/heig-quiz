import type { GradingEntry } from "@quiz/contracts";
import type { GradingColumn } from "@quiz/core/client";
import { gradingSortKey } from "@quiz/core/client";
import { NoAnswer } from "@quiz/ui";

import type { TFunction } from "../i18n";
import { answerText, isEmptyAnswerText, type AnswerText } from "../live/answerText";
import { gradingStrings, questionType } from "../questionTypes";
import { isMissing, verdictRank } from "./rows";

/**
 * The answer columns of one question in the grading table (ADR-040).
 *
 * A type that gives columns (`QuestionTypeClient.grading`) is asked for
 * them, with its words translated here (N-I18N-01). A type that does not
 * gets ONE column holding its answer as text — the dashboard tooltip's
 * reading of it (`answerText`), else the type's own `summarize` (a
 * schematic), else a line inviting to open the answer. The expected row
 * then reads an em dash: a key the host cannot read as text is shown in
 * full in the answer panel, not guessed at here.
 */
export function gradingColumns(
  t: TFunction,
  type: string,
  student: unknown,
  solution: unknown,
): GradingColumn[] {
  const client = questionType(type);
  if (client?.grading) {
    return client.grading.columns(student, solution, gradingStrings[client.id]?.(t));
  }
  const textOf = (answer: unknown): AnswerText | null => {
    const text = answerText(type, student, answer);
    if (text !== null || client?.summarize === undefined) return text;
    try {
      return { kind: "text", text: client.summarize(answer, student), truncated: false };
    } catch {
      return null;
    }
  };
  return [
    {
      key: "answer",
      label: t("grading.col.answer"),
      cell: ({ answer }) => <FallbackCell t={t} text={textOf(answer)} />,
      expected: () => <span className="text-fg-faint">—</span>,
      sortKey: (answer) => gradingSortKey(plain(textOf(answer))),
    },
  ];
}

/** The text of an answer on one line, for sorting. */
function plain(text: AnswerText | null): string {
  if (text === null) return "";
  switch (text.kind) {
    case "choices":
      return text.items.map((i) => i.letter).join(" ");
    case "blanks":
      return text.items.map((b) => b ?? "").join(" ");
    case "text":
      return text.text;
    case "code":
      return text.lines.join("\n");
  }
}

function FallbackCell({ t, text }: { t: TFunction; text: AnswerText | null }) {
  if (text === null) return <NoAnswer>{t("grading.fallback.open")}</NoAnswer>;
  if (isEmptyAnswerText(text)) return <NoAnswer>{t("grading.noAnswer.short")}</NoAnswer>;
  if (text.kind === "code") {
    // Three lines are enough to tell two programs apart; the panel has the rest.
    return (
      <pre className="line-clamp-3 max-w-[110ch] whitespace-pre-wrap rounded-field bg-surface-2 px-2.5 py-1.5 font-mono text-xs leading-snug text-fg">
        {text.lines.join("\n")}
      </pre>
    );
  }
  return (
    <p className="line-clamp-3 max-w-[110ch] whitespace-pre-wrap text-[13px] leading-snug text-fg-muted">
      {plain(text)}
    </p>
  );
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
