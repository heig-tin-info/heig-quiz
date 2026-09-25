import type { UseQueryResult } from "@tanstack/react-query";
import { CheckCheck, ChevronLeft, ChevronRight, GraduationCap } from "lucide-react";

import type { GradingEntry, GradingQueue, GradingQueueItem } from "@quiz/contracts";

import { useT } from "../i18n";
import {
  Badge,
  Card,
  cx,
  EmptyState,
  IconButton,
  QueryError,
  Skeleton,
  VerdictCell,
} from "../ui";
import { EntryDetail } from "./EntryDetail";
import { EntryList, EntryPicker, entryKey, type RowLabel } from "./EntryList";
import { ListSkeleton } from "./ListSkeleton";
import type { ShownParts } from "./parts";
import { entryVerdict, type GradingOrder } from "./labels";

/**
 * The parts of one step of the grading traversal: the compact list of its
 * answers, and the detail that shows ONE of them at a fixed place (#102).
 * What names the step — its badges — is the step header's (#108), and the
 * re-grade action is on each answer, beside the question it re-grades.
 */

/** A question as every screen of this app names it: "5. its-name", numbered from 1. */
export const questionLabel = (item: Pick<GradingQueueItem, "position" | "internalName">) =>
  `${item.position + 1}. ${item.internalName}`;

/** What names an answer: the student by question, the question by student. */
export function rowLabelFor(order: GradingOrder): RowLabel {
  return (entry, item) =>
    order === "question" ? entry.label : item ? questionLabel(item) : entry.label;
}

interface StepProps {
  order: GradingOrder;
  queue: UseQueryResult<GradingQueue>;
  entries: GradingEntry[];
  items: Map<string, GradingQueueItem>;
  selected: string | null;
  onSelect: (key: string) => void;
}

/**
 * The list column: the answers of the step, one line each. It only exists
 * once there is something to list — the error and empty states are the
 * detail's to say, once, rather than twice side by side.
 */
export function StepList({
  order,
  queue,
  entries,
  items,
  selected,
  onSelect,
  className,
}: StepProps & { className?: string }) {
  if (queue.isLoading) {
    return (
      <Card className={cx("flex-col gap-2 p-3", className)}>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </Card>
    );
  }
  if (queue.isError || entries.length === 0) return null;
  return (
    <Card className={cx("flex-col overflow-hidden", className)}>
      <EntryList
        className="min-h-0 flex-1"
        entries={entries}
        items={items}
        selectedKey={selected}
        onSelect={onSelect}
        rowLabel={rowLabelFor(order)}
      />
    </Card>
  );
}

/**
 * The detail column: the open answer, and nothing that moves.
 *
 * Its header — whose answer, which of how many, Previous / Next — sticks
 * under the step header while the body under it is swapped, so a teacher
 * going through thirty answers keeps their eyes on one spot. The body is in
 * the page's flow (a wheel over it scrolls the page, never a pane of its
 * own), and at least a window tall, so the panel can always bring its top
 * back under the header when another answer opens (`GradingPanel`).
 */
export function StepAnswers({
  order,
  queue,
  entries,
  items,
  selected,
  current,
  onSelect,
  onMove,
  explanations,
  validating,
  onValidate,
  onOverride,
  onRegrade,
  parts,
}: StepProps & {
  /** The open answer and its place, as `useGradingTraversal` resolved it. */
  current: { entry: GradingEntry; index: number } | null;
  /** One answer back (-1) or forward (+1): the same move as the arrow keys. */
  onMove: (delta: number) => void;
  explanations: Map<string, string>;
  validating: boolean;
  onValidate: (gradingId: string) => void;
  onOverride: (key: string) => void;
  /** Re-grade the question of the open answer, for every student (F-GRADE-06). */
  onRegrade: (item: GradingQueueItem) => void;
  /** Which parts of the open answer are drawn (#109). */
  parts: ShownParts;
}) {
  const t = useT();
  const at = current?.index ?? -1;
  const entry = current?.entry;
  const item = entry ? items.get(entry.itemId) : undefined;

  if (queue.isLoading) return <ListSkeleton />;
  if (queue.isError) {
    return (
      <QueryError
        title={t("grading.loadFailed")}
        error={queue.error}
        onRetry={() => void queue.refetch()}
        retrying={queue.isFetching}
        fallback={t("error.server")}
      />
    );
  }
  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState icon={CheckCheck} title={t("grading.empty.title")}>
          {t("grading.empty.body")}
        </EmptyState>
      </Card>
    );
  }

  const rowLabel = rowLabelFor(order);
  const staffBadge = (
    <Badge tone="zinc" icon={GraduationCap}>
      {t("roster.status.staff")}
    </Badge>
  );
  return (
    <>
      <EntryPicker
        className="lg:hidden"
        entries={entries}
        items={items}
        selectedKey={selected}
        onSelect={onSelect}
        rowLabel={rowLabel}
      />
      <section
        aria-label={t("grading.detail.label")}
        // `overflow-clip`, not `hidden`: a hidden overflow is a scroll
        // container, and the sticky header inside would stick to nothing.
        className="flex min-h-[calc(100dvh-5rem)] flex-col overflow-clip rounded-card border border-line bg-surface lg:min-h-[calc(100dvh-var(--grading-sticky)-1rem)]"
      >
        <header className="sticky top-16 z-10 flex items-center gap-3 rounded-t-card border-b border-line bg-surface px-4 py-3 sm:px-5 lg:top-(--grading-sticky)">
          {entry ? (
            <span className="w-10 shrink-0">
              <VerdictCell state={entryVerdict(entry)} />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            {/* Whose answer to which question, in both orders (#119): what
                changes from one answer to the next on top, the other under
                it with the position. The student is the server's label — a
                name when names are shown, the pseudonym otherwise. */}
            <p className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <span className="truncate">{entry ? rowLabel(entry, item) : "—"}</span>
              {entry?.staff && order === "question" ? staffBadge : null}
            </p>
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
              {entry ? (
                <>
                  <span className="min-w-0 truncate font-medium">
                    {order === "question" ? (item ? questionLabel(item) : "—") : entry.label}
                  </span>
                  {entry.staff && order === "student" ? staffBadge : null}
                  <span className="text-fg-faint" aria-hidden>
                    ·
                  </span>
                </>
              ) : null}
              <span className="shrink-0 tabular-nums text-fg-faint">
                {t("grading.detail.position", { n: at + 1, total: entries.length })}
              </span>
            </p>
          </div>
          <IconButton
            label={t("grading.detail.prev")}
            onClick={() => onMove(-1)}
            disabled={at <= 0}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            label={t("grading.detail.next")}
            onClick={() => onMove(1)}
            disabled={at < 0 || at >= entries.length - 1}
          >
            <ChevronRight />
          </IconButton>
        </header>
        <div>
          {entry && item ? (
            <EntryDetail
              key={entryKey(entry)}
              entry={entry}
              item={item}
              order={order}
              parts={parts}
              onRegrade={() => onRegrade(item)}
              explanation={explanations.get(entry.itemId) ?? null}
              validating={validating}
              onValidate={() => {
                if (entry.grading) onValidate(entry.grading.id);
              }}
              onOverride={() => onOverride(entryKey(entry))}
            />
          ) : null}
        </div>
      </section>
    </>
  );
}
