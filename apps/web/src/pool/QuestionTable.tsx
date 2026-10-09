import { BarChart3, Copy, Pencil, Trash2 } from "lucide-react";
import type { DragEvent } from "react";

import type { QuestionRow } from "@quiz/contracts";

import { ConceptNames } from "../concepts/refs";
import { useT } from "../i18n";
import { typeIcon, typeLabel } from "../questionTypes";
import {
  Badge,
  Checkbox,
  cx,
  IconButton,
  RelativeTime,
  Skeleton,
  T,
  TableBand,
  TableHead,
  Tip,
  type Column,
  type SortState,
} from "../ui";
import type { QuestionGroup } from "./QuestionGroups";
import type { QuestionSort, SortDir } from "./filters";
import { StarButton } from "./stars";
import { entryKey, type RowProps } from "./useQuestionBrowse";
import { ParameterizedBadge } from "./ParameterizedBadge";
import { ReviewBadge } from "./ReviewBadge";

/**
 * The questions of a pool, as the table of the pool screen.
 *
 * The internal name is dominant and monospaced (it is what a teacher types in
 * the palette), the type is the ICON in front of it, the difficulty is five
 * dots — a shape, never a colour — and the actions are last.
 *
 * A pool is BROWSED to choose a question — a colleague's, a public one — and
 * a name alone does not say what a question asks. So a row has two gestures
 * (`useQuestionBrowse`): a click, ↑/↓ and P LOOK, showing the question as a
 * student reads it in a pane beside the list (`PoolView`); Enter, a
 * double-click and the pencil EDIT. Space and the star at the start of the
 * name STAR it — the caller's own favourite (F-POOL-10), a reader's too, so
 * the star sits in the name cell and not among the actions a reader lacks.
 *
 * The type lost its column and became a 20 px glyph at the left of the name.
 * A badge repeating "Multiple choice" on forty rows is forty copies of a word
 * nobody reads twice; the icon is what the eye actually sorts on, and the
 * label stays one hover (`Tip`) and one screen-reader stop away. The 110 px
 * that column cost went to the name and the concepts.
 *
 * Sorting is the SERVER's (`sort` / `dir` of `QuestionSearch`), not a local
 * `useSortableTable`: the list is paginated, and a page sorted in the browser
 * sorts the rows that happen to be loaded — which is the wrong answer written
 * convincingly. The headers therefore only report the click; `PoolView` turns
 * it into a query and restarts the pagination. `type` has no header any more
 * and is not a sort a reader can pick: grouping by type is what orders the
 * list by it. The cards follow whatever sort the headers set.
 *
 * The last column carries three icon buttons rather than the overflow menu
 * DESIGN.md's "three icon buttons = a menu" rule would ask for: the teacher
 * asked for edit, duplicate and delete visible on the row, and a rule loses
 * to the person who uses the screen every week. It is also the column that
 * is PINNED to the right edge (`T.stickyEnd`).
 *
 * Which columns survive a narrow page is `T`'s column priority, measured on
 * the table's own container and not on the viewport. Version goes first
 * (`T.colLow`), then Updated (`T.colMid`), then Concepts (`T.colHigh`); the name,
 * the difficulty, the tick box and the actions never go. On a phone the
 * table turns into row cards (`T.stack`): the tick box, the name and the
 * actions on the first line, the difficulty and the version under the name.
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

/**
 * The chart icon that opens a question's statistics (ADR-038), drawn only for
 * a question the pool's statistics list — ten answers or more. It sits after
 * the name rather than among the row's actions: a reader, who has no action
 * column, must reach it too. It stops the click, which would open the editor.
 */
export function StatsButton({ row, onOpen }: { row: QuestionRow; onOpen: () => void }) {
  const t = useT();
  return (
    <span onClick={(e) => e.stopPropagation()} className="inline-flex">
      <IconButton size="sm" label={t("pool.stats.open", { name: row.internalName })} onClick={onOpen}>
        <BarChart3 />
      </IconButton>
    </span>
  );
}

/**
 * What the table and the cards take to draw {@link StatsButton}: the opener
 * of a row's statistics, undefined when the question has none to show.
 */
export type StatsFor = (row: QuestionRow) => (() => void) | undefined;

/** {@link StatsButton} when the row has statistics, nothing otherwise. */
export function RowStatsButton({ row, statsFor }: { row: QuestionRow; statsFor?: StatsFor | undefined }) {
  const open = statsFor?.(row);
  return open ? <StatsButton row={row} onOpen={open} /> : null;
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
  rowProps,
  onEdit,
  onDuplicate,
  onDelete,
  sort,
  dir,
  onSort,
  onDragStart,
  readOnly = false,
  statsFor,
  onStar,
}: {
  /** One section per "group by" value; `none` hands over a single unlabelled one. */
  groups: QuestionGroup[];
  /** The ids ticked for a bulk action. */
  checked: ReadonlySet<string>;
  onToggleCheck: (id: string) => void;
  onToggleAll: () => void;
  /** Looking and walking: the click, the keys, the roving focus (`useQuestionBrowse`). */
  rowProps: (key: string, row: QuestionRow) => RowProps;
  /** Opening the editor: the pencil (the row's Enter and double-click go through `rowProps`). */
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
  /** Absent while the statistics load or when they failed. */
  statsFor?: StatsFor | undefined;
  /** The row's star (F-POOL-10), for every role. */
  onStar: (row: QuestionRow) => void;
}) {
  const t = useT();
  const rows = groups.flatMap((g) => g.rows);
  const unique = new Set(rows.map((r) => r.id));
  const allChecked = unique.size > 0 && [...unique].every((id) => checked.has(id));
  const sortState: SortState<QuestionSort> = { key: sort, dir: dir === "asc" ? 1 : -1 };
  // A band spanning the whole width, whatever the container has hidden.
  const span = 7;
  const columns: Column<QuestionSort>[] = [
    ...(readOnly
      ? []
      : [
          {
            key: "select",
            sortable: false as const,
            className: "w-8",
            stack: "lead" as const,
            label: (
              <Checkbox
                label={<span className="sr-only">{t("pool.selectAll")}</span>}
                checked={allChecked}
                onChange={onToggleAll}
              />
            ),
          },
        ]),
    { key: "name", label: t("pool.col.name"), stack: "main" },
    // The concepts are read, never ordered: a row carries several of them, and a
    // list sorted on "the first concept" is an order nobody asked for.
    { key: "concepts", label: t("pool.col.concepts"), sortable: false, className: T.colHigh },
    { key: "difficulty", label: t("pool.col.difficulty"), className: "whitespace-nowrap", stack: "sub" },
    { key: "version", label: t("pool.col.version"), className: T.colLow, stack: "sub" },
    { key: "updated", label: t("pool.col.updated"), className: T.colMid },
    ...(readOnly
      ? []
      : [
          {
            key: "actions",
            label: t("common.actions"),
            sortable: false as const,
            srOnly: true,
            className: T.stickyEnd,
            stack: "end" as const,
          },
        ]),
  ];
  return (
    <div className={cx(T.container, "overflow-x-auto rounded-card border border-line bg-surface")}>
      <table role="table" className={cx(T.table, T.stack.table)}>
        <TableHead columns={columns} sort={sortState} onToggle={onSort} />
        {groups.map((group) => (
          <tbody role="rowgroup" key={group.key}>
            {group.label === null ? null : (
              <TableBand stacked span={span} label={group.label} count={group.rows.length} />
            )}
            {group.rows.map((row) => (
              <tr role="row"
                key={entryKey(group, row)}
                {...rowProps(entryKey(group, row), row)}
                draggable={onDragStart !== undefined}
                onDragStart={onDragStart ? (event) => onDragStart(event, row) : undefined}
                className={cx(T.row, T.rowHover, T.stack.row, "cursor-pointer aria-[current=true]:bg-accent-soft")}
              >
                {readOnly ? null : (
                  <td role="cell" className={cx(T.td, T.stack.lead)} onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      label={
                        <span className="sr-only">{t("pool.select", { name: row.internalName })}</span>
                      }
                      checked={checked.has(row.id)}
                      onChange={() => onToggleCheck(row.id)}
                    />
                  </td>
                )}
                <td role="cell" className={cx(T.td, T.stack.main, "whitespace-nowrap")}>
                  <span className="flex items-center gap-2">
                    <StarButton row={row} onToggle={() => onStar(row)} />
                    <TypeGlyph type={row.type} />
                    <span className="font-mono font-bold group-aria-[current=true]:text-accent">
                      {row.internalName}
                    </span>
                    {row.deletedAt ? <Badge tone="zinc">{t("pool.deleted")}</Badge> : null}
                    {row.randomizable ? <ParameterizedBadge /> : null}
                    <ReviewBadge review={row.review} />
                    <RowStatsButton row={row} statsFor={statsFor} />
                  </span>
                </td>
                <td role="cell" className={cx(T.td, "max-w-56", T.colHigh)}>
                  {row.concepts.length === 0 ? (
                    <span className="text-fg-faint">—</span>
                  ) : (
                    <ConceptNames concepts={row.concepts} />
                  )}
                </td>
                <td role="cell" className={cx(T.td, readOnly ? T.stack.sub : T.stack.subIndent, "whitespace-nowrap")}>
                  <DifficultyDots value={row.difficulty} />
                </td>
                {/* On a card the version is the row's status, beside the difficulty. */}
                <td role="cell" className={cx(T.td, T.colLow, T.stack.sub, "@max-md:block")}>
                  <span className="sr-only @md:hidden">{t("pool.col.version")} </span>
                  <VersionCell row={row} />
                </td>
                <td role="cell" className={cx(T.td, "whitespace-nowrap text-fg-muted", T.colMid)}>
                  <RelativeTime iso={row.updatedAt} />
                </td>
                {readOnly ? null : (
                  <td role="cell"
                    className={cx(
                      T.td,
                      "text-right",
                      T.stickyEnd,
                      T.stack.end,
                      // The row's tint laid OVER an opaque fill, hovered or not:
                      // in dark mode `accent-soft` is translucent, and as the
                      // fill it would let the scrolled cells show through.
                      "group-aria-[current=true]:bg-surface group-aria-[current=true]:bg-[linear-gradient(var(--accent-soft),var(--accent-soft))]",
                    )}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="touch-group inline-flex items-center gap-0.5">
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
