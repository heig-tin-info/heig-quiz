import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderPlus, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import type { CategoryNode } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Button, cx, Field, Menu, Modal } from "../ui";

/**
 * The categories of a pool, on the left of the pool screen (mockup
 * `08-pool.html`): a folder tree that selects, creates, renames, reorders and
 * deletes, and nothing more — the questions themselves live in the table.
 *
 * Selection is the ONE thing a click does; every edit sits in the row's
 * overflow menu, because three icon buttons per row would make the tree read
 * as a toolbar (DESIGN.md › action tiers).
 */

/** Flattens the sibling list of a node, for a move that renumbers positions. */
function siblingsOf(tree: CategoryNode[], parentId: string | null): CategoryNode[] {
  if (parentId === null) return tree;
  const stack = [...tree];
  while (stack.length) {
    const node = stack.shift()!;
    if (node.id === parentId) return node.children;
    stack.push(...node.children);
  }
  return [];
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
  siblings,
}: {
  node: CategoryNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onCreateChild: (parent: CategoryNode) => void;
  onRename: (node: CategoryNode) => void;
  onDelete: (node: CategoryNode) => void;
  onMove: (node: CategoryNode, direction: -1 | 1) => void;
  siblings: CategoryNode[];
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const active = selected === node.id;
  const index = siblings.findIndex((s) => s.id === node.id);
  return (
    <li>
      <div
        className={cx(
          "group flex items-center gap-1 rounded-[10px] pr-1 transition-colors",
          active ? "bg-accent-soft" : "hover:bg-surface-2",
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
              siblings={node.children}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function CategoryTree({
  poolId,
  categories,
  selected,
  onSelect,
}: {
  poolId: string;
  categories: CategoryNode[];
  /** `null` is "all questions". */
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<
    { mode: "create"; parentId: string | null } | { mode: "rename"; node: CategoryNode } | null
  >(null);
  const [name, setName] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["pool", poolId] });
  const fail = (error: unknown) => toast(apiErrorMessage(error, t("pool.categoryFailed")), "error");

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

  return (
    <nav aria-label={t("pool.categories")} className="w-full lg:w-56 lg:shrink-0">
      <p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
        {t("pool.categories")}
      </p>
      <ul className="space-y-0.5">
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-current={selected === null ? "true" : undefined}
            className={cx(
              "flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] transition-colors",
              selected === null
                ? "bg-accent-soft font-semibold text-accent"
                : "text-fg-muted hover:bg-surface-2 hover:text-fg",
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
            siblings={categories}
          />
        ))}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 w-full justify-start"
        onClick={() => openCreate(null)}
      >
        <Plus /> {t("pool.newCategory")}
      </Button>

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
    </nav>
  );
}
