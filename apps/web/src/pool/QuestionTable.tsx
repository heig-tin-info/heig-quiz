import { Copy, Pencil, Trash2 } from "lucide-react";
import type { DragEvent } from "react";

import type { QuestionRow } from "@quiz/contracts";

import { useT } from "../i18n";
import { typeIcon, typeLabel } from "../questionTypes";
import {
  Badge,
  Checkbox,
  cx,
  IconButton,
  pressable,
  RelativeTime,
  Skeleton,
  SortHeader,
  T,
  Tip,
  type SortState,
} from "../ui";
import type { QuestionGroup } from "./QuestionGroups";
import type { QuestionSort, SortDir } from "./filters";

/**
 * The questions of a pool (mockup `08-pool.html`).
 *
 * The internal name is dominant and monospaced (it is what a teacher types in
 * the palette), the type is the ICON in front of it, the difficulty is five
 * dots — a shape, never a colour — and the actions are last. A click on the
 * row opens the EDITOR: reading a question means opening it, and the
 * inspection panel that used to intercept the click was one step between the
 * teacher and the only thing they came for.
 *
 * The type lost its column and became a 20 px glyph at the left of the name.
 * A badge repeating "Multiple choice" on forty rows is forty copies of a word
 * nobody reads twice; the icon is what the eye actually sorts on, and the
 * label stays one hover (`Tip`) and one screen-reader stop away. The 110 px
 * that column cost went to the name and the tags.
 *
 * Sorting is the SERVER's (`sort` / `dir` of `QuestionSearch`), not a local
 * `useSortableTable`: the list is paginated, and a page sorted in the browser
 * sorts the rows that happen to be loaded — which is the wrong answer written
 * convincingly. The headers therefore only report the click; `PoolView` turns
 * it into a query and restarts the pagination. `type` has no header any more,
 * so it is sorted from the toolbar's Sort control, which is also what the
 * cards use.
 *
 * The last column carries three icon buttons rather than the overflow menu
 * DESIGN.md's "three icon buttons = a menu" rule would ask for: the teacher
 * asked for edit, duplicate and delete visible on the row, and a rule loses
 * to the person who uses the screen every week. It is also the column that
 * is PINNED to the right edge (`T.stickyEnd`).
 *
 * Which columns survive a narrow page is `T`'s column priority, measured on
 * the table's own container and not on the viewport. Version goes first
 * (`T.colLow`), then Updated (`T.colMid`), then Tags (`T.colHigh`); the name,
 * the difficulty, the tick box and the actions never go.
 */

export function DifficultyDots({ value }: { value: number }) {
  const t = useT();
  const label = t("pool.difficultyOf", { n: value });
  return (
    <Tip label={label}>
      <span className="inline-flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            aria-hidden
            className={cx("size-1.5 rounded-full", i <= value ? "bg-fg-muted" : "bg-surface-3")}
          />
        ))}
        <span className="sr-only">{label}</span>
      </span>
    </Tip>
  );
}

/**
 * The type as a glyph, one size up from the icons around it (`size-5`), with
 * its name in the tooltip and in the accessible name. It is the only thing on
 * the row that says what kind of question this is, so it may not be decoration
 * only: the `sr-only` label is what a reader hears before the name.
 */
export function TypeGlyph({ type }: { type: string }) {
  const t = useT();
  const Icon = typeIcon(type);
  const label = typeLabel(t, type);
  return (
    <Tip label={label}>
      <span className="inline-flex items-center text-fg-faint">
        <Icon aria-hidden className="size-5 shrink-0" />
        <span className="sr-only">{label}</span>
      </span>
    </Tip>
  );
}

/** The published version, or the amber word that says there is none yet. */
export function VersionCell({ row }: { row: QuestionRow }) {
  const t = useT();
  if (row.latestNumber === null) return <Badge tone="amber">{t("pool.draftOnly")}</Badge>;
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-mono tabular-nums">v{row.latestNumber}</span>
      {row.hasDraftChanges ? (
        <Tip label={t("pool.draftChanges")}>
          <span className="size-1.5 rounded-full bg-warning" />
        </Tip>
      ) : null}
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
  groups,
  checked,
  onToggleCheck,
  onToggleAll,
  onEdit,
  onDuplicate,
  onDelete,
  sort,
  dir,
  onSort,
  onDragStart,
  readOnly = false,
}: {
  /** One section per "group by" value; `none` hands over a single unlabelled one. */
  groups: QuestionGroup[];
  /** The ids ticked for a bulk action. */
  checked: ReadonlySet<string>;
  onToggleCheck: (id: string) => void;
  onToggleAll: () => void;
  /** Opening the question: the row itself, and the pencil. */
  onEdit: (row: QuestionRow) => void;
  onDuplicate: (row: QuestionRow) => void;
  onDelete: (row: QuestionRow) => void;
  sort: QuestionSort;
  dir: SortDir;
  onSort: (key: QuestionSort) => void;
  /**
   * Makes the row draggable onto a pool of the sidebar, which MOVES it there
   * (ADR-017). Absent — a read-only pool — the row is not draggable at all.
   */
  onDragStart?: (event: DragEvent, row: QuestionRow) => void;
  /** A pool the caller only reads: no tick boxes, no row actions (F-POOL-05). */
  readOnly?: boolean;
}) {
  const t = useT();
  const rows = groups.flatMap((g) => g.rows);
  const unique = new Set(rows.map((r) => r.id));
  const allChecked = unique.size > 0 && [...unique].every((id) => checked.has(id));
  const sortState: SortState<QuestionSort> = { key: sort, dir: dir === "asc" ? 1 : -1 };
  // A band spanning the whole width, whatever the container has hidden.
  const span = 7;
  return (
    <div className={cx(T.container, "overflow-x-auto rounded-card border border-line bg-surface")}>
      <table className={T.table}>
        <thead className={T.head}>
          <tr>
            {readOnly ? null : (
              <th className={cx(T.th, "w-8")}>
                <Checkbox
                  label={<span className="sr-only">{t("pool.selectAll")}</span>}
                  checked={allChecked}
                  onChange={onToggleAll}
                />
              </th>
            )}
            <SortHeader k="name" sort={sortState} onToggle={onSort}>
              {t("pool.col.name")}
            </SortHeader>
            <th className={cx(T.th, T.colHigh)}>{t("pool.col.tags")}</th>
            <SortHeader k="difficulty" sort={sortState} onToggle={onSort} className="whitespace-nowrap">
              {t("pool.col.difficulty")}
            </SortHeader>
            <SortHeader k="version" sort={sortState} onToggle={onSort} className={T.colLow}>
              {t("pool.col.version")}
            </SortHeader>
            <SortHeader k="updated" sort={sortState} onToggle={onSort} className={T.colMid}>
              {t("pool.col.updated")}
            </SortHeader>
            {readOnly ? null : (
              <th className={cx(T.th, T.stickyEnd)}>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            )}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key}>
            {group.label === null ? null : (
              <tr>
                <td
                  colSpan={span}
                  className="border-t border-line bg-surface-2 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted"
                >
                  {group.label}
                  <span className="ml-2 tabular-nums text-fg-faint">{group.rows.length}</span>
                </td>
              </tr>
            )}
            {group.rows.map((row) => (
              <tr
                key={`${group.key}:${row.id}`}
                onClick={() => onEdit(row)}
                {...pressable(() => onEdit(row), "row")}
                draggable={onDragStart !== undefined}
                onDragStart={onDragStart ? (event) => onDragStart(event, row) : undefined}
                className={cx(T.row, T.rowHover, "cursor-pointer")}
              >
                {readOnly ? null : (
                  <td className={T.td} onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      label={
                        <span className="sr-only">{t("pool.select", { name: row.internalName })}</span>
                      }
                      checked={checked.has(row.id)}
                      onChange={() => onToggleCheck(row.id)}
                    />
                  </td>
                )}
                <td className={cx(T.td, "whitespace-nowrap")}>
                  <span className="flex items-center gap-2">
                    <TypeGlyph type={row.type} />
                    <span className="font-mono font-bold">{row.internalName}</span>
                    {row.deletedAt ? <Badge tone="zinc">{t("pool.deleted")}</Badge> : null}
                  </span>
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
                <td className={cx(T.td, "whitespace-nowrap")}>
                  <DifficultyDots value={row.difficulty} />
                </td>
                <td className={cx(T.td, T.colLow)}>
                  <VersionCell row={row} />
                </td>
                <td className={cx(T.td, "whitespace-nowrap text-fg-muted", T.colMid)}>
                  <RelativeTime iso={row.updatedAt} />
                </td>
                {readOnly ? null : (
                  <td
                    className={cx(T.td, "text-right", T.stickyEnd)}
                    onClick={(e) => e.stopPropagation()}
                  >
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
                )}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
