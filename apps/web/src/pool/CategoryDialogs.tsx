import { useState } from "react";

import type { CategoryCountNode } from "@quiz/contracts";

import { useT } from "../i18n";
import { Field, FormDialog, Select } from "../ui";
import { categoryPaths, subtreeIds } from "./categories";

/**
 * The two one-field dialogs of the categories page: a new folder (at the top
 * level or under one), and "Move to…", the menu's way to file a folder
 * anywhere without dragging it. Each holds its own field, so it opens blank
 * or on the folder's current parent every time.
 */

export function NewCategoryDialog({
  sub,
  submitting,
  onCreate,
  onClose,
}: {
  /** Under a folder, not at the top level: only the title changes. */
  sub: boolean;
  submitting: boolean;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <FormDialog
      title={sub ? t("pool.newSubcategory") : t("pool.newCategory")}
      onClose={onClose}
      onSubmit={() => onCreate(trimmed)}
      submitLabel={t("common.create")}
      submitting={submitting}
      canSubmit={trimmed !== ""}
    >
      <Field
        label={t("pool.categoryName")}
        fullWidth
        autoFocus
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && trimmed !== "") onCreate(trimmed);
        }}
      />
    </FormDialog>
  );
}

export function MoveCategoryDialog({
  node,
  tree,
  onMove,
  onClose,
}: {
  node: CategoryCountNode;
  tree: CategoryCountNode[];
  /** The new parent, null for the top level. */
  onMove: (parentId: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [parentChoice, setParentChoice] = useState(node.parentId ?? "");
  // A folder cannot go into itself or its own subtree.
  const excluded = subtreeIds(tree, node.id);
  return (
    <FormDialog
      title={t("categories.moveToTitle", { name: node.name })}
      onClose={onClose}
      onSubmit={() => onMove(parentChoice === "" ? null : parentChoice)}
      submitLabel={t("common.save")}
      canSubmit={parentChoice !== (node.parentId ?? "")}
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
  );
}
