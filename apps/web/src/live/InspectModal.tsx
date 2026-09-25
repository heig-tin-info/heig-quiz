import { ChevronLeft, ChevronRight, FileQuestion } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { DashboardRow } from "@quiz/contracts";

import { useT } from "../i18n";
import { QuestionReviewHost, typeLabel } from "../questionTypes";
import type { GridState } from "../realtime/grid";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  isTyping,
  Modal,
  QueryError,
  Skeleton,
  VerdictCell,
} from "../ui";
import { cellState } from "./cells";
import { useAttemptInspect } from "./useAttemptInspect";

/**
 * F-DASH-05: one student's whole paper, read from the grid.
 *
 * It used to be a card BESIDE the grid, on the argument that a teacher opens
 * it to compare one student with the rest of the class and that a backdrop
 * takes away the half of the screen they came for. In use it was the
 * opposite: the panel squeezed the grid it was supposed to be compared with,
 * it showed ONE question at a time, and reading a student meant clicking ten
 * cells across a column that had just become narrower. What a teacher
 * actually does at that moment is read one person — so this is a modal, it is
 * wide, and it holds EVERY answer stacked in the order of the quiz. The grid
 * is still there the moment Escape is pressed.
 *
 * One query per opening (`GET …/attempts/:attemptId`), never one per
 * question. The footer walks to the next student, which re-keys the query;
 * the arrows do the same from the keyboard, because a teacher going down a
 * class of twenty-four should not have to aim at a chevron twenty-four times.
 *
 * Each answer is rendered by the question type's own `Review` through
 * `QuestionReviewHost`, `audience` "teacher": the host injects the French
 * strings AND `MarkdownView` in its inline form, so a prompt with backticks,
 * bold or a formula reads here exactly as the student read it, and this file
 * never learns what any type's answer looks like.
 */
export function InspectModal({
  evaluationId,
  state,
  row,
  itemId,
  nameOf,
  onSelect,
  onClose,
}: {
  evaluationId: string;
  state: GridState;
  row: DashboardRow;
  /** The cell that was clicked: the modal opens scrolled onto that question. */
  itemId: string;
  nameOf: (row: DashboardRow) => string;
  onSelect: (row: DashboardRow, itemId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { view } = state;
  const inspect = useAttemptInspect(evaluationId, row.attemptId);

  const rowsWithAttempt = view.rows.filter((r) => r.attemptId !== null);
  const rowIndex = rowsWithAttempt.findIndex((r) => r.seatId === row.seatId);
  const goRow = (delta: number) => {
    const next = rowsWithAttempt[rowIndex + delta];
    if (next) onSelect(next, itemId);
  };

  // ← / → walk the class. They are on the window rather than on the panel
  // because the focus legitimately moves inside the list while reading, and
  // an arrow answered only by the footer buttons is an arrow that works once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (isTyping(e.target)) return;
      e.preventDefault();
      goRow(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /*
   * The question that was clicked, brought into view once its content is
   * there. `useLayoutEffect` so it happens before the paint: a modal that
   * opens at question one and then jumps to question seven reads as a bug.
   *
   * NOT `scrollIntoView`: that scrolls every scrollable ancestor, and the
   * dialog's own backdrop is one of them — the panel slid up out of the
   * viewport and took its title with it. Only the nearest scroller moves,
   * and it moves by the exact distance between the two boxes.
   */
  const anchors = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    const el = anchors.current.get(itemId);
    if (!el) return;
    let box = el.parentElement;
    while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
    if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
  }, [itemId, inspect.data]);

  const name = nameOf(row);
  const position = t("live.inspect.position", {
    n: rowIndex + 1,
    total: rowsWithAttempt.length,
  });

  return (
    <Modal
      size="xl"
      scroll
      title={t("live.inspect.all", { name })}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          {row.state === "submitted" ? (
            <Badge tone="green">{t("live.row.submitted")}</Badge>
          ) : row.state === "expired" ? (
            <Badge tone="zinc">{t("live.row.expired")}</Badge>
          ) : null}
          <span className="text-fg-faint">{t("live.inspect.keys")}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <span className="flex w-full items-center justify-between gap-2">
          <span className="text-xs tabular-nums text-fg-muted">{position}</span>
          <span className="flex items-center gap-1">
            <IconButton
              label={t("live.inspect.prev")}
              disabled={rowIndex <= 0}
              onClick={() => goRow(-1)}
            >
              <ChevronLeft />
            </IconButton>
            <IconButton
              label={t("live.inspect.next")}
              disabled={rowIndex < 0 || rowIndex >= rowsWithAttempt.length - 1}
              onClick={() => goRow(1)}
            >
              <ChevronRight />
            </IconButton>
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("live.inspect.close")}
            </Button>
          </span>
        </span>
      }
    >
      {row.attemptId === null ? (
        <EmptyState icon={FileQuestion} title={t("live.inspect.notStarted")} className="py-8" />
      ) : inspect.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : inspect.isError || !inspect.data ? (
        <QueryError
          title={t("live.inspect.failed")}
          error={inspect.error}
          onRetry={() => void inspect.refetch()}
          retrying={inspect.isFetching}
          fallback={t("error.server")}
        />
      ) : inspect.data.items.length === 0 ? (
        <EmptyState icon={FileQuestion} title={t("live.inspect.noAnswer")} className="py-8" />
      ) : (
        <ol className="space-y-4">
          {inspect.data.items.map((entry, index) => {
            const cell = row.cells.find((c) => c.itemId === entry.item.id) ?? null;
            return (
              <li
                key={entry.item.id}
                ref={(el) => {
                  if (el) anchors.current.set(entry.item.id, el);
                  else anchors.current.delete(entry.item.id);
                }}
                className="scroll-mt-2 rounded-card border border-line bg-surface-2/40 p-4"
              >
                <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-line pb-2">
                  <span className="text-[13px] font-semibold">
                    {t("live.grid.question", { n: index + 1 })}
                  </span>
                  <Badge tone="zinc">{typeLabel(t, entry.item.type)}</Badge>
                  {cell ? (
                    <span className="w-9">
                      <VerdictCell state={cellState(cell, true)} />
                    </span>
                  ) : null}
                  {/* Only a score that EXISTS is printed here: the type's
                      own review already ends on a "Score — / n" line, and
                      "graded once the evaluation is closed" repeated under
                      every question of ten is a paragraph nobody reads. */}
                  {cell?.points == null ? null : (
                    <span className="ml-auto text-xs tabular-nums text-fg-muted">
                      {t("live.inspect.points", { points: cell.points, max: entry.item.points })}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <QuestionReviewHost
                    t={t}
                    type={entry.item.type}
                    student={entry.studentConfig}
                    answer={entry.answer}
                    solution={entry.solution}
                    details={null}
                    points={cell?.points ?? null}
                    maxPoints={entry.item.points}
                    audience="teacher"
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Modal>
  );
}
