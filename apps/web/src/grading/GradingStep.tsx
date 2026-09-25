import type { UseQueryResult } from "@tanstack/react-query";
import { CheckCheck, ChevronLeft, ChevronRight, GraduationCap, RefreshCcw } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import type { GradingEntry, GradingQueue, GradingQueueItem } from "@quiz/contracts";

import { useT } from "../i18n";
import { typeLabel } from "../questionTypes";
import {
  Badge,
  Button,
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
import { entryVerdict, ORDER_WORDS, type GradingOrder } from "./labels";

/**
 * The parts of one step of the grading traversal: the card that names the
 * step (and, on a question, offers to re-grade it), the compact list of its
 * answers, and the detail that shows ONE of them at a fixed place (#102).
 */

/** What names an answer: the student by question, the question by student. */
export function rowLabelFor(order: GradingOrder): RowLabel {
  return (entry, item) =>
    order === "question"
      ? entry.label
      : item
        ? `${item.position + 1}. ${item.internalName}`
        : entry.label;
}

export function StepCard({
  order,
  label,
  item,
  total,
  onRegrade,
}: {
  order: GradingOrder;
  label: string | undefined;
  /** The question of the step, traversing by question; absent by student. */
  item: GradingQueueItem | undefined;
  total: number;
  onRegrade: () => void;
}) {
  const t = useT();
  return (
    <Card className="space-y-3 p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-faint">
        {t(ORDER_WORDS[order].heading)}
      </p>
      <p className="text-base font-semibold tracking-tight">{label}</p>
      {item ? (
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="zinc">{typeLabel(t, item.type)}</Badge>
          <Badge tone="zinc">{t("grading.points", { n: item.points })}</Badge>
          <Badge tone="zinc">{t("grading.answers", { n: total })}</Badge>
        </div>
      ) : (
        <Badge tone="zinc">{t("grading.answers", { n: total })}</Badge>
      )}
      {item ? (
        <Button variant="ghost" size="sm" onClick={onRegrade}>
          <RefreshCcw /> {t("grading.regrade")}
        </Button>
      ) : null}
    </Card>
  );
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
 * Its header — whose answer, which of how many, Previous / Next — stays where
 * it is while the body under it is swapped, so a teacher going through thirty
 * answers keeps their eyes on one spot. On a wide screen the body scrolls on
 * its own and goes back to its top on every change: the next answer is read
 * from its beginning, not from wherever the last one was left.
 */
export function StepAnswers({
  order,
  queue,
  entries,
  items,
  selected,
  onSelect,
  onMove,
  explanations,
  validating,
  onValidate,
  onOverride,
}: StepProps & {
  /** One answer back (-1) or forward (+1): the same move as the arrow keys. */
  onMove: (delta: number) => void;
  explanations: Map<string, string>;
  validating: boolean;
  onValidate: (gradingId: string) => void;
  onOverride: (key: string) => void;
}) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);

  const at = entries.findIndex((e) => entryKey(e) === selected);
  const entry = at < 0 ? undefined : entries[at];
  const item = entry ? items.get(entry.itemId) : undefined;
  const openKey = entry ? entryKey(entry) : null;

  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [openKey]);

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
        className="flex flex-col overflow-hidden rounded-card border border-line bg-surface lg:min-h-0 lg:flex-1"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
          {entry ? (
            <span className="w-10 shrink-0">
              <VerdictCell state={entryVerdict(entry)} />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <span className="truncate">{entry ? rowLabel(entry, item) : "—"}</span>
              {entry?.staff ? (
                <Badge tone="zinc" icon={GraduationCap}>
                  {t("roster.status.staff")}
                </Badge>
              ) : null}
            </p>
            <p className="text-xs tabular-nums text-fg-faint">
              {t("grading.detail.position", { n: at + 1, total: entries.length })}
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
        <div ref={body} className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {entry && item ? (
            <EntryDetail
              key={openKey}
              entry={entry}
              item={item}
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
