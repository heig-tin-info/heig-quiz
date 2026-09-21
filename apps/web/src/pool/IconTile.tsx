import { cx, Tip } from "../ui";
import { PoolIcon } from "./PoolIcon";

/**
 * One icon of the picker. A tile is a value you switch on, so it wears the
 * `ToggleChip` language of DESIGN.md — hairline pill at rest, `accent-soft`
 * on an `accent` border when it is the current one.
 *
 * Its label is the RAW lucide name (`flask-conical`), untranslated on
 * purpose: it is an identifier, like a SHA or a tag, and in the search step
 * it is the very string the reader typed.
 */
export function IconTile({
  label,
  icon,
  selected,
  onPick,
}: {
  label: string;
  /** null draws the default icon. */
  icon: string | null;
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
          "inline-flex size-11 items-center justify-center rounded-[10px] border transition-colors duration-150 active:scale-97",
          selected
            ? "border-accent bg-accent-soft text-accent"
            : "border-line-strong bg-surface text-fg-muted hover:border-fg-faint hover:text-fg",
        )}
      >
        <PoolIcon icon={icon} className="size-5" />
      </button>
    </Tip>
  );
}
