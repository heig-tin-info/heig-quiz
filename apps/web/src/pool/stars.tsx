/**
 * Favourite stars (F-POOL-10, ADR-039): the caller's own bookmarks on the
 * questions of a pool. A star is personal — a colleague never sees it — so
 * it is a preference, not an edit, and a reader may star as well.
 *
 * A star is written OPTIMISTICALLY: the rows already in the cache flip at
 * once (every list of the pool, the question picker's included), the request
 * follows, and a failure puts the cached pages back as they were. Nothing is
 * refetched per star but the small favourites query, which drives the pool
 * screen's "Clear favourites" and the picker's section.
 */
import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useRef } from "react";

import type { QuestionPage, QuestionRow, QuestionStarBody, StarsCleared } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { poolQuestionListsKey, poolStarredKey } from "../queryKeys";
import { IconButton } from "../ui";

/**
 * The favourites of a pool, in one page: 200 is the most a batch can star,
 * and "a few questions for Friday's test" is far below it.
 */
const STARRED_SEARCH = "?starred=1&limit=200";

/** The caller's starred questions of a pool; disabled while `poolId` is null. */
export function useStarredQuestions(poolId: string | null) {
  return useQuery<QuestionPage>({
    queryKey: poolStarredKey(poolId ?? ""),
    queryFn: () => api(`/app/api/pools/${poolId}/questions${STARRED_SEARCH}`),
    enabled: poolId !== null,
  });
}

/**
 * `(ids, starred) => ok`: stars or unstars a batch of one pool's questions,
 * optimistically, and `clearAll` for the pool's "Clear favourites". Null
 * while no pool is shown: both are then no-ops.
 *
 * A question whose request is still in flight is left out of the next one:
 * two quick toggles would otherwise race, and the server could apply them in
 * the other order. The second press is simply ignored.
 */
export function useSetStars(poolId: string | null) {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const pending = useRef(new Set<string>());

  const patch = (pool: string, ids: ReadonlySet<string>, starred: boolean) =>
    qc.setQueriesData<InfiniteData<QuestionPage>>({ queryKey: poolQuestionListsKey(pool) }, (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((row) =>
                ids.has(row.id) && row.starred !== starred ? { ...row, starred } : row,
              ),
            })),
          }
        : data,
    );

  const setStars = async (questionIds: string[], starred: boolean): Promise<boolean> => {
    if (poolId === null || questionIds.length === 0) return true;
    const ids = questionIds.filter((id) => !pending.current.has(id));
    // Every id is already on its way: nothing was sent, so nothing succeeded.
    if (ids.length === 0) return false;
    const lists = poolQuestionListsKey(poolId);
    for (const id of ids) pending.current.add(id);
    // A page landing mid-flight would overwrite the patch with the old flag.
    await qc.cancelQueries({ queryKey: lists });
    const before = qc.getQueriesData<InfiniteData<QuestionPage>>({ queryKey: lists });
    patch(poolId, new Set(ids), starred);
    const body: QuestionStarBody = { questionIds: ids };
    try {
      await api("/app/api/questions/star", {
        method: starred ? "PUT" : "DELETE",
        body: JSON.stringify(body),
      });
      return true;
    } catch (error) {
      for (const [key, data] of before) qc.setQueryData(key, data);
      toastError("pool.star.failed")(error);
      return false;
    } finally {
      for (const id of ids) pending.current.delete(id);
      void qc.invalidateQueries({ queryKey: poolStarredKey(poolId) });
    }
  };

  /**
   * `DELETE /pools/:id/stars`; the count it answers, or null on a failure.
   * The rows to unstar in the cache are the favourites query's own; when it
   * does not hold them all (more than one page), the lists are refetched.
   */
  const clearAll = async (): Promise<number | null> => {
    if (poolId === null) return null;
    const favourites = qc.getQueryData<QuestionPage>(poolStarredKey(poolId));
    try {
      const { cleared } = await api<StarsCleared>(`/app/api/pools/${poolId}/stars`, {
        method: "DELETE",
      });
      if (favourites && favourites.items.length === favourites.total) {
        patch(poolId, new Set(favourites.items.map((r) => r.id)), false);
      } else {
        void qc.invalidateQueries({ queryKey: poolQuestionListsKey(poolId) });
      }
      return cleared;
    } catch (error) {
      toastError("pool.star.failed")(error);
      return null;
    } finally {
      void qc.invalidateQueries({ queryKey: poolStarredKey(poolId) });
    }
  };

  return { setStars, clearAll };
}

/**
 * The star of a row or a card: an outline at rest, filled in ink when
 * starred — never in red, which is the screen's one primary action. A toggle
 * (`aria-pressed`), named after the question, and Space on the focused row
 * does the same (`useQuestionBrowse`). A soft-deleted question has none: its
 * star is hidden until it comes back.
 */
export function StarButton({ row, onToggle }: { row: QuestionRow; onToggle: () => void }) {
  const t = useT();
  if (row.deletedAt) return <span aria-hidden className="size-7 shrink-0" />;
  return (
    <span onClick={(e) => e.stopPropagation()} className="inline-flex">
      <IconButton
        size="sm"
        label={t("pool.star.toggle", { name: row.internalName })}
        aria-pressed={row.starred}
        shortcut="Space"
        onClick={onToggle}
      >
        <Star className={row.starred ? "fill-current text-fg" : undefined} />
      </IconButton>
    </span>
  );
}
