import { useId, useState } from "react";

import { QUESTION_TYPE_GROUPS, type QuestionTypeGroup } from "@quiz/core/client";
import { useMediaQuery } from "@quiz/ui";

import { useT } from "../i18n";
import { typeGroup, typeHint, typeIcon, typeLabel } from "../questionTypes";
import { cx, rovingIndex, TabPanel, Tabs, usePersistentChoice } from "../ui";

/**
 * "Which kind of question?" as a grid of tiles rather than a `Select`.
 *
 * A type is not a setting with a default a teacher tweaks — it decides what
 * the whole editor looks like — so it wears the `ToggleChip` language
 * (hairline at rest, `accent-soft` on an `accent` border when it is the
 * current one) at tile size, with the one-line hint that names what each type
 * actually is. Each tile is a real `aria-pressed` button, so the state and
 * the label are never separated. The arrows move the focus from tile to
 * tile, row by row.
 *
 * From `sm` up a tile is a column: the icon in a 48 px well, large enough to
 * recognise the type before reading its name, over the name and the hint;
 * the grid has three or four columns, whichever leaves the fewest empty
 * cells on the last row (`columnsFor`). On a phone a tile is a list row, the
 * icon in a 36 px well beside the text, so a dozen types fit without a wall
 * of half-empty cards (#991).
 *
 * `grouped` files the types under their family (`group`, metadata of each
 * type, #991) as tabs when the screen is too small for all of them at once,
 * or when there are more than a dozen (`pickerLayout`). The last tab used is
 * remembered per browser.
 *
 * It was the inside of `NewQuestionModal`; the poll launcher needs the same
 * grid over a SUBSET of the types (a poll runs `mcq`, `short` and
 * `brainstorm`, three tiles that need no tabs), and two copies of a tile
 * would be two chances to disagree about what a type is called. Hence
 * `types`: the caller says which ones exist here.
 */
export function QuestionTypePicker({
  types,
  value,
  onChange,
  grouped = false,
  className = "",
}: {
  /** The types on offer, in the order they are drawn. */
  types: readonly string[];
  /** The current type; `""` when none is chosen yet. */
  value: string;
  onChange: (type: string) => void;
  /** Tabs by family where the screen asks for them; otherwise one flat grid. */
  grouped?: boolean;
  className?: string;
}) {
  const t = useT();
  const idPrefix = useId();
  const large = useMediaQuery(LARGE_SCREEN);
  const groups = groupTypes(types);
  const ids = groups.map((g) => g.group);
  const [remembered, remember] = usePersistentChoice(TAB_KEY, QUESTION_TYPE_GROUPS, ids[0] ?? "basics");
  // The chosen type's family first ("Back" from the name, the palette's
  // typed entry), then the tab last used, then the first.
  const [picked, setPicked] = useState<QuestionTypeGroup | null>(() => typeGroup(value) ?? null);
  const wanted = picked ?? remembered;
  const tab = ids.includes(wanted) ? wanted : (ids[0] ?? "basics");

  if (!grouped || pickerLayout(types.length, groups.length, large) === "grid") {
    return <TileGrid types={types} value={value} onChange={onChange} even className={className} />;
  }
  const shown = groups.find((g) => g.group === tab)?.types ?? [];
  return (
    <div className={className}>
      <Tabs
        value={tab}
        onChange={(next) => {
          setPicked(next);
          remember(next);
        }}
        items={groups.map((g) => ({ value: g.group, label: t(`qt.group.${g.group}`) }))}
        idPrefix={idPrefix}
        label={t("pool.questionType")}
        className="mb-3"
      />
      <TabPanel idPrefix={idPrefix} value={tab}>
        <TileGrid types={shown} value={value} onChange={onChange} />
      </TabPanel>
    </div>
  );
}

/** The browser remembers the last tab here (a habit, never data). */
const TAB_KEY = "quiz-question-type-tab";

/** Room enough to show every type at once without scrolling the dialog. */
const LARGE_SCREEN = "(min-width: 1000px) and (min-height: 950px)";

/** The most types a large screen shows as one flat grid. */
const FLAT_MAX = 12;

/**
 * Flat grid or tabs (#991): one family only is always the grid; otherwise a
 * large screen shows up to a dozen types flat, and anything smaller, or more
 * types, gets tabs.
 */
export function pickerLayout(count: number, groups: number, large: boolean): "grid" | "tabs" {
  if (groups <= 1) return "grid";
  return large && count <= FLAT_MAX ? "grid" : "tabs";
}

/**
 * `types` filed by family, families in `QUESTION_TYPE_GROUPS` order, types in
 * the caller's order; an empty family is left out.
 */
export function groupTypes(
  types: readonly string[],
): { group: QuestionTypeGroup; types: string[] }[] {
  return QUESTION_TYPE_GROUPS.map((group) => ({
    group,
    types: types.filter((id) => (typeGroup(id) ?? "basics") === group),
  })).filter((g) => g.types.length > 0);
}

function TileGrid({
  types,
  value,
  onChange,
  even = false,
  className = "",
}: {
  types: readonly string[];
  value: string;
  onChange: (type: string) => void;
  /**
   * Every row as tall as the tallest of the grid (`auto-rows-fr`): the flat
   * grid of a large screen, which shows every type at once. Under tabs a
   * row takes its own content's height.
   */
  even?: boolean;
  className?: string;
}) {
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
      className={cx("grid grid-cols-1 gap-2", even && "auto-rows-fr", WIDE_COLUMNS[columnsFor(types.length)], className)}
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
              "group flex min-h-11 items-center gap-3 rounded-field border px-3 py-2.5 text-left transition-colors sm:flex-col sm:items-start sm:p-3.5",
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

/** Spelled out whole, so Tailwind sees each class. */
const WIDE_COLUMNS = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" } as const;

/**
 * The columns from `sm` up: two for a pair, otherwise three or four,
 * whichever leaves the fewest empty cells on the last row — four on a tie
 * (9 → 3, 8 → 4, 7 → 4, 12 → 4).
 */
export function columnsFor(count: number): 2 | 3 | 4 {
  if (count <= 2) return 2;
  const empty = (c: number) => (c - (count % c)) % c;
  return empty(3) < empty(4) ? 3 : 4;
}

/**
 * A type as a tile shows it: its icon in a well (36 px on a phone, 48 px
 * from `sm`), its name and its hint. The parent lays the two out (a row on a
 * phone and in the "New question" dialog's reminder of the chosen type, a
 * column in a tile from `sm`).
 */
export function TypeFace({ id, active }: { id: string; active: boolean }) {
  const t = useT();
  const Icon = typeIcon(id);
  return (
    <>
      <span
        className={cx(
          "grid size-9 shrink-0 place-items-center rounded-field transition-colors sm:size-12",
          active ? "bg-accent text-on-fill" : "bg-surface-2 text-fg-muted group-hover:bg-surface-3",
        )}
      >
        <Icon className="size-6 sm:size-8" />
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
