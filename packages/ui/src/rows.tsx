/**
 * The list-of-rows editor of the code cases and the circuit stimuli (audit
 * P-01c): a header with its "add" button, one panel per row, a remove button
 * per panel, and the two pure list edits every editor writes.
 */
import type { ReactNode } from "react";

import { CheckboxField, FieldCell, NumberField } from "./fields.js";
import { badge, sectionTitle } from "./styles.js";
import { Button, IconButton, TextInput } from "./controls.js";
import { CloseIcon } from "./icon.js";

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
      <Button
        size="sm"
        className="ml-auto"
        disabled={addDisabled}
        onClick={onAdd}
      >
        {addLabel}
      </Button>
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
    <IconButton danger label={label} disabled={disabled} onClick={onClick}>
      <CloseIcon />
    </IconButton>
  );
}

/**
 * The first line of a row panel, the same in every list of weighted rows
 * (audit P-15): the row's name, its points, whatever the type adds beside
 * them (`children`: a time budget), "Hidden" and the remove button. A list
 * without hidden rows (an essay's criteria) leaves the "Hidden" props out.
 *
 * "Hidden" is the inverse of the stored `visible` flag — the word a teacher
 * ticks is the exception, not the rule — so the component takes `visible`
 * and hands back `visible`, and no caller writes the negation.
 */
export function RowHead({
  disabled,
  nameId,
  nameLabel,
  nameAriaLabel,
  name,
  nameMaxLength,
  onNameChange,
  pointsId,
  pointsLabel,
  pointsAriaLabel,
  points,
  pointsMin = 0,
  pointsMax,
  pointsStep = 0.5,
  onPointsChange,
  hiddenLabel,
  hiddenAriaLabel,
  visible,
  onVisibleChange,
  removeLabel,
  removeDisabled,
  onRemove,
  children,
}: {
  disabled?: boolean | undefined;
  nameId: string;
  /** The row's caption ("Case 2"). */
  nameLabel: string;
  /** The name field's accessible name ("Name 2"). */
  nameAriaLabel: string;
  name: string;
  nameMaxLength?: number | undefined;
  onNameChange: (name: string) => void;
  pointsId: string;
  pointsLabel: string;
  pointsAriaLabel?: string | undefined;
  points: number;
  /** The points field's range and step: `0`, none and `0.5` by default; an integer weight passes `1`, `100`, `1`. */
  pointsMin?: number | undefined;
  pointsMax?: number | undefined;
  pointsStep?: number | undefined;
  onPointsChange: (points: number) => void;
  /** All four or none: a list whose rows cannot be hidden shows no "Hidden". */
  hiddenLabel?: string | undefined;
  hiddenAriaLabel?: string | undefined;
  visible?: boolean | undefined;
  onVisibleChange?: ((visible: boolean) => void) | undefined;
  removeLabel: string;
  removeDisabled?: boolean | undefined;
  onRemove: () => void;
  /** Cells of the type's own, between the points and "Hidden". */
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <FieldCell label={nameLabel} htmlFor={nameId} className="min-w-40 flex-1">
        <TextInput
          id={nameId}
          size="sm"
          className="w-full font-medium"
          aria-label={nameAriaLabel}
          maxLength={nameMaxLength}
          disabled={disabled}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
        />
      </FieldCell>
      <NumberField
        id={pointsId}
        label={pointsLabel}
        aria-label={pointsAriaLabel}
        value={points}
        min={pointsMin}
        max={pointsMax}
        step={pointsStep}
        width="w-20"
        disabled={disabled}
        onChange={onPointsChange}
      />
      {children}
      {hiddenLabel === undefined || onVisibleChange === undefined ? null : (
        <CheckboxField
          className="flex h-7 items-center gap-2 text-[13px] text-fg-muted"
          label={hiddenLabel}
          aria-label={hiddenAriaLabel}
          checked={visible === false}
          disabled={disabled}
          onChange={(hidden) => onVisibleChange(!hidden)}
        />
      )}
      <RemoveRowButton label={removeLabel} disabled={removeDisabled} onClick={onRemove} />
    </div>
  );
}
