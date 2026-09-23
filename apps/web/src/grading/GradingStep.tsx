import type { UseQueryResult } from "@tanstack/react-query";
import { CheckCheck, RefreshCcw } from "lucide-react";

import type { GradingEntry, GradingQueue, GradingQueueItem } from "@quiz/contracts";

import { useT } from "../i18n";
import { typeLabel } from "../questionTypes";
import { Badge, Button, Card, EmptyState, QueryError } from "../ui";
import { EntryDetail } from "./EntryDetail";
import { EntryList, entryKey } from "./EntryList";
import { ListSkeleton } from "./ListSkeleton";
import { ORDER_WORDS, type GradingOrder } from "./labels";

/**
 * The two halves of one step of the grading traversal: the card that names
 * the step (and, on a question, offers to re-grade it), and the answers of
 * the step in each of the states their read can be in.
 */

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

export function StepAnswers({
  order,
  queue,
  entries,
  items,
  selected,
  onSelect,
  explanations,
  validating,
  onValidate,
  onOverride,
}: {
  order: GradingOrder;
  queue: UseQueryResult<GradingQueue>;
  entries: GradingEntry[];
  items: Map<string, GradingQueueItem>;
  selected: string | null;
  onSelect: (key: string) => void;
  explanations: Map<string, string>;
  validating: boolean;
  onValidate: (gradingId: string) => void;
  onOverride: (key: string) => void;
}) {
  const t = useT();
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
  return (
    <EntryList
      entries={entries}
      items={items}
      selectedKey={selected}
      onSelect={onSelect}
      rowLabel={(entry, item) =>
        order === "question"
          ? entry.label
          : item
            ? `${item.position + 1}. ${item.internalName}`
            : entry.label
      }
      renderDetail={(entry, item) => (
        <EntryDetail
          entry={entry}
          item={item}
          explanation={explanations.get(entry.itemId) ?? null}
          validating={validating}
          onValidate={() => {
            if (entry.grading) onValidate(entry.grading.id);
          }}
          onOverride={() => onOverride(entryKey(entry))}
        />
      )}
    />
  );
}
