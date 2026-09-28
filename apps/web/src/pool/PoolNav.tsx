import { useQuery } from "@tanstack/react-query";

import type { PoolSummary } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { sectionOf, type Route } from "../router";
import { NavTree, navRowClass, useNavCycle, type NavCycle } from "../navTree";
import { cx } from "../ui";
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
 * The cycle, its memory and the navigate-vs-cycle click are `useNavCycle`
 * (navTree.tsx), shared with the "Courses" row: from anywhere else the click
 * NAVIGATES to the pools (and opens the section if it was collapsed), and only
 * a click made while already inside the pool section cycles. A teacher
 * reading a question therefore never loses it by folding the tree.
 */

export function usePoolNavState(): NavCycle {
  return useNavCycle("quiz-pools-nav");
}

/** True while the reader is inside the pool section, whichever of its pages. */
export function inPoolSection(route: Route): boolean {
  return sectionOf(route) === "pools";
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
        navRowClass,
        active ? "font-semibold text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
        drop.over && "bg-accent-soft text-accent outline-2 outline-offset-[-2px] outline-accent",
      )}
    >
      <PoolIcon icon={pool.icon} color={pool.color} className="size-4 shrink-0 text-fg-faint" />
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
  state: NavCycle["state"];
  route: Route;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const currentPool = route.view === "pool" || route.view === "poolCategories" ? route.id : null;
  // The same key the pool screens and the palette use: react-query serves all
  // three from one request.
  const pools = useQuery<PoolSummary[]>({
    queryKey: poolsKey,
    queryFn: () => api("/app/api/pools"),
    enabled: state === "all",
  });

  if (state === "collapsed") return null;
  if (state === "active") {
    return currentPool ? (
      <SidebarCategories poolId={currentPool} route={route} navigate={navigate} />
    ) : null;
  }

  return (
    <NavTree query={pools} empty={t("pools.empty.title")}>
      {(list) => (
        <ul className="space-y-0.5">
          {list.map((pool) => (
            <li key={pool.id}>
              <PoolRow
                pool={pool}
                active={pool.id === currentPool}
                onOpen={() => navigate({ view: "pool", id: pool.id })}
              />
              {/* The pool being read keeps its folders: "all pools" widens the
                  list, it does not take the current tree away. */}
              {pool.id === currentPool ? (
                <SidebarCategories
                  poolId={pool.id}
                  route={route}
                  navigate={navigate}
                  heading={false}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </NavTree>
  );
}
