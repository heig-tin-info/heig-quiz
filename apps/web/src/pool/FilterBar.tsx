import { SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";

import { useT } from "../i18n";
import { typeLabel, QUESTION_TYPE_IDS } from "../questionTypes";
import { Badge, Button, Checkbox, SearchInput, Sheet, Switch, cx } from "../ui";
import { activeFilterCount, toggle, type QuestionFilters } from "./filters";

/**
 * Search, then the filters behind one button (mockup `08-pool.html`): the
 * bar of a pool screen carries one field and one secondary button, and the
 * four lists — type, tag, difficulty, deleted — live in a sheet, because
 * more than three controls in a row is a control panel, not a toolbar.
 *
 * Whatever is active comes back as chips under the bar, each one removable:
 * a filter you cannot see is a filter you will blame the data for.
 */
const DIFFICULTIES = [1, 2, 3, 4, 5];

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
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
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
              <div className="space-y-2">
                {QUESTION_TYPE_IDS.map((id) => (
                  <Checkbox
                    key={id}
                    label={typeLabel(t, id)}
                    checked={filters.types.includes(id)}
                    onChange={() => set({ types: toggle(filters.types, id) })}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">
                {t("pool.filter.difficulty")}
              </legend>
              <div className="flex flex-wrap gap-3">
                {DIFFICULTIES.map((d) => (
                  <Checkbox
                    key={d}
                    label={d}
                    checked={filters.difficulties.includes(d)}
                    onChange={() => set({ difficulties: toggle(filters.difficulties, d) })}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">{t("pool.filter.tag")}</legend>
              {tags.length === 0 ? (
                <p className="text-sm text-fg-muted">—</p>
              ) : (
                <div className={cx("flex flex-wrap gap-x-4 gap-y-2")}>
                  {tags.map((tag) => (
                    <Checkbox
                      key={tag}
                      label={`#${tag}`}
                      checked={filters.tags.includes(tag)}
                      onChange={() => set({ tags: toggle(filters.tags, tag) })}
                    />
                  ))}
                </div>
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
