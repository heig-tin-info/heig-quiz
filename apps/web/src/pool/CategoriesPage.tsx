import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, ListTree, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CategoryCountNode, PoolCategories, PoolDetail } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { PageError, QueryError } from "../queryError";
import { poolCategoriesKey, poolKey } from "../queryKeys";
import { useSearchParam, type Route } from "../router";
import { Trail, useRootCrumb } from "../Trail";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  PageHeader,
  PageSkeleton,
  Skeleton,
} from "../ui";
import {
  applyOrder,
  dropTarget,
  findCategory,
  moveFolder,
  type DropWhere,
  type FolderTarget,
  type OrderItem,
} from "./categories";
import { MoveCategoryDialog, NewCategoryDialog } from "./CategoryDialogs";
import { CategoryRow, hoverDrop, type RowProps } from "./CategoryRow";

/**
 * The categories of ONE pool, as a page of its own (`/pools/:id/categories`):
 * the tree, each folder with the number of questions filed in it, and every
 * edit the sidebar used to hide in a per-row menu — create, rename in place,
 * reorder, move under another folder, delete.
 *
 * The one primary action is "New category". Everything that acts on ONE
 * folder sits on its row (`CategoryRow`): the name renames where it stands
 * (click, Enter or F2), the count opens the question list filtered on it,
 * and the rest is the row's menu. Moving is a drag for a pointer — onto a
 * folder files it inside, between two reorders — and Alt+arrows for a
 * keyboard, which the menu repeats with words.
 *
 * Every move sends the sibling lists it touches, renumbered, through the one
 * `PUT /pools/:id/categories/order`; the tree is redrawn at once (optimistic)
 * and the refetch that follows agrees with it.
 */

function countOf(nodes: readonly CategoryCountNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countOf(node.children), 0);
}

function questionsIn(node: CategoryCountNode): number {
  return node.children.reduce((n, child) => n + questionsIn(child), node.questionCount);
}

type Dialog =
  | { kind: "create"; parentId: string | null }
  | { kind: "move"; node: CategoryCountNode }
  | null;

/**
 * The writes of the page: create, rename, delete, and the optimistic
 * reorder every move goes through. `refocus` is the folder whose name takes
 * the focus back once the tree is redrawn — after a move or a rename.
 */
function useCategoryEdits(poolId: string, onCreated: () => void) {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const key = poolCategoriesKey(poolId);
  const refocus = useRef<string | null>(null);

  // Prefix: the sidebar's tree, the question lists and this page all hang
  // off the pool's key.
  const invalidate = () => qc.invalidateQueries({ queryKey: poolKey(poolId) });
  const fail = toastError("pool.categoryFailed");

  const reorder = useMutation({
    mutationFn: (items: OrderItem[]) =>
      api(`/app/api/pools/${poolId}/categories/order`, {
        method: "PUT",
        body: JSON.stringify({ items }),
      }),
    onMutate: async (items) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<PoolCategories>(key);
      if (before) {
        qc.setQueryData<PoolCategories>(key, {
          ...before,
          categories: applyOrder(before.categories, items),
        });
      }
      return { before };
    },
    onError: (error, _items, context) => {
      if (context?.before) qc.setQueryData(key, context.before);
      fail(error);
    },
    onSettled: invalidate,
  });
  const create = useMutation({
    mutationFn: (body: { name: string; parentId: string | null }) =>
      api(`/app/api/pools/${poolId}/categories`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      onCreated();
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
    onSuccess: invalidate,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (categoryId: string) =>
      api(`/app/api/categories/${categoryId}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: fail,
  });

  useEffect(() => {
    if (!refocus.current) return;
    const target = document.querySelector<HTMLElement>(
      `[data-category-name="${refocus.current}"]`,
    );
    if (target) {
      target.focus();
      refocus.current = null;
    }
  });

  const move = (tree: CategoryCountNode[], categoryId: string, target: FolderTarget | null) => {
    if (!target) return;
    const items = moveFolder(tree, categoryId, target);
    if (!items) return;
    refocus.current = categoryId;
    reorder.mutate(items);
  };

  return { create, rename, remove, move, refocus };
}

export function CategoriesPage({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const confirm = useConfirm();
  const [, setCategory] = useSearchParam("category", "");
  const [editing, setEditingState] = useState<string | null>(null);
  // Enter saves and unmounts the input, whose blur then saves again: the ref
  // lets the first of the two through and nothing after it.
  const editingRef = useRef<string | null>(null);
  const setEditing = (next: string | null) => {
    editingRef.current = next;
    setEditingState(next);
  };
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; where: DropWhere } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const poolsRoot = useRootCrumb("pools");
  const pool = useQuery<PoolDetail>({
    queryKey: poolKey(id),
    queryFn: () => api(`/app/api/pools/${id}`),
  });
  const data = useQuery<PoolCategories>({
    queryKey: poolCategoriesKey(id),
    queryFn: () => api(`/app/api/pools/${id}/categories`),
  });
  const tree = data.data?.categories ?? [];
  const edits = useCategoryEdits(id, () => setDialog(null));
  const move = (categoryId: string, target: FolderTarget | null) =>
    edits.move(tree, categoryId, target);

  const onDrop = (targetId: string, where: DropWhere) => {
    const dragged = dragging;
    setDragging(null);
    setDrop(null);
    if (dragged) move(dragged, dropTarget(tree, dragged, targetId, where));
  };

  const onRename = (node: CategoryCountNode, next: string | null) => {
    if (editingRef.current !== node.id) return;
    setEditing(null);
    edits.refocus.current = node.id;
    const trimmed = next?.trim() ?? "";
    if (trimmed === "" || trimmed === node.name) return;
    edits.rename.mutate({ id: node.id, name: trimmed });
  };

  const askDelete = async (node: CategoryCountNode) => {
    const sub = countOf(node.children);
    const n = questionsIn(node);
    const ok = await confirm({
      title: t("pool.deleteCategory"),
      message:
        sub > 1
          ? t("categories.deleteConfirmTree", { name: node.name, sub, n })
          : sub === 1
            ? t("categories.deleteConfirmTree.one", { name: node.name, n })
            : t("categories.deleteConfirm", { name: node.name, n }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (ok) edits.remove.mutate(node.id);
  };

  const openCreate = (parentId: string | null) => setDialog({ kind: "create", parentId });

  if (pool.isLoading) return <PageSkeleton />;
  if (pool.isError || !pool.data) {
    return (
      <PageError
        title={t("pools.notFound")}
        error={pool.error}
        onRetry={() => void pool.refetch()}
        retrying={pool.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  const detail = pool.data;
  const readOnly = detail.role === "reader";
  const total = countOf(tree);
  const empty = data.isSuccess && tree.length === 0;
  const newCategory = (
    <Button onClick={() => openCreate(null)}>
      <Plus /> {t("pool.newCategory")}
    </Button>
  );

  const row: Omit<RowProps, "node" | "depth"> = {
    tree,
    readOnly,
    editing,
    dragging,
    drop,
    onRename,
    onStartRename: setEditing,
    onMove: move,
    onMoveTo: (n) => setDialog({ kind: "move", node: n }),
    onCreateChild: (n) => openCreate(n.id),
    onDelete: (n) => void askDelete(n),
    onShowQuestions: (n) => {
      navigate({ view: "pool", id });
      setCategory(n.id);
    },
    onDragStart: setDragging,
    onDragEnd: () => {
      setDragging(null);
      setDrop(null);
    },
    onDragOver: (targetId, where) => setDrop((d) => hoverDrop(d, targetId, where)),
    onDrop,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        help="categories"
        eyebrow={
          <Trail
            navigate={navigate}
            items={[
              poolsRoot,
              { label: detail.pool.name, route: { view: "pool", id } },
              { label: t("pool.categories") },
            ]}
          />
        }
        title={t("pool.categories")}
        description={
          data.isSuccess
            ? `${t(total === 1 ? "categories.count.one" : "categories.count", { n: total })} · ${t(
                detail.questionCount === 1 ? "pools.questions.one" : "pools.questions",
                { n: detail.questionCount },
              )}`
            : null
        }
        actions={
          readOnly ? (
            <Badge tone="zinc" icon={Eye}>
              {t("pool.readOnly")}
            </Badge>
          ) : empty ? null : (
            newCategory
          )
        }
      />

      {data.isLoading ? (
        <Card className="space-y-3 p-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="ml-6 h-5 w-40" />
          <Skeleton className="h-5 w-56" />
        </Card>
      ) : data.isError ? (
        <QueryError
          title={t("pool.categories")}
          error={data.error}
          onRetry={() => void data.refetch()}
          retrying={data.isFetching}
          fallback={t("error.server")}
        />
      ) : empty ? (
        <Card>
          <EmptyState
            icon={ListTree}
            title={t("categories.empty.title")}
            action={readOnly ? null : newCategory}
          >
            {t("categories.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-fg-faint">
              <span>{t("pool.categoryName")}</span>
              <span className={readOnly ? "px-2" : "pr-11"}>{t("pools.questionsColumn")}</span>
            </div>
            <ul
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDrop(null);
                }
              }}
            >
              {tree.map((node) => (
                <CategoryRow key={node.id} {...row} node={node} depth={0} />
              ))}
            </ul>
            <div className="flex min-h-11 items-center gap-2 border-t border-line bg-surface-2/50 pl-3 pr-2 text-sm text-fg-muted">
              <span className="min-w-0 flex-1 truncate">{t("categories.uncategorized")}</span>
              <span className={cx("shrink-0 px-2 text-[13px] tabular-nums", !readOnly && "mr-9")}>
                {data.data!.rootQuestionCount}
              </span>
            </div>
          </Card>
          {readOnly ? null : <p className="text-[13px] text-fg-muted">{t("categories.hint")}</p>}
        </div>
      )}

      {dialog?.kind === "create" ? (
        <NewCategoryDialog
          sub={dialog.parentId !== null}
          submitting={edits.create.isPending}
          onCreate={(name) => edits.create.mutate({ name, parentId: dialog.parentId })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "move" ? (
        <MoveCategoryDialog
          node={dialog.node}
          tree={tree}
          onMove={(parentId) => {
            const siblings = parentId ? (findCategory(tree, parentId)?.children ?? []) : tree;
            move(dialog.node.id, { parentId, index: siblings.length });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
