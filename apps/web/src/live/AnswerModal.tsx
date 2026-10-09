import { EyeOff, FileQuestion } from "lucide-react";

import type { DashboardRow } from "@quiz/contracts";

import { useT } from "../i18n";
import { Alert, Button, EmptyState, Modal, QueryError, Skeleton, VerdictCell } from "../ui";
import { AnswerCard } from "./AnswerCard";
import { cellState } from "./cells";
import { useAttemptInspect } from "./useAttemptInspect";

/**
 * F-DASH-05: a click on a cell opens THAT answer — one student, one question —
 * and nothing else (issue #353). The whole paper is the row's eye
 * (`InspectModal`), one step away in the footer for the teacher who wanted
 * more than they clicked.
 *
 * It reads the paper the tooltip of the cell already reads
 * (`useAttemptInspect`: one query, one cache key), so a cell hovered on the
 * way to the click opens filled, and no route exists for one answer alone.
 * The paper is fetched whole and one item of it is shown: at the size of a
 * paper that is cheaper than a second endpoint and a second cache to keep
 * fresh.
 *
 * It obeys the "Answers" switch like the grid and the question view: the
 * dashboard is often projected (F-DASH-02), so with the answers hidden it
 * fetches nothing and shows the cell's state and how to show the answers.
 * The whole paper, a deliberate step, keeps showing everything.
 */
export function AnswerModal({
  evaluationId,
  row,
  itemId,
  number,
  name,
  showAnswers,
  showResults,
  onPaper,
  onClose,
}: {
  evaluationId: string;
  row: DashboardRow;
  itemId: string;
  /** The question's number in the grid, 1-based. */
  number: number;
  /** The row's name as the grid shows it (F-DASH-02). */
  name: string;
  showAnswers: boolean;
  showResults: boolean;
  /** Open the student's whole paper instead. */
  onPaper: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const inspect = useAttemptInspect(evaluationId, row.attemptId, showAnswers);
  const entry = inspect.data?.items.find((i) => i.item.id === itemId);
  const cell = row.cells.find((c) => c.itemId === itemId) ?? null;

  return (
    <Modal
      size="lg"
      scroll
      title={t("live.answer.title", { name, n: number })}
      onClose={onClose}
      footer={
        <span className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onPaper}>
            {t("live.answer.paper")}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("live.inspect.close")}
          </Button>
        </span>
      }
    >
      {!showAnswers ? (
        <div className="space-y-4">
          {cell ? (
            <span className="block w-9">
              <VerdictCell state={cellState(cell, showResults)} flagged={cell.flagged} />
            </span>
          ) : null}
          <Alert icon={EyeOff}>{t("live.answersHidden")}</Alert>
        </div>
      ) : inspect.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : inspect.isError || !inspect.data ? (
        <QueryError title={t("live.inspect.failed")} query={inspect} />
      ) : !entry ? (
        <EmptyState icon={FileQuestion} title={t("live.inspect.noAnswer")} className="py-8" />
      ) : (
        <AnswerCard
          type={entry.item.type}
          cell={cell}
          maxPoints={entry.item.points}
          studentConfig={entry.studentConfig}
          answer={entry.answer}
          solution={entry.solution}
        />
      )}
    </Modal>
  );
}
