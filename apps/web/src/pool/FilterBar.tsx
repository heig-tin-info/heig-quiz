import { SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";

import { fuzzyFilter } from "../fuzzy";
import { useT } from "../i18n";
import { typeIcon, typeLabel, QUESTION_TYPE_IDS } from "../questionTypes";
import { Badge, Button, SearchInput, Sheet, Switch, ToggleChip } from "../ui";
import { activeFilterCount, toggle, type QuestionFilters } from "./filters";

/**
 * Search, then the filters behind one button (mockup `08-pool.html`): the
 * bar of a pool screen carries one field and one secondary button, and the
 * four lists — type, tag, difficulty, deleted — live in a sheet, because
 * more than three controls in a row is a control panel, not a toolbar.
 *
 * Inside the sheet the three lists are rows of `ToggleChip`, not rows of
 * checkboxes. A checkbox is the shape of an independent setting; these are
 * SETS of values, and "Multiple choice" beside "Short answer" beside a box
 * each collide the moment the sheet is narrower than the labels. A pill
 * carries its own bounds and wraps.
 *
 * Whatever is active comes back as chips under the bar, each one removable:
 * a filter you cannot see is a filter you will blame the data for.
 */
const DIFFICULTIES = [1, 2, 3, 4, 5];

/** How many tag chips the sheet shows before "Show all (N)". */
const TAG_LIMIT = 20;

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

export function FilterBar({
  filters,
  onChange,
  tags,
  total,
}: {
  filters: QuestionFilters;
  onChange: (next: QuestionFilters) => void;
  /** Every tag used in this pool, as the API reports them. */
  tags: string[];
  /** How many rows are loaded, for the count beside the chips. */
  total: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);
  const set = (patch: Partial<QuestionFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="w-full min-w-0 flex-1 sm:w-72"
          aria-label={t("pool.search")}
          placeholder={t("pool.search")}
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
        />
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

      {count > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.types.map((type) => (
            <Chip
              key={`type-${type}`}
              label={typeLabel(t, type)}
              onRemove={() => set({ types: toggle(filters.types, type) })}
            />
          ))}
          {filters.tags.map((tag) => (
            <Chip
              key={`tag-${tag}`}
              label={`#${tag}`}
              onRemove={() => set({ tags: toggle(filters.tags, tag) })}
            />
          ))}
          {filters.difficulties.map((d) => (
            <Chip
              key={`diff-${d}`}
              label={t("pool.difficultyOf", { n: d })}
              onRemove={() => set({ difficulties: toggle(filters.difficulties, d) })}
            />
          ))}
          {filters.includeDeleted ? (
            <Chip label={t("pool.filter.deleted")} onRemove={() => set({ includeDeleted: false })} />
          ) : null}
          <button
            type="button"
            onClick={() =>
              onChange({ ...filters, q: "", types: [], tags: [], difficulties: [], includeDeleted: false })
            }
            className="rounded-md px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {t("pool.filter.clear")}
          </button>
          <span className="ml-auto text-xs tabular-nums text-fg-faint">
            {t(total === 1 ? "pool.results.one" : "pool.results", { n: total })}
          </span>
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
                    pressed={filters.types.includes(id)}
                    onToggle={() => set({ types: toggle(filters.types, id) })}
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
                    pressed={filters.difficulties.includes(d)}
                    onToggle={() => set({ difficulties: toggle(filters.difficulties, d) })}
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
                  selected={filters.tags}
                  onToggle={(tag) => set({ tags: toggle(filters.tags, tag) })}
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
