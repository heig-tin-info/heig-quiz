import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { cx } from "./layers";

// Sortable tables: one motif for every hand-rolled table.

export interface SortState<K extends string> {
  key: K;
  dir: 1 | -1;
}

const defaultCompare = (x: string | number, y: string | number) =>
  typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));

/**
 * Sort state + sorted rows for a client-side table: clicking the active
 * column flips the direction, clicking another selects it ascending.
 *
 * `initial` may be `null`, and that is not the same thing as "sorted by the
 * first column": it means THE ORDER THE ROWS ARRIVED IN, until the reader
 * asks for another one. A list the server already ordered — evaluations by
 * state and date, versions newest first — carries a meaning in that order,
 * and reshuffling it on mount throws it away before anybody clicked anything.
 */
export function useSortableTable<T, K extends string>(
  rows: readonly T[],
  rank: (row: T, key: K) => string | number,
  initial: SortState<NoInfer<K>> | null,
  compare: (x: string | number, y: string | number) => number = defaultCompare,
) {
  const [sort, setSort] = useState<SortState<K> | null>(initial);
  const toggle = (k: K) =>
    setSort((s) => (s?.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 }));
  const sorted = useMemo(
    () =>
      sort === null
        ? rows
        : [...rows].sort((a, b) => compare(rank(a, sort.key), rank(b, sort.key)) * sort.dir),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rank/compare are stable per table
    [rows, sort],
  );
  return { sorted, sort, toggle };
}

/**
 * Table styles (DESIGN.md › Components and › Tables): dense 13 px rows,
 * hairline dividers, and the column priority that lets a seven-column table
 * survive a narrow column.
 *
 * `container` goes on the element that scrolls the table, so `colLow`,
 * `colMid` and `colHigh` measure the SPACE THE TABLE HAS and not the
 * viewport: the same table sits in a 1120 px page, in a 720 px page beside
 * the sidebar and in a 480 px sheet, and only the first of those is a
 * viewport question. Thresholds and the order columns leave in are in
 * DESIGN.md › Tables.
 */
export const T = {
  table: "w-full text-[13px]",
  head: "text-left text-xs text-fg-muted",
  th: "px-3 py-2 font-medium",
  td: "px-3 py-2.5 align-middle",
  row: "border-t border-line transition-colors",
  rowHover: "group hover:bg-surface-2/70",
  /** On the wrapper that scrolls: turns it into the query container. */
  container: "@container",
  /** Lowest priority — the first column to go (container under 64rem). */
  colLow: "hidden @5xl:table-cell",
  /** Goes second (container under 56rem). */
  colMid: "hidden @4xl:table-cell",
  /** Goes last (container under 42rem). */
  colHigh: "hidden @2xl:table-cell",
  /**
   * On an `sr-only` span inside a cell: gives the word back once the table
   * has room for it. A badge that keeps its icon and drops its label is a
   * column that costs 20 px instead of 110, and the label is still in the
   * accessible name the whole time.
   */
  wordFrom: "@lg:not-sr-only",
  /**
   * The actions cell, pinned to the right edge. Past the last threshold the
   * table still scrolls sideways, and a row whose actions are off screen is
   * a row you cannot act on. The fill is the one the row wears, hover
   * included, or the pinned cell reads as a seam.
   */
  stickyEnd: "sticky right-0 bg-surface group-hover:bg-surface-2/70",
} as const;

/**
 * Clickable column header bound to `useSortableTable`.
 *
 * A column that sorts and does not say so is a feature nobody finds. The
 * affordance is an arrow and it stays inside the hairline aesthetic: the
 * active column keeps its solid `ArrowUp`/`ArrowDown` in `fg`, an inactive
 * one holds a faint `ArrowUpDown` that is drawn at `opacity-0` and fades in
 * on hover and on keyboard focus. It is in the DOM the whole time, so it
 * RESERVES its width — a label that jumps 16 px when the pointer arrives is
 * worse than no affordance at all.
 *
 * `aria-sort` on the `<th>` is the same answer for a screen reader, which
 * cannot see the arrow at all.
 */
export function SortHeader<K extends string>({
  k,
  sort,
  onToggle,
  children,
  className = "",
  right,
}: {
  k: K;
  /** `null` while the table stands in the order its rows arrived in. */
  sort: SortState<K> | null;
  onToggle: (k: K) => void;
  children: ReactNode;
  className?: string;
  right?: boolean;
}) {
  const active = sort !== null && sort.key === k;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
      className={cx(T.th, right && "text-right", className)}
    >
      <button
        type="button"
        className={cx(
          "group inline-flex items-center gap-1 rounded-sm transition-colors hover:text-fg",
          // A right-aligned column keeps its LABEL flush with the figures
          // under it, so the arrow hangs on the label's left instead of
          // pushing the word out of line with its own numbers.
          right && "flex-row-reverse",
          active && "text-fg",
        )}
        onClick={() => onToggle(k)}
      >
        {children}
        {active ? (
          sort.dir === 1 ? (
            <ArrowUp aria-hidden className="size-3 shrink-0" />
          ) : (
            <ArrowDown aria-hidden className="size-3 shrink-0" />
          )
        ) : (
          <ArrowUpDown
            aria-hidden
            className="size-3 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        )}
      </button>
    </th>
  );
}

/**
 * One column of a table, as data: its sort key, its label, and the classes
 * that decide where it goes when the table narrows.
 *
 * A column that does not sort (`sortable: false`) is a tick box or an actions
 * cell: its `key` is then only a name, never handed to `onToggle`.
 */
export type Column<K extends string> = {
  label: ReactNode;
  /** The label is for screen readers only (the actions column). */
  srOnly?: boolean;
  right?: boolean;
  /** Extra classes: a `T.col*` priority, a width, `T.stickyEnd`. */
  className?: string;
} & ({ key: K; sortable?: true } | { key: string; sortable: false });

/**
 * The whole `<thead>` of a table, from its columns as data.
 *
 * Every table used to hand-roll its head, and the two things a head carries —
 * what the columns ARE and what happens to them on a narrow page — were
 * written twice, once in the `<th>` and once in the `<td>`. Declared here,
 * a table says its columns ONCE, the head and the priority classes can no
 * longer disagree, and every table of the app sorts the same way: click the
 * label, click it again to flip it.
 */
export function TableHead<K extends string>({
  columns,
  sort,
  onToggle,
}: {
  columns: Column<K>[];
  /** `null`: the rows stand in the order they arrived in. */
  sort: SortState<K> | null;
  onToggle: (k: K) => void;
}) {
  return (
    <thead className={T.head}>
      <tr>
        {columns.map((c) =>
          c.sortable === false ? (
            <th
              key={c.key}
              scope="col"
              className={cx(T.th, c.right && "text-right", c.className)}
            >
              {c.srOnly ? <span className="sr-only">{c.label}</span> : c.label}
            </th>
          ) : (
            <SortHeader
              key={c.key}
              k={c.key}
              sort={sort}
              onToggle={onToggle}
              right={c.right}
              className={c.className}
            >
              {c.srOnly ? <span className="sr-only">{c.label}</span> : c.label}
            </SortHeader>
          ),
        )}
      </tr>
    </thead>
  );
}
