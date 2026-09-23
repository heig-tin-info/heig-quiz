import { FileQuestion, Plus } from "lucide-react";

import { useT } from "../i18n";
import { Button, Card, EmptyState, Spinner } from "../ui";
import type { ListView } from "./FilterBar";
import { QuestionCardsSkeleton } from "./QuestionCards";
import { QuestionTableSkeleton } from "./QuestionTable";

/**
 * The states of the pool's question list around the list itself: loading in
 * the shape of the reading the viewer picked, empty (a new pool, or filters
 * that hide everything), and the tail under a loaded page.
 */

/** The skeleton of the reading about to appear, cards or table. */
export function PoolListSkeleton({ view }: { view: ListView }) {
  return view === "cards" ? (
    <QuestionCardsSkeleton />
  ) : (
    <Card>
      <QuestionTableSkeleton />
    </Card>
  );
}

/**
 * Nothing to show. A pool with no question at all offers to create the first
 * one — unless the caller only reads it (F-POOL-05), where the action is
 * absent; a pool whose filters hide every question offers to clear them.
 */
export function PoolEmpty({
  questionCount,
  readOnly,
  onCreate,
  onClearFilters,
}: {
  questionCount: number;
  readOnly: boolean;
  onCreate: () => void;
  onClearFilters: () => void;
}) {
  const t = useT();
  const empty = questionCount === 0;
  return (
    <Card>
      <EmptyState
        icon={FileQuestion}
        title={t(empty ? "pool.empty.title" : "pool.emptyFiltered.title")}
        action={
          empty ? (
            readOnly ? undefined : (
              <Button onClick={onCreate}>
                <Plus /> {t("pool.newQuestion")}
              </Button>
            )
          ) : (
            <Button variant="secondary" onClick={onClearFilters}>
              {t("pool.filter.clear")}
            </Button>
          )
        }
      >
        {t(empty ? "pool.empty.body" : "pool.emptyFiltered.body")}
      </EmptyState>
    </Card>
  );
}

/** Under a loaded page: "Load more" while there is a next one, and a refetch spinner. */
export function PoolListTail({
  hasNextPage,
  fetchingNext,
  refetching,
  onLoadMore,
}: {
  hasNextPage: boolean;
  fetchingNext: boolean;
  refetching: boolean;
  onLoadMore: () => void;
}) {
  const t = useT();
  return (
    <>
      {hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="secondary" loading={fetchingNext} onClick={onLoadMore}>
            {t("pool.loadMore")}
          </Button>
        </div>
      ) : null}
      {refetching ? <Spinner className="py-2" /> : null}
    </>
  );
}
