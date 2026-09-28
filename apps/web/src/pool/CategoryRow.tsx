import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  CornerLeftUp,
  Folder,
  FolderInput,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import type { DragEvent, KeyboardEvent } from "react";

import type { CategoryCountNode } from "@quiz/contracts";

import { useT, type TFunction } from "../i18n";
import { cx, inputClass, inputSize, Menu, type MenuItem } from "../ui";
import {
  findCategory,
  neighbourMoves,
  subtreeIds,
  type DropWhere,
  type FolderTarget,
} from "./categories";

/**
 * One folder of the categories page (CategoriesPage.tsx), and its subtree:
 * the name that renames in place (click, Enter or F2), the count that opens
 * the question list filtered on it, the row's menu, and the drag and
 * Alt+arrow moves. The page owns every state; a row draws it and reports.
 */

const DRAG_TYPE = "application/x-quiz-category";

/** Upper quarter: before; lower quarter: after; the middle: inside. */
function dropWhere(event: DragEvent<HTMLElement>): DropWhere {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = (event.clientY - rect.top) / Math.max(rect.height, 1);
  return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
}

/** The drop marker a hover leaves: `where === null` is the pointer leaving `id`. */
export function hoverDrop(
  current: { id: string; where: DropWhere } | null,
  id: string,
  where: DropWhere | null,
): { id: string; where: DropWhere } | null {
  if (where === null) return current?.id === id ? null : current;
  return current?.id === id && current.where === where ? current : { id, where };
}

export interface RowProps {
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

/**
 * The row's menu: rename, a subfolder, the four moves in words — "into" and
 * "out of" only where they exist, named after the folder they go into or
 * leave — the move dialog, and deletion.
 */
function rowMenu(t: TFunction, props: RowProps): MenuItem[] {
  const { node, tree } = props;
  const moves = neighbourMoves(tree, node.id);
  const parent = node.parentId ? findCategory(tree, node.parentId) : null;
  const siblings = parent ? parent.children : tree;
  const previous = siblings[siblings.findIndex((s) => s.id === node.id) - 1];
  return [
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
}

/** F2 renames; Alt+arrows move the folder up, down, into the one above, out of its parent. */
function onNameKey(props: RowProps, event: KeyboardEvent<HTMLButtonElement>) {
  const { node } = props;
  if (event.key === "F2") {
    event.preventDefault();
    props.onStartRename(node.id);
    return;
  }
  if (!event.altKey) return;
  const moves = neighbourMoves(props.tree, node.id);
  const target = {
    ArrowUp: moves.up,
    ArrowDown: moves.down,
    ArrowRight: moves.indent,
    ArrowLeft: moves.outdent,
  }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  props.onMove(node.id, target);
}

/** The folder's name: an input while renamed, plain text when read only, else the rename button. */
function CategoryName(props: RowProps) {
  const { node, readOnly } = props;
  const t = useT();
  if (props.editing === node.id) {
    return (
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
    );
  }
  if (readOnly) {
    return <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.name}</span>;
  }
  return (
    <button
      type="button"
      data-category-name={node.id}
      aria-label={t("categories.renameNamed", { name: node.name })}
      aria-keyshortcuts="F2 Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
      onClick={() => props.onStartRename(node.id)}
      onKeyDown={(event) => onNameKey(props, event)}
      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-field border border-transparent py-1 text-left text-sm font-medium"
    >
      <span className="truncate">{node.name}</span>
      <Pencil
        aria-hidden
        className="size-3.5 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      />
    </button>
  );
}

/** The number of questions filed in the folder itself; a link to them when there are any. */
function CategoryCount({ node, onShowQuestions }: Pick<RowProps, "node" | "onShowQuestions">) {
  const t = useT();
  if (node.questionCount === 0) {
    return <span className="shrink-0 px-2 text-right text-[13px] tabular-nums text-fg-faint">0</span>;
  }
  return (
    <button
      type="button"
      aria-label={t("categories.showQuestions", { name: node.name })}
      onClick={() => onShowQuestions(node)}
      className="shrink-0 rounded-full px-2 py-0.5 text-right text-[13px] tabular-nums text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg"
    >
      {node.questionCount}
    </button>
  );
}

export function CategoryRow(props: RowProps) {
  const { node, depth, tree, readOnly, dragging, drop } = props;
  const t = useT();
  const isEditing = props.editing === node.id;
  const here = drop?.id === node.id ? drop.where : null;
  // A folder cannot be dropped into itself or its own subtree.
  const accepts = dragging !== null && !subtreeIds(tree, dragging).has(node.id);

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
          if (!accepts) return;
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
          if (!accepts) return;
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
        <CategoryName {...props} />
        <CategoryCount node={node} onShowQuestions={props.onShowQuestions} />
        {readOnly ? null : (
          <Menu label={t("categories.actionsOf", { name: node.name })} items={rowMenu(t, props)} />
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
