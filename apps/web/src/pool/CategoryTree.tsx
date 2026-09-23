import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Layers, ListTree } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { CategoryNode, PoolDetail } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useMoveQuestions, useQuestionDrop, type QuestionDrag } from "./move";
import { useSearchParam, type Route } from "../router";
import { cx, Skeleton, Tip, useTruncated } from "../ui";
import { poolKey } from "../queryKeys";

/**
 * The categories of a pool in the application SIDEBAR, under the "Question
 * pools" entry, while a pool is being read. The tree NAVIGATES and nothing
 * more: a click selects a category, and every edit — create, rename, move,
 * reorder, delete — lives on the pool's own categories page
 * (`CategoriesPage.tsx`), which the "Categories" row opens. A sidebar row that
 * also carries an overflow menu is a row with two jobs, and the menus made the
 * names shorter still.
 *
 * The selected category is the `?category=` search parameter, not a state of
 * either component: the sidebar writes it and the pool page reads it, and
 * `useSearchParam` keeps every instance on the screen in sync.
 *
 * Every row is also a DROP TARGET for questions dragged out of the pool table
 * (ADR-017): dropping on a category files the questions there, dropping on
 * "All questions" files them at the root. A `reader` seat has no drop — what
 * is not permitted is absent.
 *
 * A name cut by the ellipsis carries a `Tip` with the whole of it, on hover
 * and on keyboard focus, and only when it IS cut (DESIGN.md › Keyboard and
 * focus): "Numération et codage des entiers" does not fit in 240 px.
 */

function CategoryRow({
  node,
  selected,
  onSelect,
  onDropQuestions,
  readOnly,
}: {
  node: CategoryNode;
  selected: string | null;
  onSelect: (id: string) => void;
  /** Questions dropped on this folder (ADR-017). */
  onDropQuestions: (drag: QuestionDrag, categoryId: string) => void;
  /** A pool the caller only reads: nothing is dropped on it. */
  readOnly: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [nameRef, truncated] = useTruncated<HTMLButtonElement>();
  const active = selected === node.id;
  const drop = useQuestionDrop((drag) => onDropQuestions(drag, node.id), !readOnly);
  return (
    <li>
      {/* The `Tip` wraps the ROW: React's `onFocus` bubbles, so the name
          reads the same on hover and on Tab. */}
      <Tip label={truncated ? node.name : null} className="block">
        <div
          {...drop.handlers}
          className={cx(
            "group flex items-center gap-1 rounded-field pr-1 transition-colors",
            active ? "bg-accent-soft" : "hover:bg-surface-2",
            drop.over && "outline-2 outline-offset-[-2px] outline-accent",
          )}
        >
          {node.children.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              // Its own name: the row beside it already carries the category's,
              // and two buttons with one name is a list a reader cannot walk.
              aria-label={t("pool.toggleCategory", { name: node.name })}
              onClick={() => setOpen((v) => !v)}
              className="shrink-0 rounded-full p-1 text-fg-faint hover:text-fg"
            >
              <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} />
            </button>
          ) : (
            <span className="size-5.5 shrink-0" />
          )}
          <button
            ref={nameRef}
            type="button"
            onClick={() => onSelect(node.id)}
            aria-current={active ? "true" : undefined}
            className={cx(
              "min-w-0 flex-1 truncate py-1.5 text-left text-[13px]",
              active ? "font-semibold text-accent" : "text-fg-muted group-hover:text-fg",
            )}
          >
            {node.name}
          </button>
        </div>
      </Tip>
      {open && node.children.length > 0 ? (
        <ul className="ml-4 border-l border-line pl-1.5">
          {node.children.map((child) => (
            <CategoryRow
              key={child.id}
              node={child}
              selected={selected}
              onSelect={onSelect}
              onDropQuestions={onDropQuestions}
              readOnly={readOnly}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** One plain navigation row of the pool's list: "All questions", "Categories". */
function PoolLinkRow({
  icon: Icon,
  label,
  current,
  onClick,
  drop,
}: {
  icon: typeof Layers;
  label: string;
  current: boolean;
  onClick: () => void;
  drop?: ReturnType<typeof useQuestionDrop>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "true" : undefined}
      {...drop?.handlers}
      className={cx(
        "flex w-full items-center gap-2 rounded-field px-2.5 py-1.5 text-left text-[13px] transition-colors",
        current
          ? "bg-accent-soft font-semibold text-accent"
          : "text-fg-muted hover:bg-surface-2 hover:text-fg",
        drop?.over && "outline-2 outline-offset-[-2px] outline-accent",
      )}
    >
      <Icon className="size-4 shrink-0 text-fg-faint" />
      {label}
    </button>
  );
}

/**
 * The pool being read, at the head of its own tree. It names where the reader
 * is and is not a target, so it carries the WEIGHT of the current page
 * without its accent: the one `accent-soft` chip of this column belongs to
 * the selected category, or the whole list reads as two selections at once.
 */
function SidebarPool({ label }: { label: ReactNode }) {
  return (
    <div
      aria-current="page"
      className="flex w-full items-center gap-2 rounded-field px-2.5 py-1.5 text-[13px] font-semibold text-fg"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}

/**
 * The tree inside the application sidebar, under "Question pools", while a
 * pool is being read — its question list or its categories page. It reads
 * the pool on the SAME query key the pool page uses, so react-query serves
 * both from one request, and it writes the selection to `?category=`, which
 * is what the page reads back.
 *
 * On the categories page nothing of the tree is selected (that page shows
 * every category), and picking one goes back to the question list, filtered.
 */
export function SidebarCategories({
  poolId,
  route,
  navigate,
  heading = true,
}: {
  poolId: string;
  route: Route;
  navigate: (r: Route) => void;
  /**
   * The pool's own name above its folders. The "all pools" list already draws
   * that row itself (PoolNav.tsx), and two lines with the same name is a list
   * a reader has to parse twice.
   */
  heading?: boolean;
}) {
  const t = useT();
  const [category, setCategory] = useSearchParam("category", "");
  const move = useMoveQuestions();
  const detail = useQuery<PoolDetail>({
    queryKey: poolKey(poolId),
    queryFn: () => api(`/app/api/pools/${poolId}`),
  });
  const onCategoriesPage = route.view === "poolCategories";
  const readOnly = detail.data?.role === "reader";
  const onDropQuestions = (drag: QuestionDrag, categoryId: string | null) =>
    void move({
      questionIds: drag.questionIds,
      targetPoolId: poolId,
      targetPoolName: detail.data!.pool.name,
      categoryId,
      label: drag.label,
    });
  /** "All questions" is the pool's ROOT as a drop target (ADR-017). */
  const rootDrop = useQuestionDrop((drag) => onDropQuestions(drag, null), !readOnly);
  // From the categories page, a pick goes back to the question list first:
  // `navigate` drops the query string, and the category is written after it.
  const select = (id: string | null) => {
    if (onCategoriesPage) navigate({ view: "pool", id: poolId });
    setCategory(id ?? "");
  };
  // `undefined`: nothing is selected, not even "All questions".
  const selected = onCategoriesPage ? undefined : category === "" ? null : category;

  return (
    <div className="ml-3 space-y-0.5 border-l border-line pl-1.5">
      {heading ? (
        <SidebarPool
          label={detail.data ? detail.data.pool.name : <Skeleton className="h-4 w-24" />}
        />
      ) : null}
      {detail.isLoading ? (
        <div className="space-y-1 px-2.5 py-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
        </div>
      ) : detail.isError || !detail.data ? (
        <p className="px-2.5 py-1.5 text-[13px] text-fg-muted">{t("pools.notFound")}</p>
      ) : (
        <ul className="space-y-0.5">
          <li>
            <PoolLinkRow
              icon={Layers}
              label={t("pool.allQuestions")}
              current={selected === null}
              onClick={() => select(null)}
              drop={rootDrop}
            />
          </li>
          <li>
            <PoolLinkRow
              icon={ListTree}
              label={t("pool.categories")}
              current={onCategoriesPage}
              onClick={() => navigate({ view: "poolCategories", id: poolId })}
            />
          </li>
          {detail.data.categories.map((node) => (
            <CategoryRow
              key={node.id}
              node={node}
              selected={selected ?? null}
              onSelect={select}
              onDropQuestions={onDropQuestions}
              readOnly={readOnly}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
