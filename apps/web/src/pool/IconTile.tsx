import type { PoolColor } from "@quiz/contracts";

import { cx, Tip } from "../ui";
import { PoolIcon } from "./PoolIcon";

/**
 * One icon of the picker. A tile is a value you switch on, so it wears the
 * `ToggleChip` language of DESIGN.md — a hairline at rest — except for its
 * pressed state: an ink (`fg`) ring on `surface-2` rather than the accent,
 * because the tile draws its icon in the pool's colour (#213) and a red
 * border around a red icon would say nothing.
 *
 * Its label is the RAW lucide name (`flask-conical`), untranslated on
 * purpose: it is an identifier, like a SHA or a tag, and in the search step
 * it is the very string the reader typed.
 */
export function IconTile({
  label,
  icon,
  color,
  fallback,
  selected,
  onPick,
}: {
  label: string;
  /** null draws the default icon, `fallback` (`PoolIcon`'s). */
  icon: string | null;
  fallback?: string;
  /** The colour being chosen, so the tile previews the result. */
  color: PoolColor | null;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        onClick={onPick}
        className={cx(
          "inline-flex size-11 items-center justify-center rounded-field border transition-colors duration-150 active:scale-97",
          selected
            ? "border-fg bg-surface-2 text-fg ring-1 ring-fg"
            : "border-line-strong bg-surface text-fg-muted hover:border-fg-faint hover:text-fg",
        )}
      >
        <PoolIcon icon={icon} color={color} fallback={fallback} className="size-5" />
      </button>
    </Tip>
  );
}
