import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  CornerLeftUp,
  Eye,
  Folder,
  FolderInput,
  FolderPlus,
  ListTree,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

import type { CategoryCountNode, PoolCategories, PoolDetail } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { PageError, QueryError } from "../queryError";
import { poolCategoriesKey, poolKey } from "../queryKeys";
import { useSearchParam, type Route } from "../router";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  FormDialog,
  inputClass,
  inputSize,
  Menu,
  PageHeader,
  PageSkeleton,
  ParentLink,
  Select,
  Skeleton,
  type MenuItem,
} from "../ui";
import {
  applyOrder,
  categoryPaths,
  findCategory,
  moveFolder,
  neighbourMoves,
  subtreeIds,
  type FolderTarget,
  type OrderItem,
} from "./categories";

/**
 * The categories of ONE pool, as a page of its own (`/pools/:id/categories`):
 * the tree, each folder with the number of questions filed in it, and every
 * edit the sidebar used to hide in a per-row menu — create, rename in place,
 * reorder, move under another folder, delete.
 *
 * The one primary action is "New category". Everything that acts on ONE
 * folder sits on its row: the name renames where it stands (click, Enter or
 * F2), the count opens the question list filtered on it, and the rest is the
 * row's menu. Moving is a drag for a pointer — onto a folder files it inside,
 * between two reorders — and Alt+arrows for a keyboard, which the menu
 * repeats with words.
 *
 * Every move sends the sibling lists it touches, renumbered, through the one
 * `PUT /pools/:id/categories/order`; the tree is redrawn at once (optimistic)
 * and the refetch that follows agrees with it.
 */

const DRAG_TYPE = "application/x-quiz-category";

type DropWhere = "before" | "inside" | "after";

/** Upper quarter: before; lower quarter: after; the middle: inside. */
function dropWhere(event: DragEvent<HTMLElement>): DropWhere {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = (event.clientY - rect.top) / Math.max(rect.height, 1);
  return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
}

function countOf(nodes: readonly CategoryCountNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countOf(node.children), 0);
}

function questionsIn(node: CategoryCountNode): number {
  return node.children.reduce((n, child) => n + questionsIn(child), node.questionCount);
}

interface RowProps {
  node: CategoryCountNode;
  depth: number;
  tree: CategoryCountNode[];
  readOnly: boolean;
  editing: string | null;
  dragging: string | null;
  drop: { id: string; where: DropWhere } | null;
  onRename: (node: CategoryCountNode, name: string | null) => void;
  onStartRename: (id: string) => void;
  onMove: (id: string, target: FolderTarget | null) => void;
  onMoveTo: (node: CategoryCountNode) => void;
  onCreateChild: (node: CategoryCountNode) => void;
  onDelete: (node: CategoryCountNode) => void;
  onShowQuestions: (node: CategoryCountNode) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOver: (id: string, where: DropWhere | null) => void;
  onDrop: (id: string, where: DropWhere) => void;
}

function CategoryRow(props: RowProps) {
  const { node, depth, tree, readOnly, editing, dragging, drop } = props;
  const t = useT();
  const moves = neighbourMoves(tree, node.id);
  const parent = node.parentId ? findCategory(tree, node.parentId) : null;
  const siblings = parent ? parent.children : tree;
  const previous = siblings[siblings.findIndex((s) => s.id === node.id) - 1];
  const isEditing = editing === node.id;
  const here = drop?.id === node.id ? drop.where : null;
  // A folder cannot be dropped into itself or its own subtree.
  const refuses = dragging !== null && subtreeIds(tree, dragging).has(node.id);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (readOnly) return;
    if (event.key === "F2") {
      event.preventDefault();
      props.onStartRename(node.id);
      return;
    }
    if (!event.altKey) return;
    const key = {
      ArrowUp: moves.up,
      ArrowDown: moves.down,
      ArrowRight: moves.indent,
      ArrowLeft: moves.outdent,
    }[event.key];
    if (key === undefined) return;
    event.preventDefault();
    props.onMove(node.id, key);
  };

  const items: MenuItem[] = [
    { label: t("pool.renameCategory"), icon: Pencil, onSelect: () => props.onStartRename(node.id) },
    {
      label: t("pool.newSubcategory"),
      icon: FolderPlus,
      onSelect: () => props.onCreateChild(node),
    },
    {
      label: t("pool.moveUp"),
      icon: ArrowUp,
      separator: true,
      disabled: !moves.up,
      onSelect: () => props.onMove(node.id, moves.up),
    },
    {
      label: t("pool.moveDown"),
      icon: ArrowDown,
      disabled: !moves.down,
      onSelect: () => props.onMove(node.id, moves.down),
    },
    ...(previous
      ? [
          {
            label: t("categories.moveInto", { name: previous.name }),
            icon: CornerDownRight,
            onSelect: () => props.onMove(node.id, moves.indent),
          },
        ]
      : []),
    ...(parent
      ? [
          {
            label: t("categories.moveOut", { name: parent.name }),
            icon: CornerLeftUp,
            onSelect: () => props.onMove(node.id, moves.outdent),
          },
        ]
      : []),
    { label: t("categories.moveTo"), icon: FolderInput, onSelect: () => props.onMoveTo(node) },
    {
      label: t("pool.deleteCategory"),
      icon: Trash2,
      danger: true,
      separator: true,
      onSelect: () => props.onDelete(node),
    },
  ];

  return (
    <li>
      <div
        draggable={!readOnly && !isEditing}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, node.id);
          event.dataTransfer.effectAllowed = "move";
          props.onDragStart(node.id);
        }}
        onDragEnd={props.onDragEnd}
        onDragOver={(event) => {
          if (dragging === null || refuses) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          props.onDragOver(node.id, dropWhere(event));
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            props.onDragOver(node.id, null);
          }
        }}
        onDrop={(event) => {
          if (dragging === null || refuses) return;
          event.preventDefault();
          props.onDrop(node.id, dropWhere(event));
        }}
        style={{ paddingLeft: 12 + depth * 24 }}
        className={cx(
          "group relative flex min-h-11 items-center gap-2 border-t border-line pr-2 transition-colors",
          !readOnly && !isEditing && "cursor-grab active:cursor-grabbing",
          here === "inside"
            ? "bg-accent-soft outline-2 -outline-offset-2 outline-accent"
            : "hover:bg-surface-2",
          dragging === node.id && "opacity-50",
        )}
      >
        {here === "before" || here === "after" ? (
          <span
            aria-hidden
            className={cx(
              "pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-accent",
              here === "before" ? "-top-px" : "-bottom-px",
            )}
          />
        ) : null}
        <Folder className="size-4 shrink-0 text-fg-faint" aria-hidden />
        {isEditing ? (
          <input
            autoFocus
            aria-label={t("pool.categoryName")}
            defaultValue={node.name}
            maxLength={120}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onRename(node, e.currentTarget.value);
              if (e.key === "Escape") {
                e.stopPropagation();
                props.onRename(node, null);
              }
            }}
            onBlur={(e) => props.onRename(node, e.currentTarget.value)}
            className={cx(inputClass, inputSize.sm, "min-w-0 flex-1 px-2 font-medium")}
          />
        ) : readOnly ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.name}</span>
        ) : (
          <button
            type="button"
            data-category-name={node.id}
            aria-label={t("categories.renameNamed", { name: node.name })}
            aria-keyshortcuts="F2 Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
            onClick={() => props.onStartRename(node.id)}
            onKeyDown={onKeyDown}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-field border border-transparent py-1 text-left text-sm font-medium"
          >
            <span className="truncate">{node.name}</span>
            <Pencil
              aria-hidden
              className="size-3.5 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            />
          </button>
        )}
        {node.questionCount > 0 ? (
          <button
            type="button"
            aria-label={t("categories.showQuestions", { name: node.name })}
            onClick={() => props.onShowQuestions(node)}
            className="shrink-0 rounded-full px-2 py-0.5 text-right text-[13px] tabular-nums text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg"
          >
            {node.questionCount}
          </button>
        ) : (
          <span className="shrink-0 px-2 text-right text-[13px] tabular-nums text-fg-faint">0</span>
        )}
        {readOnly ? null : (
          <Menu label={t("categories.actionsOf", { name: node.name })} items={items} />
        )}
      </div>
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <CategoryRow key={child.id} {...props} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

type Dialog =
  | { kind: "create"; parentId: string | null }
  | { kind: "move"; node: CategoryCountNode }
  | null;

export function CategoriesPage({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toastError = useErrorToast();
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
  const [name, setName] = useState("");
  const [parentChoice, setParentChoice] = useState("");
  /** The folder whose name takes the focus back once the tree is redrawn. */
  const refocus = useRef<string | null>(null);

  const pool = useQuery<PoolDetail>({
    queryKey: poolKey(id),
    queryFn: () => api(`/app/api/pools/${id}`),
  });
  const key = poolCategoriesKey(id);
  const data = useQuery<PoolCategories>({
    queryKey: key,
    queryFn: () => api(`/app/api/pools/${id}/categories`),
  });
  const tree = data.data?.categories ?? [];

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

  // Prefix: the sidebar's tree, the question lists and this page all hang
  // off the pool's key.
  const invalidate = () => qc.invalidateQueries({ queryKey: poolKey(id) });
  const fail = toastError("pool.categoryFailed");

  const reorder = useMutation({
    mutationFn: (items: OrderItem[]) =>
      api(`/app/api/pools/${id}/categories/order`, {
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
      api(`/app/api/pools/${id}/categories`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setDialog(null);
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

  const move = (categoryId: string, target: FolderTarget | null) => {
    if (!target) return;
    const items = moveFolder(tree, categoryId, target);
    if (!items) return;
    refocus.current = categoryId;
    reorder.mutate(items);
  };

  const onDrop = (targetId: string, where: DropWhere) => {
    const dragged = dragging;
    setDragging(null);
    setDrop(null);
    if (!dragged || dragged === targetId) return;
    const target = findCategory(tree, targetId);
    if (!target) return;
    if (where === "inside") {
      move(dragged, { parentId: target.id, index: target.children.length });
      return;
    }
    const parent = target.parentId ? findCategory(tree, target.parentId) : null;
    const siblings = (parent ? parent.children : tree).filter((s) => s.id !== dragged);
    const index = siblings.findIndex((s) => s.id === targetId);
    move(dragged, { parentId: target.parentId, index: where === "before" ? index : index + 1 });
  };

  const onRename = (node: CategoryCountNode, next: string | null) => {
    if (editingRef.current !== node.id) return;
    setEditing(null);
    refocus.current = node.id;
    const trimmed = next?.trim() ?? "";
    if (trimmed === "" || trimmed === node.name) return;
    rename.mutate({ id: node.id, name: trimmed });
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
    if (ok) remove.mutate(node.id);
  };

  const openCreate = (parentId: string | null) => {
    setName("");
    setDialog({ kind: "create", parentId });
  };

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
  const moving = dialog?.kind === "move" ? dialog.node : null;
  const excluded = moving ? subtreeIds(tree, moving.id) : new Set<string>();

  return (
    <div className="space-y-6">
      <PageHeader
        help="categories"
        eyebrow={
          <ParentLink onClick={() => navigate({ view: "pool", id })}>{detail.pool.name}</ParentLink>
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
            <Button onClick={() => openCreate(null)}>
              <Plus /> {t("pool.newCategory")}
            </Button>
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
            action={
              readOnly ? null : (
                <Button onClick={() => openCreate(null)}>
                  <Plus /> {t("pool.newCategory")}
                </Button>
              )
            }
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
                <CategoryRow
                  key={node.id}
                  node={node}
                  depth={0}
                  tree={tree}
                  readOnly={readOnly}
                  editing={editing}
                  dragging={dragging}
                  drop={drop}
                  onRename={onRename}
                  onStartRename={setEditing}
                  onMove={move}
                  onMoveTo={(n) => {
                    setParentChoice(n.parentId ?? "");
                    setDialog({ kind: "move", node: n });
                  }}
                  onCreateChild={(n) => openCreate(n.id)}
                  onDelete={(n) => void askDelete(n)}
                  onShowQuestions={(n) => {
                    navigate({ view: "pool", id });
                    setCategory(n.id);
                  }}
                  onDragStart={setDragging}
                  onDragEnd={() => {
                    setDragging(null);
                    setDrop(null);
                  }}
                  onDragOver={(targetId, where) =>
                    setDrop((d) =>
                      where === null
                        ? d?.id === targetId
                          ? null
                          : d
                        : d?.id === targetId && d.where === where
                          ? d
                          : { id: targetId, where },
                    )
                  }
                  onDrop={onDrop}
                />
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
        <FormDialog
          title={dialog.parentId ? t("pool.newSubcategory") : t("pool.newCategory")}
          onClose={() => setDialog(null)}
          onSubmit={() => create.mutate({ name: name.trim(), parentId: dialog.parentId })}
          submitLabel={t("common.create")}
          submitting={create.isPending}
          canSubmit={name.trim() !== ""}
        >
          <Field
            label={t("pool.categoryName")}
            fullWidth
            autoFocus
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() !== "") {
                create.mutate({ name: name.trim(), parentId: dialog.parentId });
              }
            }}
          />
        </FormDialog>
      ) : null}

      {moving ? (
        <FormDialog
          title={t("categories.moveToTitle", { name: moving.name })}
          onClose={() => setDialog(null)}
          onSubmit={() => {
            const parentId = parentChoice === "" ? null : parentChoice;
            const siblings = parentId ? (findCategory(tree, parentId)?.children ?? []) : tree;
            move(moving.id, { parentId, index: siblings.length });
            setDialog(null);
          }}
          submitLabel={t("common.save")}
          canSubmit={parentChoice !== (moving.parentId ?? "")}
        >
          <Select
            label={t("categories.parent")}
            autoFocus
            value={parentChoice}
            onChange={(e) => setParentChoice(e.target.value)}
          >
            <option value="">{t("categories.topLevel")}</option>
            {categoryPaths(tree)
              .filter((p) => !excluded.has(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
          </Select>
        </FormDialog>
      ) : null}
    </div>
  );
}
