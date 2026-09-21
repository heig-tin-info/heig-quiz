import { useT } from "../i18n";
import { typeHint, typeIcon, typeLabel } from "../questionTypes";
import { cx } from "../ui";

/**
 * "Which kind of question?" as a grid of tiles rather than a `Select`.
 *
 * A type is not a setting with a default a teacher tweaks — it decides what
 * the whole editor looks like — so it wears the `ToggleChip` language
 * (hairline at rest, `accent-soft` on an `accent` border when it is the
 * current one) at tile size, with the one-line hint that names what each type
 * actually is. Each tile is a real `aria-pressed` button, so the state and
 * the label are never separated.
 *
 * It was the inside of `NewQuestionModal`; the poll launcher needs the same
 * grid over a SUBSET of the types (a poll runs `mcq` and `short` only), and
 * two copies of a tile would be two chances to disagree about what a type is
 * called. Hence `types`: the caller says which ones exist here.
 */
export function QuestionTypePicker({
  types,
  value,
  onChange,
  className = "",
}: {
  /** The types on offer, in the order they are drawn. */
  types: readonly string[];
  value: string;
  onChange: (type: string) => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cx("grid gap-2 sm:grid-cols-2", className)}>
      {types.map((id) => {
        const Icon = typeIcon(id);
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(id)}
            className={cx(
              "flex items-start gap-2.5 rounded-field border p-3 text-left transition-colors",
              active
                ? "border-accent bg-accent-soft"
                : "border-line-strong bg-surface hover:bg-surface-2",
            )}
          >
            <Icon className={cx("mt-0.5 size-4 shrink-0", active ? "text-accent" : "text-fg-faint")} />
            <span className="min-w-0">
              <span className={cx("block text-sm font-medium", active && "text-accent")}>
                {typeLabel(t, id)}
              </span>
              <span className="block text-xs text-fg-muted">{typeHint(t, id)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
