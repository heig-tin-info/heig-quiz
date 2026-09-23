import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderPlus, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { CategoryNode, PoolDetail } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { findCategory } from "./categories";
import { useMoveQuestions, useQuestionDrop, type QuestionDrag } from "./move";
import { useErrorToast } from "../notify";
import { useSearchParam } from "../router";
import { Button, cx, Field, Menu, Modal, Skeleton } from "../ui";
import { poolKey } from "../queryKeys";

/**
 * The categories of a pool. They live in the application SIDEBAR, under the
 * "Question pools" entry, while a pool is being read: a folder tree that
 * selects, creates, renames, reorders and deletes, and nothing more — the
 * questions themselves live in the table of the pool screen.
 *
 * Selection is the ONE thing a click does; every edit sits in the row's
 * overflow menu, because three icon buttons per row would make the tree read
 * as a toolbar (DESIGN.md › action tiers).
 *
 * The selected category is the `?category=` search parameter, not a state of
 * either component: the sidebar writes it and the pool page reads it, and
 * `useSearchParam` keeps every instance on the screen in sync.
 *
 * Every row is also a DROP TARGET for questions dragged out of the pool table
 * (ADR-017): dropping on a category files the questions there, dropping on
 * "All questions" files them at the root. A `reader` seat has no drop, for the
 * same reason it has no menu — what is not permitted is absent.
 */

/** Flattens the sibling list of a node, for a move that renumbers positions. */
function siblingsOf(tree: CategoryNode[], parentId: string | null): CategoryNode[] {
  if (parentId === null) return tree;
  return findCategory(tree, parentId)?.children ?? [];
}

function CategoryRow({
  node,
  depth,
  selected,
  onSelect,
  onCreateChild,
  onRename,
  onDelete,
  onMove,
  onDropQuestions,
  siblings,
  readOnly,
}: {
  node: CategoryNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onCreateChild: (parent: CategoryNode) => void;
  onRename: (node: CategoryNode) => void;
  onDelete: (node: CategoryNode) => void;
  onMove: (node: CategoryNode, direction: -1 | 1) => void;
  /** Questions dropped on this folder (ADR-017). */
  onDropQuestions: (drag: QuestionDrag, categoryId: string) => void;
  siblings: CategoryNode[];
  /** A pool the caller only reads: the tree selects and edits nothing. */
  readOnly: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const active = selected === node.id;
  const index = siblings.findIndex((s) => s.id === node.id);
  const drop = useQuestionDrop((drag) => onDropQuestions(drag, node.id), !readOnly);
  return (
    <li>
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
        {readOnly ? null : (
        <Menu
          label={t("common.actions")}
          items={[
            { label: t("pool.renameCategory"), icon: Pencil, onSelect: () => onRename(node) },
            {
              label: t("pool.newSubcategory"),
              icon: FolderPlus,
              onSelect: () => onCreateChild(node),
            },
            {
              label: t("pool.moveUp"),
              icon: ChevronRight,
              disabled: index <= 0,
              onSelect: () => onMove(node, -1),
            },
            {
              label: t("pool.moveDown"),
              icon: ChevronRight,
              disabled: index < 0 || index >= siblings.length - 1,
              onSelect: () => onMove(node, 1),
            },
            {
              label: t("pool.deleteCategory"),
              icon: Trash2,
              danger: true,
              separator: true,
              onSelect: () => onDelete(node),
            },
          ]}
        />
        )}
      </div>
      {open && node.children.length > 0 ? (
        <ul className="ml-4 border-l border-line pl-1.5">
          {node.children.map((child) => (
            <CategoryRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              onDropQuestions={onDropQuestions}
              siblings={node.children}
              readOnly={readOnly}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The list itself: the "all questions" row, the tree, the "new category" row
 * and the one dialog that creates and renames. Every mutation lives here, so
 * the sidebar and any other surface that shows the tree share one copy of the
 * rules rather than two that can disagree.
 */
function CategoryList({
  poolId,
  categories,
  selected,
  onSelect,
  onDropQuestions,
  readOnly,
}: {
  poolId: string;
  categories: CategoryNode[];
  /** `null` is "all questions". */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Questions dropped on a folder, or on "All questions" (`null`). */
  onDropQuestions: (drag: QuestionDrag, categoryId: string | null) => void;
  /**
   * A `reader` seat on the pool (F-POOL-05): the tree still NAVIGATES — that
   * is what a reader came for — and offers no way to change it. Nothing is
   * drawn disabled; what is not permitted is absent.
   */
  readOnly: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<
    { mode: "create"; parentId: string | null } | { mode: "rename"; node: CategoryNode } | null
  >(null);
  const [name, setName] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: poolKey(poolId) });
  const fail = toastError("pool.categoryFailed");

  const create = useMutation({
    mutationFn: (body: { name: string; parentId: string | null }) =>
      api(`/app/api/pools/${poolId}/categories`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setForm(null);
      await invalidate();
    },
    onError: fail,
  });
  const rename = useMutation({
    mutationFn: (args: { id: string; name: string }) =>
      api(`/app/api/categories/${args.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: args.name }),
      }),
    onSuccess: async () => {
      setForm(null);
      await invalidate();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/app/api/categories/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: fail,
  });
  /** One call for the whole sibling list: positions are renumbered together. */
  const reorder = useMutation({
    mutationFn: (items: { id: string; parentId: string | null; position: number }[]) =>
      api(`/app/api/pools/${poolId}/categories/order`, {
        method: "PUT",
        body: JSON.stringify({ items }),
      }),
    onSuccess: invalidate,
    onError: fail,
  });

  const move = (node: CategoryNode, direction: -1 | 1) => {
    const siblings = siblingsOf(categories, node.parentId);
    const from = siblings.findIndex((s) => s.id === node.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    const next = [...siblings];
    next.splice(to, 0, ...next.splice(from, 1));
    reorder.mutate(next.map((s, i) => ({ id: s.id, parentId: s.parentId, position: i })));
  };

  const askDelete = async (node: CategoryNode) => {
    const ok = await confirm({
      title: t("pool.deleteCategory"),
      message: t("pool.deleteCategoryConfirm", { name: node.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (ok) remove.mutate(node.id);
  };

  const openCreate = (parentId: string | null) => {
    setName("");
    setForm({ mode: "create", parentId });
  };

  /** "All questions" is the pool's ROOT as a drop target (ADR-017). */
  const rootDrop = useQuestionDrop((drag) => onDropQuestions(drag, null), !readOnly);

  return (
    <>
      <ul className="space-y-0.5">
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-current={selected === null ? "true" : undefined}
            {...rootDrop.handlers}
            className={cx(
              "flex w-full items-center gap-2 rounded-field px-2.5 py-1.5 text-left text-[13px] transition-colors",
              selected === null
                ? "bg-accent-soft font-semibold text-accent"
                : "text-fg-muted hover:bg-surface-2 hover:text-fg",
              rootDrop.over && "outline-2 outline-offset-[-2px] outline-accent",
            )}
          >
            <Layers className="size-4 shrink-0 text-fg-faint" />
            {t("pool.allQuestions")}
          </button>
        </li>
        {categories.map((node) => (
          <CategoryRow
            key={node.id}
            node={node}
            depth={0}
            selected={selected}
            onSelect={onSelect}
            onCreateChild={(parent) => openCreate(parent.id)}
            onRename={(n) => {
              setName(n.name);
              setForm({ mode: "rename", node: n });
            }}
            onDelete={askDelete}
            onMove={move}
            onDropQuestions={onDropQuestions}
            siblings={categories}
            readOnly={readOnly}
          />
        ))}
      </ul>
      {readOnly ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-start"
          onClick={() => openCreate(null)}
        >
          <Plus /> {t("pool.newCategory")}
        </Button>
      )}

      {form ? (
        <Modal
          title={form.mode === "create" ? t("pool.newCategory") : t("pool.renameCategory")}
          onClose={() => setForm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setForm(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                loading={create.isPending || rename.isPending}
                disabled={name.trim() === ""}
                onClick={() =>
                  form.mode === "create"
                    ? create.mutate({ name: name.trim(), parentId: form.parentId })
                    : rename.mutate({ id: form.node.id, name: name.trim() })
                }
              >
                {form.mode === "create" ? t("common.create") : t("common.save")}
              </Button>
            </>
          }
        >
          <Field
            label={t("pool.categoryName")}
            fullWidth
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Modal>
      ) : null}
    </>
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
 * pool is being read. It reads the pool on the SAME query key the pool page
 * uses, so react-query serves both from one request, and it writes the
 * selection to `?category=`, which is what the page reads back.
 */
export function SidebarCategories({
  poolId,
  heading = true,
}: {
  poolId: string;
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
        <CategoryList
          poolId={poolId}
          categories={detail.data.categories}
          selected={category === "" ? null : category}
          onSelect={(id) => setCategory(id ?? "")}
          onDropQuestions={(drag, categoryId) =>
            void move({
              questionIds: drag.questionIds,
              targetPoolId: poolId,
              targetPoolName: detail.data!.pool.name,
              categoryId,
              label: drag.label,
            })
          }
          readOnly={detail.data.role === "reader"}
        />
      )}
    </div>
  );
}
