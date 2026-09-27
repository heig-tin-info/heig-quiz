import type { ReactNode } from "react";

import { useT } from "./i18n";
import { Skeleton, usePersistentChoice } from "./ui";

/**
 * What the disclosing rows of the sidebar share — "Question pools"
 * (pool/PoolNav.tsx, pool/CategoryTree.tsx) and "Courses" (CourseNav.tsx) —
 * so a teacher who knows one knows the other: the three-state cycle of the
 * row, the frame of the tree under it, and the class of its rows.
 */

// --- The cycle of the row ---

/**
 *   collapsed → the row alone, whatever page is open;
 *   active    → the thing being read (a pool, a course), unfolded;
 *   all       → every one the teacher can reach, the one being read unfolded.
 *
 * The cycle is a viewer's HABIT: remembered in `localStorage` under `key`,
 * never in the URL or on the server.
 */
export type NavCycleState = "collapsed" | "active" | "all";

const ORDER: readonly NavCycleState[] = ["collapsed", "active", "all"];

export interface NavCycle {
  state: NavCycleState;
  /**
   * The row's click. Navigation and disclosure share it without fighting:
   * from INSIDE the section it cycles, so a reader cannot lose the page they
   * are on by folding the tree; from anywhere else it opens the row (when it
   * was collapsed) and calls `arrive`, so nobody needs a second control to
   * reach the section.
   */
  press: (inside: boolean, arrive: () => void) => void;
}

export function useNavCycle(key: string): NavCycle {
  const [state, write] = usePersistentChoice(key, ORDER, "active");
  return {
    state,
    press: (inside, arrive) => {
      if (inside) write(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]!);
      else {
        if (state === "collapsed") write("active");
        arrive();
      }
    },
  };
}

// --- The tree under the row ---

/** One row of a sidebar tree: a pool, a category link, a course, a classroom. */
export const navRowClass =
  "flex w-full items-center gap-2 rounded-field px-2.5 py-1.5 text-left text-[13px] transition-colors";

/**
 * The frame of a tree under a sidebar row: the indented hairline, then the
 * query's loading, error and empty states, then `children(data)`. `heading`
 * sits above all of it (the pool's own name over its folders); `error`
 * replaces the generic server message; `empty` is said when the data is an
 * empty list.
 */
export function NavTree<T>({
  query,
  heading,
  error,
  empty,
  children,
}: {
  query: { isLoading: boolean; isError: boolean; data: T | undefined };
  heading?: ReactNode;
  error?: string;
  empty?: string;
  children: (data: T) => ReactNode;
}) {
  const t = useT();
  const { data } = query;
  const note = (text: string) => <p className="px-2.5 py-1.5 text-[13px] text-fg-muted">{text}</p>;
  return (
    <div className="ml-3 space-y-0.5 border-l border-line pl-1.5">
      {heading}
      {query.isLoading ? (
        <div className="space-y-1 px-2.5 py-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
        </div>
      ) : query.isError || data === undefined ? (
        note(error ?? t("error.server"))
      ) : empty !== undefined && Array.isArray(data) && data.length === 0 ? (
        note(empty)
      ) : (
        children(data)
      )}
    </div>
  );
}
