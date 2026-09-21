import { Copy, Pencil, Trash2 } from "lucide-react";

import type { QuestionRow } from "@quiz/contracts";

import { useT } from "../i18n";
import { typeIcon, typeLabel } from "../questionTypes";
import { Badge, Checkbox, cx, IconButton, isoDateTime, pressable, Skeleton, T } from "../ui";

/**
 * The questions of a pool (mockup `08-pool.html`).
 *
 * Seven columns, the internal name dominant and monospaced (it is what a
 * teacher types in the palette), the type as a badge, the difficulty as five
 * dots — a shape, never a colour — and the actions last. A click on the row
 * opens the EDITOR: reading a question means opening it, and the inspection
 * panel that used to intercept the click was one step between the teacher
 * and the only thing they came for.
 *
 * The last column carries three icon buttons rather than the overflow menu
 * DESIGN.md's "three icon buttons = a menu" rule would ask for: the teacher
 * asked for edit, duplicate and delete visible on the row, and a rule loses
 * to the person who uses the screen every week. It is also the column that
 * is PINNED to the right edge (`T.stickyEnd`): past the last threshold the
 * table scrolls, and the three actions were the first thing the scroll cut
 * off.
 *
 * Which columns survive a narrow page is `T`'s column priority, measured on
 * the table's own container and not on the viewport — the pool page is 1120
 * px wide at 1440 and 720 px beside the sidebar at 1024, and the viewport
 * says nothing about that. Version goes first (`T.colLow`), then Updated
 * (`T.colMid`), then Tags (`T.colHigh`); the name, the type, the difficulty,
 * the tick box and the actions never go.
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
  checked,
  onToggleCheck,
  onToggleAll,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  rows: QuestionRow[];
  /** The ids ticked for a bulk action. */
  checked: ReadonlySet<string>;
  onToggleCheck: (id: string) => void;
  onToggleAll: () => void;
  /** Opening the question: the row itself, and the pencil. */
  onEdit: (row: QuestionRow) => void;
  onDuplicate: (row: QuestionRow) => void;
  onDelete: (row: QuestionRow) => void;
}) {
  const t = useT();
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  return (
    <div className={cx(T.container, "overflow-x-auto rounded-card border border-line bg-surface")}>
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
            <th className={cx(T.th, T.colHigh)}>{t("pool.col.tags")}</th>
            <th className={T.th}>{t("pool.col.difficulty")}</th>
            <th className={cx(T.th, T.colLow)}>{t("pool.col.version")}</th>
            <th className={cx(T.th, T.colMid)}>{t("pool.col.updated")}</th>
            <th className={cx(T.th, T.stickyEnd)}>
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
                onClick={() => onEdit(row)}
                {...pressable(() => onEdit(row), "row")}
                className={cx(T.row, T.rowHover, "cursor-pointer")}
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
                    <span className={cx("sr-only", T.wordFrom)}>{typeLabel(t, row.type)}</span>
                  </Badge>
                </td>
                <td className={cx(T.td, "max-w-56", T.colHigh)}>
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
                <td className={T.td}>
                  <DifficultyDots value={row.difficulty} />
                </td>
                <td className={cx(T.td, T.colLow)}>
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
                <td className={cx(T.td, "whitespace-nowrap tabular-nums text-fg-muted", T.colMid)}>
                  {isoDateTime(row.updatedAt)}
                </td>
                <td className={cx(T.td, "text-right", T.stickyEnd)} onClick={(e) => e.stopPropagation()}>
                  <span className="inline-flex items-center gap-0.5">
                    <IconButton
                      size="sm"
                      label={t("pool.editRow", { name: row.internalName })}
                      onClick={() => onEdit(row)}
                    >
                      <Pencil />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={t("pool.duplicateRow", { name: row.internalName })}
                      onClick={() => onDuplicate(row)}
                    >
                      <Copy />
                    </IconButton>
                    <IconButton
                      size="sm"
                      danger
                      label={t("pool.deleteRow", { name: row.internalName })}
                      onClick={() => onDelete(row)}
                    >
                      <Trash2 />
                    </IconButton>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
