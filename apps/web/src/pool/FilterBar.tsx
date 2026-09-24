import { LayoutGrid, List, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { fuzzyFilter } from "../fuzzy";
import { useT } from "../i18n";
import { typeIcon, typeLabel, QUESTION_TYPE_IDS } from "../questionTypes";
import {
  Badge,
  Button,
  ComboboxList,
  ComboboxOption,
  SearchInput,
  Segmented,
  Sheet,
  Switch,
  ToggleChip,
  useCombobox,
} from "../ui";
import {
  activeFilterCount,
  resolveFilters,
  toggle,
  type QuestionFilters,
} from "./filters";
import { GROUP_BY, type GroupBy } from "./QuestionGroups";
import {
  applyCompletion,
  completionAt,
  SEARCH_TYPE_IDS,
  withoutToken,
  type Completion,
} from "./searchSyntax";

/**
 * Search, then the filters behind one button (mockup `08-pool.html`): the
 * bar of a pool screen carries one field and one secondary button, and the
 * four lists — type, tag, difficulty, deleted — live in a sheet, because
 * more than three controls in a row is a control panel, not a toolbar.
 *
 * The FIELD is a second way into the same filters, for the teacher who types
 * faster than they click: `tag:pointeurs type:code difficulty:>3 version:>1`
 * (the grammar is in `searchSyntax.ts`, and one quiet line under the field
 * says so). What it parses MERGES with what the sheet ticked — the chips
 * below the bar show the union, and removing one takes the token out of the
 * text as well as the value out of the list, so a chip never comes straight
 * back. While the caret sits right after `tag:` or `type:`, a small list of
 * the pool's own tags (or of the four types) opens under the field: arrows
 * move, Enter inserts, Escape closes.
 *
 * Inside the sheet the three lists are rows of `ToggleChip`, not rows of
 * checkboxes. A checkbox is the shape of an independent setting; these are
 * SETS of values, and "Multiple choice" beside "Short answer" beside a box
 * each collide the moment the sheet is narrower than the labels. A pill
 * carries its own bounds and wraps.
 *
 * The second row is not filtering at all: how the list is DRAWN (cards or
 * table) and how it is CUT (group by), plus how many questions the search
 * matches. It is one size down, the way the courses page carries its own view
 * switch — those are the reader's habits, not the data's state, and they must
 * not compete with the field above them.
 *
 * The ORDER has no control here: the table's column headers are what sorts,
 * and the cards follow the same sort (newest change first until a header is
 * clicked). A second sort control beside the headers said the same thing
 * twice, and the teachers asked for it to go.
 *
 * The count is the API's `total` — every question the search, the filters
 * and the category match — and not the rows loaded so far: a list of 25 with
 * "Load more" under it is still a list of 42.
 *
 * Both controls are `Segmented`, not a select and a switch: a row of pills
 * shows the whole (short, known) set and the current one at a glance, which
 * is what a habit control is for. The caption before the grouping track is
 * also the `aria-label` of its radiogroup.
 */
const DIFFICULTIES = [1, 2, 3, 4, 5];

/** How many tag chips the sheet shows before "Show all (N)". */
const TAG_LIMIT = 20;

/** How many suggestions the `tag:` / `type:` popover offers at once. */
const COMPLETION_LIMIT = 8;

export type ListView = "cards" | "list";

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const t = useT();
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-3 pl-2.5 pr-1 text-xs font-medium text-fg-muted">
      {label}
      <button
        type="button"
        aria-label={`${t("pool.filter.clear")} — ${label}`}
        onClick={onRemove}
        className="rounded-full p-0.5 text-fg-faint transition-colors hover:bg-line-strong hover:text-fg"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/**
 * The tags of the pool as chips, with a search above them.
 *
 * A pool of a few hundred questions has more tags than a sheet can hold, so
 * the list is capped at twenty and the field searches ALL of them, fuzzily:
 * a teacher who knows the tag types three letters instead of scrolling a
 * wall. The selected ones are always in the list, and first — a filter you
 * cannot see in the panel that sets it is a filter you cannot take off.
 */
function TagChips({
  tags,
  selected,
  onToggle,
}: {
  tags: string[];
  selected: string[];
  onToggle: (tag: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const ordered = useMemo(() => {
    const matches = fuzzyFilter(query, tags, (tag) => tag);
    const picked = matches.filter((tag) => selected.includes(tag));
    return [...picked, ...matches.filter((tag) => !selected.includes(tag))];
  }, [query, tags, selected]);
  const shown = showAll ? ordered : ordered.slice(0, TAG_LIMIT);
  const hidden = ordered.length - shown.length;

  return (
    <div className="space-y-2.5">
      <SearchInput
        className="w-full"
        aria-label={t("pool.filter.tagSearch")}
        placeholder={t("pool.filter.tagSearch")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter takes the first match: the fastest way through a long list
          // is to type it, and a search that answers nothing to Enter makes
          // the reader reach for the mouse anyway.
          if (e.key !== "Enter") return;
          e.preventDefault();
          const first = ordered[0];
          if (first !== undefined) onToggle(first);
        }}
      />
      {ordered.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("pool.filter.noTag")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {shown.map((tag) => (
            <ToggleChip
              key={tag}
              label={`#${tag}`}
              pressed={selected.includes(tag)}
              onToggle={() => onToggle(tag)}
            />
          ))}
          {hidden > 0 ? (
            <ToggleChip
              label={t("common.showAll", { n: ordered.length })}
              onToggle={() => setShowAll(true)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

interface Suggestion {
  value: string;
  label: string;
}

/**
 * The search field, plus the completion list that opens on `tag:` / `type:`.
 *
 * The list is virtually focused, like the command palette: the focus never
 * leaves the input (typing must keep working), the rows are out of the Tab
 * order and `aria-activedescendant` carries the selection. It is a floating
 * layer, so it is the one thing here allowed a shadow.
 */
function SearchBox({
  value,
  onChange,
  tags,
}: {
  value: string;
  onChange: (next: string) => void;
  tags: string[];
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const listId = "pool-search-completions";

  const at: Completion | null = completionAt(value, caret);
  const options = useMemo<Suggestion[]>(() => {
    if (!at) return [];
    const all: Suggestion[] =
      at.kind === "tag"
        ? tags.map((tag) => ({ value: tag, label: `#${tag}` }))
        : SEARCH_TYPE_IDS.map((id) => ({ value: id, label: typeLabel(t, id) }));
    return fuzzyFilter(at.prefix, all, (s) => `${s.value} ${s.label}`).slice(0, COMPLETION_LIMIT);
  }, [at, tags, t]);

  const sync = (el: HTMLInputElement) => setCaret(el.selectionStart ?? el.value.length);

  const pick = (suggestion: Suggestion) => {
    if (!at) return;
    const next = applyCompletion(value, at, suggestion.value);
    onChange(next.text);
    combo.setOpen(false);
    // The caret belongs after the value the pick inserted, not at the end of
    // a field the teacher may still be writing the middle of.
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const combo = useCombobox({
    count: options.length,
    onPick: (index) => pick(options[index]!),
    query: value,
    completion: true,
    listId,
    optionId: (index) => `${listId}-${options[index]!.value}`,
  });

  return (
    <div className="relative min-w-0 flex-1">
      <SearchInput
        ref={input}
        className="w-full"
        aria-label={t("pool.search")}
        placeholder={t("pool.search")}
        data-coach="pool.search"
        {...combo.inputProps}
        value={value}
        onChange={(e) => {
          combo.setOpen(true);
          onChange(e.target.value);
          sync(e.target);
        }}
        onClick={(e) => sync(e.currentTarget)}
        onKeyUp={(e) => sync(e.currentTarget)}
      />
      {combo.open ? (
        <ComboboxList
          combobox={combo}
          label={t(at?.kind === "type" ? "pool.filter.type" : "pool.filter.tag")}
          place="left-0 w-72 max-w-full"
        >
          {options.map((option, i) => (
            <ComboboxOption key={option.value} combobox={combo} index={i} className="truncate">
              {option.label}
            </ComboboxOption>
          ))}
        </ComboboxList>
      ) : null}
    </div>
  );
}

export function FilterBar({
  filters,
  onChange,
  tags,
  total,
  view,
  onView,
  group,
  onGroup,
}: {
  filters: QuestionFilters;
  onChange: (next: QuestionFilters) => void;
  /** Every tag used in this pool, as the API reports them. */
  tags: string[];
  /** How many questions the search matches (the API's `total`); `null` while unknown. */
  total: number | null;
  view: ListView;
  onView: (next: ListView) => void;
  group: GroupBy;
  onGroup: (next: GroupBy) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);
  const resolved = resolveFilters(filters);
  const set = (patch: Partial<QuestionFilters>) => onChange({ ...filters, ...patch });

  /**
   * Removing a chip takes the value off the list AND out of the search text:
   * the chip stands for the union of the two, so taking it off one side only
   * would put it straight back.
   */
  const dropType = (id: string) =>
    set({ types: filters.types.filter((x) => x !== id), q: withoutToken(filters.q, "type", id) });
  const dropTag = (tag: string) =>
    set({ tags: filters.tags.filter((x) => x !== tag), q: withoutToken(filters.q, "tag", tag) });
  const dropDifficulty = (d: number) =>
    set({
      difficulties: filters.difficulties.filter((x) => x !== d),
      q: withoutToken(filters.q, "difficulty", String(d)),
    });
  const dropVersion = () =>
    set({ versionMin: null, versionMax: null, q: withoutToken(filters.q, "version") });

  const versionLabel = () => {
    const { versionMin: min, versionMax: max } = resolved;
    if (min !== null && max !== null) {
      return min === max
        ? t("pool.version.is", { n: min })
        : t("pool.version.between", { min, max });
    }
    return min !== null ? t("pool.version.from", { n: min }) : t("pool.version.upTo", { n: max! });
  };

  /**
   * Two icons and no words: the choice is between two pictures of the same
   * list, and a pair of labels beside them would weigh more than the switch.
   */
  const viewOption = (value: ListView, icon: ReactNode, label: string) => ({
    value,
    label: (
      <span title={label} className="flex items-center">
        {icon}
        <span className="sr-only">{label}</span>
      </span>
    ),
  });

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={filters.q} onChange={(q) => set({ q })} tags={tags} />
        {/* Default size (md, 34 px) on purpose: `SearchInput` is `inputSize.md`
            and a 28 px button beside it sat on a different baseline. */}
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <SlidersHorizontal /> {t("pool.filters")}
          {count > 0 ? (
            <Badge tone="accent" className="ml-0.5">
              {count}
            </Badge>
          ) : null}
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-fg-faint">{t("search.syntax")}</p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-fg-faint">{t("pool.groupBy")}</span>
          <Segmented
            name="pool-group"
            size="sm"
            label={t("pool.groupBy")}
            value={group}
            onChange={(next) => onGroup(next)}
            options={GROUP_BY.map((g) => ({
              value: g,
              label: t(`pool.group.${g}` as "pool.group.none"),
            }))}
          />
        </div>
        <div className="ml-auto flex items-center gap-3">
          {total === null ? null : (
            <span aria-live="polite" className="text-xs tabular-nums text-fg-faint">
              {t(total === 1 ? "pool.results.one" : "pool.results", { n: total })}
            </span>
          )}
          <Segmented
            name="pool-view"
            size="sm"
            value={view}
            onChange={onView}
            options={[
              viewOption("cards", <LayoutGrid className="size-4" />, t("view.cards")),
              viewOption("list", <List className="size-4" />, t("view.list")),
            ]}
          />
        </div>
      </div>

      {count > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {resolved.types.map((type) => (
            <Chip key={`type-${type}`} label={typeLabel(t, type)} onRemove={() => dropType(type)} />
          ))}
          {resolved.tags.map((tag) => (
            <Chip key={`tag-${tag}`} label={`#${tag}`} onRemove={() => dropTag(tag)} />
          ))}
          {resolved.difficulties.map((d) => (
            <Chip
              key={`diff-${d}`}
              label={t("pool.difficultyOf", { n: d })}
              onRemove={() => dropDifficulty(d)}
            />
          ))}
          {resolved.versionMin !== null || resolved.versionMax !== null ? (
            <Chip label={versionLabel()} onRemove={dropVersion} />
          ) : null}
          {resolved.includeDeleted ? (
            <Chip label={t("pool.filter.deleted")} onRemove={() => set({ includeDeleted: false })} />
          ) : null}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...filters,
                q: "",
                types: [],
                tags: [],
                difficulties: [],
                includeDeleted: false,
                versionMin: null,
                versionMax: null,
              })
            }
            className="rounded-field px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {t("pool.filter.clear")}
          </button>
        </div>
      ) : null}

      {open ? (
        <Sheet
          title={t("pool.filters")}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...filters,
                    types: [],
                    tags: [],
                    difficulties: [],
                    includeDeleted: false,
                    versionMin: null,
                    versionMax: null,
                    q: withoutToken(
                      withoutToken(withoutToken(withoutToken(filters.q, "tag"), "type"), "difficulty"),
                      "version",
                    ),
                  })
                }
              >
                {t("pool.filter.clear")}
              </Button>
              <Button onClick={() => setOpen(false)}>{t("common.done")}</Button>
            </>
          }
        >
          <div className="space-y-6">
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">{t("pool.filter.type")}</legend>
              <div className="flex flex-wrap gap-2">
                {QUESTION_TYPE_IDS.map((id) => (
                  <ToggleChip
                    key={id}
                    icon={typeIcon(id)}
                    label={typeLabel(t, id)}
                    pressed={resolved.types.includes(id)}
                    onToggle={() =>
                      resolved.types.includes(id) ? dropType(id) : set({ types: toggle(filters.types, id) })
                    }
                  />
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">
                {t("pool.filter.difficulty")}
              </legend>
              <div className="flex flex-wrap gap-2">
                {DIFFICULTIES.map((d) => (
                  <ToggleChip
                    key={d}
                    label={d}
                    // A bare digit is not a name: the reader hears the scale.
                    aria-label={t("pool.difficultyOf", { n: d })}
                    pressed={resolved.difficulties.includes(d)}
                    onToggle={() =>
                      resolved.difficulties.includes(d)
                        ? dropDifficulty(d)
                        : set({ difficulties: toggle(filters.difficulties, d) })
                    }
                  />
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">{t("pool.filter.tag")}</legend>
              {tags.length === 0 ? (
                <p className="text-sm text-fg-muted">—</p>
              ) : (
                <TagChips
                  tags={tags}
                  selected={resolved.tags}
                  onToggle={(tag) =>
                    resolved.tags.includes(tag) ? dropTag(tag) : set({ tags: toggle(filters.tags, tag) })
                  }
                />
              )}
            </fieldset>

            <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
              <span className="text-sm font-medium">{t("pool.filter.deleted")}</span>
              <Switch
                label={t("pool.filter.deleted")}
                checked={filters.includeDeleted}
                onChange={(v) => set({ includeDeleted: v })}
              />
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
