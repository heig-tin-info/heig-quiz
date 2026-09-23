import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";

import { cx, listboxIndex, Z } from "./layers";

/**
 * How long a picker's list outlives the blur of its input: a click on a row
 * fires after the blur, and the list must still be there when it lands.
 */
const BLUR_GRACE = 120;

export interface ComboboxOptions {
  /** The rows the list holds right now. */
  count: number;
  /** A row was chosen, by Enter or by a click. Closing is the caller's call. */
  onPick: (index: number) => void;
  /** The text the rows are filtered by: a new one starts the highlight over. */
  query?: string;
  /**
   * A COMPLETION list rather than a picker: it follows the text, not the
   * focus. It shows while there is something to complete and nobody
   * dismissed it, the focus and the arrows do not open it, the blur closes it
   * at once, and Escape stops there instead of reaching the page.
   */
  completion?: boolean;
  /** A fixed id for the list, when a page names it; `useId` otherwise. */
  listId?: string;
  /** The id of row `index`; `<listId>-option-<index>` otherwise. */
  optionId?: (index: number) => string;
  /**
   * The open flag as a `useState` pair the caller holds, when it needs the
   * flag before it has the rows — the teacher picker fetches only while its
   * list is open, and `count` comes from that fetch.
   */
  state?: [boolean, (open: boolean) => void];
}

export interface Combobox {
  /** The list is showing. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The highlighted row, always inside the list. */
  active: number;
  /** An id for the input, for a `<label htmlFor>`. */
  inputId: string;
  inputProps: {
    role: "combobox";
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    "aria-activedescendant": string | undefined;
    "aria-autocomplete": "list";
    onFocus: (() => void) | undefined;
    onBlur: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  };
  listProps: { id: string; role: "listbox" };
  optionProps: (index: number) => {
    id: string;
    role: "option";
    "aria-selected": boolean;
    onMouseMove: () => void;
    onMouseDown: (e: { preventDefault: () => void }) => void;
    onClick: () => void;
  };
}

/**
 * The ARIA combobox with virtual focus, written once for the tag field, the
 * teacher picker and the pool search (DESIGN.md › Combobox): the caret never
 * leaves the input, the highlighted row travels through
 * `aria-activedescendant`, the arrows wrap through `listboxIndex` and leave
 * Home/End to the caret. What stays at the call site is what differs there:
 * the fetching, the rows' markup, whether a pick closes the list, and any key
 * of its own (the tag field's comma and Backspace), handled before handing
 * the event to `inputProps.onKeyDown`.
 */
export function useCombobox({
  count,
  onPick,
  query,
  completion = false,
  listId: fixedListId,
  optionId: fixedOptionId,
  state,
}: ComboboxOptions): Combobox {
  const uid = useId();
  const listId = fixedListId ?? `${uid}-list`;
  const optionId = fixedOptionId ?? ((i: number) => `${uid}-option-${i}`);
  // For a completion list this is "not dismissed"; what shows is `open`.
  const own = useState(completion);
  const [wanted, setWanted] = state ?? own;
  const [highlight, setHighlight] = useState(0);
  const open = wanted && (!completion || count > 0);
  const active = count > 0 ? Math.min(highlight, count - 1) : 0;

  useEffect(() => setHighlight(0), [query, wanted]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      if (completion) e.stopPropagation();
      setWanted(false);
      return;
    }
    if (completion && !open) return;
    const next = listboxIndex(e.key, active, count);
    if (next !== null) {
      e.preventDefault();
      setWanted(true);
      setHighlight(next);
    } else if (e.key === "Enter" && open && count > 0) {
      e.preventDefault();
      onPick(active);
    }
  };

  return {
    open,
    setOpen: setWanted,
    active,
    inputId: `${uid}-input`,
    inputProps: {
      role: "combobox",
      "aria-expanded": open,
      "aria-controls": completion && !open ? undefined : listId,
      "aria-activedescendant": open && count > 0 ? optionId(active) : undefined,
      "aria-autocomplete": "list",
      onFocus: completion ? undefined : () => setWanted(true),
      onBlur: completion
        ? () => setWanted(false)
        : () => window.setTimeout(() => setWanted(false), BLUR_GRACE),
      onKeyDown,
    },
    listProps: { id: listId, role: "listbox" },
    optionProps: (index) => ({
      id: optionId(index),
      role: "option",
      "aria-selected": index === active,
      // `mousemove` and not `mouseenter`: an arrow key can scroll a row under
      // a motionless cursor, which must not steal the highlight back.
      onMouseMove: () => setHighlight(index),
      // The input keeps the focus, so the blur does not close the list under
      // the cursor before the click lands.
      onMouseDown: (e) => e.preventDefault(),
      onClick: () => onPick(index),
    }),
  };
}

/**
 * The floating panel under a combobox's input: a `menu`-radius surface with
 * the popover shadow, above the dialog layer, capped at 288 px and scrolling
 * past it. As wide as the field unless `place` says otherwise (the pool
 * search's list is 288 px under a field that spans the toolbar).
 */
export function ComboboxList({
  combobox,
  label,
  place = "left-0 right-0",
  children,
}: {
  combobox: Combobox;
  /** What the rows are, for a screen reader ("Suggestions", "Teachers"). */
  label: string;
  place?: string;
  children: ReactNode;
}) {
  return (
    <div
      {...combobox.listProps}
      aria-label={label}
      className={cx(
        "absolute top-full mt-1 max-h-72 overflow-y-auto rounded-menu border border-line bg-surface p-1 shadow-popover",
        place,
        Z.popover,
      )}
    >
      {children}
    </div>
  );
}

/**
 * One row of a `ComboboxList`, in the shape every virtually focused list
 * wears (the command palette, the sidebar): 14 px, a `field`-radius row, the
 * highlighted one as the `accent-soft` chip in semibold `accent`, the others
 * `fg-muted` with a `surface-2` hover. `className` adds the row's own layout
 * (a flex row, a truncation), never a colour or a size.
 */
export function ComboboxOption({
  combobox,
  index,
  className,
  children,
}: {
  combobox: Combobox;
  index: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      {...combobox.optionProps(index)}
      className={cx(
        "cursor-pointer rounded-field px-2.5 py-1.5 text-sm",
        index === combobox.active
          ? "bg-accent-soft font-semibold text-accent"
          : "text-fg-muted hover:bg-surface-2 hover:text-fg",
        className,
      )}
    >
      {children}
    </div>
  );
}
