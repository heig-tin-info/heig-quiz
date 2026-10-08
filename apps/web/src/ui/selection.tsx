import { X } from "lucide-react";
import type { ReactNode } from "react";

import { useT } from "../i18n";
import { IconButton, Z } from "./layers";

/**
 * What to do with the ticked rows of a list: a floating bar that exists only
 * while a selection does (the pool's questions, the tags being sorted). It is
 * the one place of such a screen allowed a shadow — it genuinely sits above
 * the table. A caller may hide it while a layer of its own is open: it
 * sits above that layer's backdrop too.
 *
 * 54 rem: 40 held three actions, 48 the fourth, and the pool's fifth pushed
 * the close button onto a second line — a pill bar that wraps reads as two
 * bars. The radius is 28 px rather than `full`: on one line the browser
 * clamps it to half the height, so the pill is unchanged, and on a phone,
 * where the actions really do wrap, the bar stays a rounded rectangle instead
 * of becoming a lens (DESIGN.md › Shape).
 *
 * `notices` stand above the bar, on an opaque surface: the `-soft` tints of
 * an `Alert` are translucent in dark mode, and the table would show through.
 * `end` is pushed to the right, before the close button: the bar's primary
 * action, when it has one. `data-bulk-bar` makes the docked tools step aside
 * on a phone (`style.css`).
 */
export function SelectionBar({
  label,
  onClear,
  notices,
  end,
  children,
}: {
  /** "3 selected": written first, and the bar's accessible name. */
  label: string;
  onClear: () => void;
  notices?: ReactNode;
  end?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div
      data-bulk-bar
      className={`fixed inset-x-0 bottom-[calc(1rem+var(--bottom-nav-h))] mx-auto flex w-[min(54rem,calc(100%-2rem))] flex-col gap-2 ${Z.popover}`}
    >
      {notices ? <div className="flex flex-col gap-2 rounded-card bg-surface shadow-overlay">{notices}</div> : null}
      <div
        role="region"
        aria-label={label}
        className="flex flex-wrap items-center gap-2 rounded-[28px] border border-line bg-surface px-4 py-2 shadow-overlay"
      >
        <span className="text-[13px] font-medium tabular-nums">{label}</span>
        {children}
        <span className="ml-auto flex items-center gap-1">
          {end}
          <IconButton label={t("common.clearSelection")} onClick={onClear}>
            <X />
          </IconButton>
        </span>
      </div>
    </div>
  );
}
