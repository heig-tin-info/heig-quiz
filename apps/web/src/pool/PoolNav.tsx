import { useQuery } from "@tanstack/react-query";

import type { PoolSummary } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import type { Route } from "../router";
import { cx, Skeleton, usePersistentChoice } from "../ui";
import { SidebarCategories } from "./CategoryTree";
import { useMoveQuestions, useQuestionDrop, type QuestionDrag } from "./move";
import { PoolIcon } from "./PoolIcon";
import { poolsKey } from "../queryKeys";

/**
 * The "Question pools" section of the application sidebar, and the three
 * states its navigation row cycles through (asked for by the product owner):
 *
 *   collapsed → the row alone, whatever page is open;
 *   active    → the pool being read, with its categories (what the sidebar
 *               always did);
 *   all       → every pool the teacher can reach, the one being read expanded.
 *
 * "All" exists for ONE gesture: dragging a question onto another pool moves it
 * there (ADR-017), and a target you cannot see is not a target. It is also the
 * shortest way between two pools, which is otherwise a trip through /pools.
 *
 * The cycle is a viewer's HABIT, so it is remembered in `localStorage` like
 * the pool page's table/cards choice, and never in the URL or on the server.
 *
 * Navigation and disclosure share the row without fighting over it: from
 * anywhere else the click NAVIGATES to the pools (and opens the section if it
 * was collapsed), and only a click made while already inside the pool section
 * cycles. A teacher reading a question therefore never loses it by folding the
 * tree, and nobody has to hunt for a second control to see their pools.
 */

export type PoolNavState = "collapsed" | "active" | "all";

const NAV_KEY = "quiz-pools-nav";
const ORDER: PoolNavState[] = ["collapsed", "active", "all"];

export function usePoolNavState(): {
  state: PoolNavState;
  /** Next state in the cycle. */
  cycle: () => void;
  open: () => void;
} {
  const [state, write] = usePersistentChoice(NAV_KEY, ORDER, "active");
  return {
    state,
    cycle: () => write(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]!),
    open: () => {
      if (state === "collapsed") write("active");
    },
  };
}

/** True while the reader is inside the pool section, whichever of its pages. */
export function inPoolSection(route: Route): boolean {
  return route.view === "pools" || route.view === "pool" || route.view === "question";
}

/**
 * One pool in the "all" list: a row that navigates, and a drop target that
 * moves the dragged questions into that pool's root. A pool the caller only
 * READS accepts nothing — the server would refuse it anyway, and an
 * affordance that lights up for a refusal is a lie.
 */
function PoolRow({
  pool,
  active,
  onOpen,
}: {
  pool: PoolSummary;
  active: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const move = useMoveQuestions();
  const onDrop = (drag: QuestionDrag) =>
    void move({
      questionIds: drag.questionIds,
      targetPoolId: pool.id,
      targetPoolName: pool.name,
      categoryId: null,
      label: drag.label,
    });
  const drop = useQuestionDrop(onDrop, pool.role !== "reader");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      // The drop target says what it is to a reader too: the row's accessible
      // name carries the pool it would move the questions into.
      aria-label={drop.over ? t("pool.move.dropInto", { pool: pool.name }) : undefined}
      {...drop.handlers}
      className={cx(
        "flex w-full items-center gap-2 rounded-field px-2.5 py-1.5 text-left text-[13px] transition-colors",
        active ? "font-semibold text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
        drop.over && "bg-accent-soft text-accent outline-2 outline-offset-[-2px] outline-accent",
      )}
    >
      <PoolIcon icon={pool.icon} className="size-4 shrink-0 text-fg-faint" />
      <span className="min-w-0 flex-1 truncate">{pool.name}</span>
      <span className="shrink-0 tabular-nums text-[11px] text-fg-faint">
        {pool.questionCount}
      </span>
    </button>
  );
}

/**
 * What hangs under the "Question pools" row. `collapsed` draws nothing at all,
 * which is also what a student or a signed-out frame gets, since the row
 * itself only exists in the teacher UI.
 */
export function PoolNavTree({
  state,
  route,
  navigate,
}: {
  state: PoolNavState;
  route: Route;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const currentPool = route.view === "pool" ? route.id : null;
  // The same key the pool screens and the palette use: react-query serves all
  // three from one request.
  const pools = useQuery<PoolSummary[]>({
    queryKey: poolsKey,
    queryFn: () => api("/app/api/pools"),
    enabled: state === "all",
  });

  if (state === "collapsed") return null;
  if (state === "active") {
    return currentPool ? <SidebarCategories poolId={currentPool} /> : null;
  }

  return (
    <div className="ml-3 space-y-0.5 border-l border-line pl-1.5">
      {pools.isLoading ? (
        <div className="space-y-1 px-2.5 py-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
        </div>
      ) : pools.isError ? (
        <p className="px-2.5 py-1.5 text-[13px] text-fg-muted">{t("error.server")}</p>
      ) : (pools.data ?? []).length === 0 ? (
        <p className="px-2.5 py-1.5 text-[13px] text-fg-muted">{t("pools.empty.title")}</p>
      ) : (
        <ul className="space-y-0.5">
          {(pools.data ?? []).map((pool) => (
            <li key={pool.id}>
              <PoolRow
                pool={pool}
                active={pool.id === currentPool}
                onOpen={() => navigate({ view: "pool", id: pool.id })}
              />
              {/* The pool being read keeps its folders: "all pools" widens the
                  list, it does not take the current tree away. */}
              {pool.id === currentPool ? (
                <SidebarCategories poolId={pool.id} heading={false} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
