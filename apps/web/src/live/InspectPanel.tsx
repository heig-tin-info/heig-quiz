import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Suspense, type ComponentType } from "react";

import type { ReviewProps } from "@quiz/core/client";
import type { AttemptInspect, DashboardRow } from "@quiz/contracts";
import { questionTypeClient } from "@quiz/registry/client";

import { api } from "../api";
import { typeLabel } from "../evaluation/common";
import { useT } from "../i18n";
import type { GridState } from "../realtime/grid";
import { Alert, Badge, EmptyState, IconButton, QueryError, Skeleton, Spinner } from "../ui";

/**
 * F-DASH-05: one student's answer, read from the grid.
 *
 * It is IN FLOW, beside the grid, and not a modal: the teacher opens it to
 * compare what one student wrote with what the rest of the class is doing,
 * and a dimmed backdrop takes away exactly the half of the screen they came
 * for. Under `lg` it drops below the grid instead — a 390 px column has no
 * room for two.
 *
 * The answer is rendered by the question type's own `Review`, `audience`
 * "teacher", so the key and the per-case detail appear here and the panel
 * itself never learns what any type's answer looks like.
 */

/**
 * The registry erases every type parameter, so the component it hands back is
 * a `Review` of `unknown`s. Nothing is lost: the payloads it renders come
 * from the same endpoint, and only the type itself knows their shape.
 *
 * No `renderMarkdown` is passed. Each type drops the renderer's output inside
 * its own `<p>`, and `MarkdownView` is a BLOCK renderer (it emits `<p>`), so
 * handing it over produces invalid nesting. Prompts therefore read as plain
 * text here until a host inline renderer exists; the panel is for the
 * student's ANSWER, which is rendered by the type either way.
 */
type AnyReview = ComponentType<ReviewProps<unknown, unknown, unknown, unknown>>;

export function InspectPanel({
  evaluationId,
  state,
  row,
  itemId,
  onSelect,
  onClose,
}: {
  evaluationId: string;
  state: GridState;
  row: DashboardRow;
  itemId: string;
  onSelect: (row: DashboardRow, itemId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { view } = state;
  const inspect = useQuery<AttemptInspect>({
    queryKey: ["attempt-inspect", evaluationId, row.attemptId],
    enabled: row.attemptId !== null,
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/attempts/${row.attemptId}`),
  });

  const itemIndex = Math.max(
    0,
    view.items.findIndex((i) => i.id === itemId),
  );
  const rowsWithAttempt = view.rows.filter((r) => r.attemptId !== null);
  const rowIndex = rowsWithAttempt.findIndex((r) => r.userId === row.userId);
  const goRow = (delta: number) => {
    const next = rowsWithAttempt[rowIndex + delta];
    if (next) onSelect(next, itemId);
  };
  const goItem = (delta: number) => {
    const next = view.items[itemIndex + delta];
    if (next) onSelect(row, next.id);
  };

  const entry = inspect.data?.items.find((i) => i.item.id === view.items[itemIndex]?.id) ?? null;
  const name = inspect.data?.attempt.displayName ?? row.displayName;

  return (
    <aside
      aria-label={t("live.inspect.label", { name })}
      className="flex w-full shrink-0 flex-col rounded-card border border-line bg-surface lg:sticky lg:top-6 lg:max-h-[calc(100dvh-6rem)] lg:w-96"
    >
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold tracking-tight">{name}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[13px] text-fg-muted">
            {t("live.grid.question", { n: itemIndex + 1 })}
            {view.items[itemIndex] ? (
              <Badge tone="zinc">{typeLabel(view.items[itemIndex]!.type, t)}</Badge>
            ) : null}
          </p>
        </div>
        <IconButton label={t("live.inspect.close")} onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {row.attemptId === null ? (
          <EmptyState icon={ChevronRight} title={t("live.inspect.notStarted")} className="py-8" />
        ) : inspect.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : inspect.isError || !inspect.data ? (
          <QueryError
            title={t("live.inspect.failed")}
            error={inspect.error}
            onRetry={() => void inspect.refetch()}
            retrying={inspect.isFetching}
            fallback={t("error.server")}
          />
        ) : entry === null ? (
          <Alert title={t("live.inspect.noAnswer")} />
        ) : (
          <div className="space-y-3">
            <Suspense fallback={<Spinner className="py-8" />}>
              {(() => {
                const Review = questionTypeClient(entry.item.type as never).Review as AnyReview;
                return (
                  <Review
                    student={entry.studentConfig}
                    answer={entry.answer}
                    solution={entry.solution}
                    details={null}
                    points={null}
                    maxPoints={entry.item.points}
                    audience="teacher"
                  />
                );
              })()}
            </Suspense>
            <p className="text-xs text-fg-faint">{t("live.inspect.awaiting")}</p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
        <span className="flex items-center gap-0.5">
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
        </span>
        <span className="flex items-center gap-0.5">
          <IconButton
            label={t("live.inspect.prevQuestion")}
            disabled={itemIndex <= 0}
            onClick={() => goItem(-1)}
          >
            <ChevronLeft />
          </IconButton>
          <span className="px-1 text-xs tabular-nums text-fg-muted">
            {itemIndex + 1} / {view.items.length}
          </span>
          <IconButton
            label={t("live.inspect.nextQuestion")}
            disabled={itemIndex >= view.items.length - 1}
            onClick={() => goItem(1)}
          >
            <ChevronRight />
          </IconButton>
        </span>
      </div>
    </aside>
  );
}
