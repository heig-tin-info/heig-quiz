import { useT } from "../i18n";
import { typeHint, typeIcon, typeLabel } from "../questionTypes";
import { cx, rovingIndex } from "../ui";

/**
 * "Which kind of question?" as a grid of tiles rather than a `Select`.
 *
 * A type is not a setting with a default a teacher tweaks — it decides what
 * the whole editor looks like — so it wears the `ToggleChip` language
 * (hairline at rest, `accent-soft` on an `accent` border when it is the
 * current one) at tile size, with the one-line hint that names what each type
 * actually is. Each tile is a real `aria-pressed` button, so the state and
 * the label are never separated. The icon sits in a 48 px well, large enough
 * to recognise the type before reading its name; every tile of a row has the
 * height of the tallest (`auto-rows-fr`), so a long hint never makes one card
 * stick out. The arrows move the focus from tile to tile, row by row.
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
  /** The current type; `""` when none is chosen yet. */
  value: string;
  onChange: (type: string) => void;
  className?: string;
}) {
  const t = useT();
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tiles = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button")];
    const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
    const columns = getComputedStyle(e.currentTarget).gridTemplateColumns.split(" ").length;
    const next = at < 0 ? null : rovingIndex(e.key, at, tiles.length, columns);
    if (next === null) return;
    e.preventDefault();
    tiles[next]?.focus();
  };
  return (
    <div
      onKeyDown={onKeyDown}
      className={cx("grid auto-rows-fr grid-cols-2 gap-2", types.length > 3 && "sm:grid-cols-4", className)}
    >
      {types.map((id) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(id)}
            className={cx(
              "group flex flex-col items-start gap-3 rounded-field border p-3.5 text-left transition-colors",
              active
                ? "border-accent bg-accent-soft"
                : "border-line-strong bg-surface hover:bg-surface-2",
            )}
          >
            <TypeFace id={id} active={active} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A type as a tile shows it: its icon in a 48 px well, its name and its
 * hint. The parent lays the two out (a column in a tile, a row in the
 * "New question" dialog's reminder of the chosen type).
 */
export function TypeFace({ id, active }: { id: string; active: boolean }) {
  const t = useT();
  const Icon = typeIcon(id);
  return (
    <>
      <span
        className={cx(
          "grid size-12 shrink-0 place-items-center rounded-field transition-colors",
          active ? "bg-accent text-on-fill" : "bg-surface-2 text-fg-muted group-hover:bg-surface-3",
        )}
      >
        <Icon className="size-8" />
      </span>
      <span className="min-w-0">
        <span className={cx("block text-sm font-semibold", active && "text-accent")}>
          {typeLabel(t, id)}
        </span>
        <span className="mt-0.5 block text-xs text-fg-muted">{typeHint(t, id)}</span>
      </span>
    </>
  );
}
