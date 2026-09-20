import { Copy, Pencil, Trash2 } from "lucide-react";

import type { QuestionRow } from "@quiz/contracts";

import { useT } from "../i18n";
import { typeIcon, typeLabel } from "../questionTypes";
import { Badge, Checkbox, cx, isoDateTime, Menu, pressable, Skeleton, T } from "../ui";

/**
 * The questions of a pool (mockup `08-pool.html`).
 *
 * Seven columns, the internal name dominant and monospaced (it is what a
 * teacher types in the palette), the type as a badge, the difficulty as five
 * dots — a shape, never a colour — and the actions last. A click on the row
 * opens the preview panel; the editor is one menu item away, so a mis-click
 * never navigates out of the list.
 */

export function DifficultyDots({ value }: { value: number }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1" title={t("pool.difficultyOf", { n: value })}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          aria-hidden
          className={cx("size-1.5 rounded-full", i <= value ? "bg-fg-muted" : "bg-surface-3")}
        />
      ))}
      <span className="sr-only">{t("pool.difficultyOf", { n: value })}</span>
    </span>
  );
}

export function QuestionTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function QuestionTable({
  rows,
  selectedId,
  checked,
  onToggleCheck,
  onToggleAll,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  rows: QuestionRow[];
  /** The row whose preview panel is open. */
  selectedId: string | null;
  /** The ids ticked for a bulk action. */
  checked: ReadonlySet<string>;
  onToggleCheck: (id: string) => void;
  onToggleAll: () => void;
  onSelect: (row: QuestionRow) => void;
  onEdit: (row: QuestionRow) => void;
  onDuplicate: (row: QuestionRow) => void;
  onDelete: (row: QuestionRow) => void;
}) {
  const t = useT();
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className={T.table}>
        <thead className={T.head}>
          <tr>
            <th className={cx(T.th, "w-8")}>
              <Checkbox
                label={<span className="sr-only">{t("pool.selectAll")}</span>}
                checked={allChecked}
                onChange={onToggleAll}
              />
            </th>
            <th className={T.th}>{t("pool.col.name")}</th>
            <th className={T.th}>{t("pool.col.type")}</th>
            <th className={cx(T.th, "hidden md:table-cell")}>{t("pool.col.tags")}</th>
            <th className={cx(T.th, "hidden sm:table-cell")}>{t("pool.col.difficulty")}</th>
            <th className={cx(T.th, "hidden lg:table-cell")}>{t("pool.col.version")}</th>
            <th className={cx(T.th, "hidden lg:table-cell")}>{t("pool.col.updated")}</th>
            <th className={T.th}>
              <span className="sr-only">{t("common.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const Icon = typeIcon(row.type);
            return (
              <tr
                key={row.id}
                aria-selected={selectedId === row.id}
                onClick={() => onSelect(row)}
                {...pressable(() => onSelect(row), "row")}
                className={cx(
                  T.row,
                  T.rowHover,
                  "cursor-pointer",
                  selectedId === row.id && "bg-accent-soft hover:bg-accent-soft",
                )}
              >
                <td className={T.td} onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    label={<span className="sr-only">{t("pool.select", { name: row.internalName })}</span>}
                    checked={checked.has(row.id)}
                    onChange={() => onToggleCheck(row.id)}
                  />
                </td>
                <td className={cx(T.td, "whitespace-nowrap")}>
                  <span className="font-mono font-bold">{row.internalName}</span>
                  {row.deletedAt ? (
                    <Badge tone="zinc" className="ml-2">
                      {t("pool.deleted")}
                    </Badge>
                  ) : null}
                </td>
                <td className={T.td}>
                  {/* On a phone the badge keeps its icon and loses its word:
                      the name and the actions are what must fit there, and
                      the label stays in the accessible name. */}
                  <Badge tone="zinc" icon={Icon}>
                    <span className="sr-only sm:not-sr-only">{typeLabel(t, row.type)}</span>
                  </Badge>
                </td>
                <td className={cx(T.td, "hidden max-w-56 md:table-cell")}>
                  {row.tags.length === 0 ? (
                    <span className="text-fg-faint">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {row.tags.map((tag) => (
                        <span key={tag} className="text-xs text-fg-muted">
                          #{tag}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className={cx(T.td, "hidden sm:table-cell")}>
                  <DifficultyDots value={row.difficulty} />
                </td>
                <td className={cx(T.td, "hidden lg:table-cell")}>
                  {row.latestNumber === null ? (
                    <Badge tone="amber">{t("pool.draftOnly")}</Badge>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono tabular-nums">v{row.latestNumber}</span>
                      {row.hasDraftChanges ? (
                        <span
                          className="size-1.5 rounded-full bg-warning"
                          title={t("pool.draftChanges")}
                        />
                      ) : null}
                    </span>
                  )}
                </td>
                <td className={cx(T.td, "hidden whitespace-nowrap tabular-nums text-fg-muted lg:table-cell")}>
                  {isoDateTime(row.updatedAt)}
                </td>
                <td className={cx(T.td, "text-right")} onClick={(e) => e.stopPropagation()}>
                  <Menu
                    label={t("pool.rowActions", { name: row.internalName })}
                    items={[
                      { label: t("pool.open"), icon: Pencil, onSelect: () => onEdit(row) },
                      { label: t("pool.duplicate"), icon: Copy, onSelect: () => onDuplicate(row) },
                      {
                        label: t("common.delete"),
                        icon: Trash2,
                        danger: true,
                        separator: true,
                        onSelect: () => onDelete(row),
                      },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
