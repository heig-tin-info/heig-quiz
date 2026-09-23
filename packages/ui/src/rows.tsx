/**
 * The list-of-rows editor of the code cases and the circuit stimuli (audit
 * P-01c): a header with its "add" button, one panel per row, a remove button
 * per panel, and the two pure list edits every editor writes.
 */
import type { ReactNode } from "react";

import { badge, button, sectionTitle } from "./styles.js";

/** The list with the row at `index` merged with `patch`; the others untouched. */
export function patchAt<T>(list: readonly T[], index: number, patch: Partial<T>): T[] {
  return list.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

/** The list without the row at `index`. */
export function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** The heading of a list section: its title, a count badge, and "add" on the right. */
export function RowListHeader({
  title,
  count,
  addLabel,
  onAdd,
  addDisabled,
}: {
  title: string;
  /** Already worded ("3 points"). */
  count: string;
  addLabel: string;
  onAdd: () => void;
  addDisabled?: boolean | undefined;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className={sectionTitle}>{title}</h3>
      <span className={badge()}>{count}</span>
      <button
        type="button"
        className={button("secondary", "sm", "ml-auto")}
        disabled={addDisabled}
        onClick={onAdd}
      >
        {addLabel}
      </button>
    </div>
  );
}

/**
 * One PANEL per row, not one table row: a row that carries ten fields is not
 * a table a teacher can read at 1440 px, and a panel gives each its heading
 * and a few short lines (DESIGN.md, tables). Rows are keyed by position — the
 * lists are short, and their order is what the teacher edits.
 */
export function RowList<T>({
  items,
  children,
}: {
  items: readonly T[];
  children: (item: T, index: number) => ReactNode;
}): ReactNode {
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item, i) => (
        <li key={i} className="rounded-card border border-line bg-surface-2 p-3">
          {children(item, i)}
        </li>
      ))}
    </ol>
  );
}

/** The quiet "×" of a row; `label` names the row ("Remove the case sum"). */
export function RemoveRowButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean | undefined;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={button("ghost", "sm")}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      ×
    </button>
  );
}
