import { useQuery } from "@tanstack/react-query";
import { EyeOff, RefreshCw, Users } from "lucide-react";

import type { DashboardRow, DashboardView, ItemAnswers } from "@quiz/contracts";

import { api } from "../api";
import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { typeLabel } from "../questionTypes";
import { itemAnswersKey } from "../queryKeys";
import { Alert, Badge, Button, EmptyState, Modal, QueryError, Skeleton, VerdictCell, type VerdictState } from "../ui";
import { AnswerCard } from "./AnswerCard";
import { cellState } from "./cells";
import { LEGEND_STATES } from "./Legend";

/**
 * F-DASH-07: one question of the grid opened for the whole class — what the
 * column header `Qn` opens (issue #353).
 *
 * Four decisions:
 *   - it obeys the dashboard's switches, because the dashboard is often
 *     projected (F-DASH-02). Names hidden, every card is "Student 7"; answers
 *     hidden, NOTHING is fetched — the view shows where each student stands
 *     on the question, the grid's own cell states, and says how to show the
 *     answers. Pressing R with the view open switches it in place;
 *   - the summary first, then the students. The summary is the grid's column
 *     counted by state, in the legend's words — no aggregate a type would
 *     have to compute live (the class debrief's distributions wait for the
 *     grading, F-RES-03);
 *   - it is a SNAPSHOT. The answers are read once on opening
 *     (`GET …/items/:itemId/answers`, one query for the class, never one
 *     paper per student) and again on "Refresh"; the states beside them are
 *     the grid's, so they keep moving with the stream while the text stays
 *     what was read;
 *   - each answer is drawn by `AnswerCard`, the card of the whole paper and
 *     of one cell, key included exactly where the paper shows it.
 */
export function QuestionModal({
  evaluationId,
  item,
  number,
  rows,
  nameOf,
  showAnswers,
  showResults,
  onClose,
}: {
  evaluationId: string;
  item: DashboardView["items"][number];
  /** The question's number in the grid, 1-based. */
  number: number;
  /** The grid's rows, in the order the cards are listed. */
  rows: readonly DashboardRow[];
  nameOf: (row: DashboardRow) => string;
  showAnswers: boolean;
  showResults: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const answers = useQuery<ItemAnswers>({
    queryKey: itemAnswersKey(evaluationId, item.id),
    enabled: showAnswers,
    // A snapshot: read on opening, then only when asked.
    staleTime: Infinity,
    gcTime: 0,
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/items/${item.id}/answers`),
  });
  const started = rows.filter((r) => r.attemptId !== null);
  const cellOf = (row: DashboardRow) => row.cells.find((c) => c.itemId === item.id) ?? null;

  return (
    <Modal
      size="xl"
      scroll
      title={t("live.question.title", { n: number })}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="zinc">{typeLabel(t, item.type)}</Badge>
          {showAnswers ? <span className="text-fg-faint">{t("live.question.snapshot")}</span> : null}
        </span>
      }
      onClose={onClose}
      footer={
        <span className="flex w-full items-center justify-end gap-2">
          {showAnswers ? (
            <Button
              variant="ghost"
              size="sm"
              loading={answers.isFetching}
              onClick={() => void answers.refetch()}
            >
              {answers.isFetching ? null : <RefreshCw />}
              {t("live.question.refresh")}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("live.inspect.close")}
          </Button>
        </span>
      }
    >
      <div className="space-y-4">
        <Summary
          states={rows.filter((r) => !r.staff).map((r) => cellOf(r)).flatMap((c) => (c ? [c] : []))}
          showResults={showResults}
        />
        {started.length === 0 ? (
          <EmptyState icon={Users} title={t("live.question.none")} className="py-8" />
        ) : !showAnswers ? (
          <>
            <Alert icon={EyeOff}>{t("live.question.hidden")}</Alert>
            <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {started.map((row) => {
                const cell = cellOf(row);
                return (
                  <li key={row.seatId} className="flex min-w-0 items-center gap-2 py-1 text-[13px]">
                    <span className="w-9 shrink-0">
                      {cell ? <VerdictCell state={cellState(cell, showResults)} flagged={cell.flagged} /> : null}
                    </span>
                    <span className="truncate font-medium">{nameOf(row)}</span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : answers.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : answers.isError || !answers.data ? (
          <QueryError
            title={t("live.question.failed")}
            error={answers.error}
            onRetry={() => void answers.refetch()}
            retrying={answers.isFetching}
            fallback={t("error.server")}
          />
        ) : (
          <AnswerList
            rows={started}
            data={answers.data}
            cellOf={cellOf}
            nameOf={nameOf}
            showResults={showResults}
          />
        )}
      </div>
    </Modal>
  );
}

function AnswerList({
  rows,
  data,
  cellOf,
  nameOf,
  showResults,
}: {
  rows: readonly DashboardRow[];
  data: ItemAnswers;
  cellOf: (row: DashboardRow) => DashboardRow["cells"][number] | null;
  nameOf: (row: DashboardRow) => string;
  showResults: boolean;
}) {
  const t = useT();
  const byAttempt = new Map(data.answers.map((a) => [a.attemptId, a]));
  // A student with nothing written is a name, not a card: twenty empty
  // reviews would bury the four answers the teacher opened this for.
  const blank = rows.filter((r) => byAttempt.get(r.attemptId!)?.answer === null);
  const listed = rows.filter((r) => byAttempt.get(r.attemptId!)?.answer !== null);
  return (
    <>
      {blank.length > 0 ? (
        <p className="text-[13px] text-fg-muted">
          <span className="font-semibold text-fg">{t("live.question.blank", { n: blank.length })}</span>{" "}
          {/* " · ", not a comma: a name is "Rochat, Louis". */}
          {blank.map(nameOf).join(" · ")}
        </p>
      ) : null}
      <ol className="space-y-4">
        {listed.map((row) => {
          const entry = byAttempt.get(row.attemptId!);
          return (
            <li key={row.seatId}>
              {entry ? (
                <AnswerCard
                  heading={nameOf(row)}
                  type={data.item.type}
                  typeBadge={false}
                  cell={cellOf(row)}
                  showResults={showResults}
                  maxPoints={data.item.points}
                  studentConfig={entry.studentConfig}
                  answer={entry.answer}
                  solution={entry.solution}
                />
              ) : (
                // Started (or retaken) after the reading: said, not dropped.
                <p className="rounded-card border border-dashed border-line px-4 py-3 text-[13px] text-fg-muted">
                  <span className="font-semibold text-fg">{nameOf(row)}</span> · {t("live.question.later")}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** Every state the column's cells can wear, in the legend's order and words. */
const SUMMARY_STATES: readonly (readonly [VerdictState, keyof Dict])[] = [
  ...LEGEND_STATES,
  ["pending", "verdict.pending"],
];

/** The column of the grid, counted by state: where the class stands on this question. */
function Summary({
  states,
  showResults,
}: {
  states: readonly DashboardRow["cells"][number][];
  showResults: boolean;
}) {
  const t = useT();
  const counts = new Map<VerdictState, number>();
  for (const cell of states) {
    const state = cellState(cell, showResults);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const flagged = states.filter((c) => c.flagged).length;
  return (
    <ul
      aria-label={t("live.question.summary")}
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-card border border-line px-4 py-3 text-[13px] text-fg-muted"
    >
      {SUMMARY_STATES.filter(([state]) => counts.has(state)).map(([state, key]) => (
        <li key={state} className="flex items-center gap-1.5">
          <span className="w-8">
            <VerdictCell state={state} />
          </span>
          {t(key)}
          <span className="font-semibold tabular-nums text-fg">{counts.get(state)}</span>
        </li>
      ))}
      {flagged > 0 ? (
        <li className="flex items-center gap-1.5">
          <span className="w-8">
            <VerdictCell state="blank" flagged />
          </span>
          {t("live.legend.flag")}
          <span className="font-semibold tabular-nums text-fg">{flagged}</span>
        </li>
      ) : null}
    </ul>
  );
}
