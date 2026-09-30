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
 *   active → the thing being read (a pool, a course), unfolded — nothing on
 *            the section's own list page, where there is no ONE thing;
 *   all    → every one the teacher can reach, the one being read unfolded.
 *
 * The state is a viewer's HABIT: remembered in `localStorage` under `key`,
 * never in the URL or on the server. (A third state, "collapsed", was dropped:
 * it can only be chosen on the list page, where it looks exactly like
 * "active". A stored "collapsed" reads as "active".)
 */
export type NavCycleState = "active" | "all";

const ORDER: readonly NavCycleState[] = ["active", "all"];

export interface NavCycle {
  state: NavCycleState;
  /**
   * The row's click. Like every other row of the sidebar it takes the reader
   * to the section — its list page — from wherever they are, deep inside the
   * section included. Only a click made ON that list page, where there is
   * nowhere left to go, toggles the state.
   */
  press: (onListPage: boolean, arrive: () => void) => void;
}

export function useNavCycle(key: string): NavCycle {
  const [state, write] = usePersistentChoice(key, ORDER, "active");
  return {
    state,
    press: (onListPage, arrive) => {
      if (onListPage) write(state === "all" ? "active" : "all");
      else arrive();
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
