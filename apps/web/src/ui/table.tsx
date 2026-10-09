import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { table } from "@quiz/ui";

import { cx } from "./layers";

// Sortable tables: one motif for every hand-rolled table.

export interface SortState<K extends string> {
  key: K;
  dir: 1 | -1;
}

const defaultCompare = (x: string | number, y: string | number) =>
  typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));

/** The comparator of a table of people: numbers as numbers, names regardless of case and accents. */
export const caseInsensitiveCompare = (x: string | number, y: string | number) =>
  typeof x === "number" && typeof y === "number"
    ? x - y
    : String(x).localeCompare(String(y), undefined, { sensitivity: "base" });

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
 * `T.stack`, the row-card mode of a table (DESIGN.md › Tables › Row cards): under a
 * 28 rem container — a phone — each row becomes a two-line card instead of a
 * row that scrolls sideways. A table opts in with `stack.table` on the
 * `<table>` and `stack.row` on every row (the head's included), then gives
 * each visible cell its ROLE:
 *
 * - `lead`  the tick box, first on the first line;
 * - `main`  the identity column, the rest of the first line (it truncates);
 * - `end`   the row's actions, last on the first line, always reachable;
 * - `sub`   the status and the one number that matter, on the second line.
 *
 * The cells the column priority already hid stay hidden; a cell with no role
 * goes on the second line too. In the head only `lead`, `main` and `end`
 * remain (the select-all box and the main sort), the `sub` headers step
 * aside (`Column.stack`). A full-width band (a group's label) takes
 * `stack.band` on its row and its cell. The table, its row groups, rows and
 * cells carry explicit ARIA roles (`role="table"`, …): a `display` that is
 * no longer `table` makes some screen readers drop the semantics, and a cell
 * whose header the card hides names itself (an `sr-only` label). From 28 rem the classes do nothing:
 * the desktop table is untouched.
 */
const stack = {
  table: "@max-md:block @max-md:[&>tbody]:block @max-md:[&>thead]:block",
  /**
   * A flex row that wraps: the `::after` is a full-width item ordered between
   * the first line and the `sub` cells, so it is what breaks the line.
   */
  row: "@max-md:flex @max-md:flex-wrap @max-md:items-center @max-md:after:order-1 @max-md:after:basis-full @max-md:after:content-['']",
  /** 2 px after the tick box: with the identity's 12 px, its 44 px touch area stops short of the next control. */
  lead: "@max-md:shrink-0 @max-md:pr-0.5 @max-md:pb-1",
  main: "@max-md:min-w-0 @max-md:flex-1 @max-md:truncate @max-md:pb-1",
  end: "@max-md:static @max-md:ml-auto @max-md:shrink-0 @max-md:pb-1",
  /** The second line: small, muted, under the identity. */
  sub: "@max-md:order-2 @max-md:pt-0 @max-md:pb-2 @max-md:text-xs",
  /** The second line's first cell, under a row that has a `lead`: aligned on the identity. */
  subIndent: "@max-md:order-2 @max-md:pt-0 @max-md:pb-2 @max-md:pl-10.5 @max-md:text-xs",
  band: "@max-md:block",
  /** A `sub` column's header: the card has no head line for it. */
  subHead: "@max-md:hidden",
} as const;

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
  // The cells are `@quiz/ui`'s, which the question types' tables wear too.
  ...table,
  row: `${table.row} transition-colors`,
  rowHover: "group hover:bg-surface-2/70",
  /**
   * On the wrapper that scrolls: turns it into the query container. It is
   * also the containing block of what is positioned inside the table — an
   * `sr-only` label is `absolute`, and without a positioned scroller it is
   * placed against the page, past the scroller's clip, and widens the whole
   * page on a phone.
   */
  container: "relative @container",
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
  /** The row-card mode under a 28 rem container (see `stack` above). */
  stack,
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
function SortHeader<K extends string>({
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
      role="columnheader"
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
            className="hover-reveal size-3 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        )}
      </button>
    </th>
  );
}

/**
 * The label row of a group, when a list is cut by a "Group by" (the pool's
 * questions, a classroom's evaluations): a full-width band on `surface-2`,
 * the group's name in a 12 px uppercase eyebrow and its row count beside it.
 * It opens the group's own `<tbody>`, so a table cut in groups is a run of
 * row groups, each headed by its band. `stacked`: the table is a row-card
 * table (`T.stack`), where the band must turn into a block with its rows; in
 * a plain table that block would shrink it to one column.
 */
export function TableBand({
  span,
  label,
  count,
  stacked = false,
}: {
  span: number;
  label: ReactNode;
  count: number;
  stacked?: boolean;
}) {
  return (
    <tr role="row" className={stacked ? stack.band : undefined}>
      <td
        role="cell"
        colSpan={span}
        className={cx(
          stacked && stack.band,
          "border-t border-line bg-surface-2 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted",
        )}
      >
        {label}
        <span className="ml-2 tabular-nums text-fg-faint">{count}</span>
      </td>
    </tr>
  );
}

/**
 * One column of a table, as data: its sort key, its label, and the classes
 * that decide where it goes when the table narrows.
 *
 * A column that does not sort (`sortable: false`) is a tick box or an actions
 * cell: its `key` is then only a name, never handed to `onToggle`. In a
 * table that does not sort at all (no `onToggle`), every key is a name.
 */
export type Column<K extends string> = {
  label: ReactNode;
  /** The label is for screen readers only (the actions column). */
  srOnly?: boolean;
  right?: boolean;
  /** Extra classes: a `T.col*` priority, a width, `T.stickyEnd`. */
  className?: string;
  /** Its role in the row-card mode (`stack`), when the table opts in. */
  stack?: "lead" | "main" | "end" | "sub";
} & ({ key: K; sortable?: true } | { key: string; sortable: false });

/**
 * The whole `<thead>` of a table, from its columns as data.
 *
 * Every table used to hand-roll its head, and the two things a head carries —
 * what the columns ARE and what happens to them on a narrow page — were
 * written twice, once in the `<th>` and once in the `<td>`. Declared here,
 * a table says its columns ONCE, the head and the priority classes can no
 * longer disagree, and every table of the app sorts the same way: click the
 * label, click it again to flip it. A table that does not sort leaves out
 * `sort` and `onToggle`, and its head is the same labels, scoped the same
 * way, with no button.
 */
export function TableHead<K extends string>({
  columns,
  sort = null,
  onToggle,
}: {
  columns: Column<K>[];
} & (
  | {
      /** `null`: the rows stand in the order they arrived in. */
      sort: SortState<K> | null;
      onToggle: (k: K) => void;
    }
  // A table that does not sort: no column is a button.
  | { sort?: never; onToggle?: never }
)) {
  const stacked = columns.some((c) => c.stack !== undefined);
  const role = (c: Column<K>) =>
    c.stack === undefined ? undefined : c.stack === "sub" ? stack.subHead : stack[c.stack];
  return (
    // Explicit roles: a row-card table changes `display`, and some screen
    // readers (VoiceOver) drop a table's semantics with it.
    <thead role="rowgroup" className={T.head}>
      <tr role="row" className={stacked ? stack.row : undefined}>
        {columns.map((c) =>
          c.sortable === false || onToggle === undefined ? (
            <th
              key={c.key}
              scope="col"
              role="columnheader"
              className={cx(T.th, c.right && "text-right", c.className, role(c))}
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
              className={cx(c.className, role(c))}
            >
              {c.srOnly ? <span className="sr-only">{c.label}</span> : c.label}
            </SortHeader>
          ),
        )}
      </tr>
    </thead>
  );
}
