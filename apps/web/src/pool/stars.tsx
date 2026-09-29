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
 * optimistically. `ids === "all"` flips every cached row, for a clear.
 */
export function useSetStars(poolId: string) {
  const qc = useQueryClient();
  const toastError = useErrorToast();

  const patch = (ids: ReadonlySet<string> | "all", starred: boolean) =>
    qc.setQueriesData<InfiniteData<QuestionPage>>({ queryKey: poolQuestionListsKey(poolId) }, (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((row) =>
                (ids === "all" || ids.has(row.id)) && row.starred !== starred
                  ? { ...row, starred }
                  : row,
              ),
            })),
          }
        : data,
    );

  const setStars = async (questionIds: string[], starred: boolean): Promise<boolean> => {
    if (questionIds.length === 0) return true;
    const lists = poolQuestionListsKey(poolId);
    // A page landing mid-flight would overwrite the patch with the old flag.
    await qc.cancelQueries({ queryKey: lists });
    const before = qc.getQueriesData<InfiniteData<QuestionPage>>({ queryKey: lists });
    patch(new Set(questionIds), starred);
    const body: QuestionStarBody = { questionIds };
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
      void qc.invalidateQueries({ queryKey: poolStarredKey(poolId) });
    }
  };

  /** `DELETE /pools/:id/stars`; the count it answers, or null on a failure. */
  const clearAll = async (): Promise<number | null> => {
    try {
      const { cleared } = await api<StarsCleared>(`/app/api/pools/${poolId}/stars`, {
        method: "DELETE",
      });
      patch("all", false);
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
