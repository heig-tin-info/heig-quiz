import { LayoutGrid, List } from "lucide-react";
import type { ReactNode } from "react";

import { useT } from "../i18n";
import { Segmented } from "../ui";
import type { QuestionFilters } from "./filters";
import { GROUP_BY, type GroupBy } from "./QuestionGroups";
import { QuestionSearchBar } from "./QuestionSearchBar";
import type { StatsOffer } from "./StatsFilterFields";

/**
 * The bar of the pool screen: the shared search field and its filter sheet
 * (`QuestionSearchBar`, which the poll launcher's "From pools" uses too),
 * plus a second row of the reader's habits.
 *
 * That second row is not filtering at all: how the list is DRAWN (cards or
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
 *
 * `actions` are the list's own tertiary actions, drawn after the count as
 * `Actions` draws them — today the one "Clear favourites" (F-POOL-10), which
 * acts on the list and is too rare to stand beside the page's primary.
 */
export type ListView = "cards" | "list";

export function FilterBar({
  filters,
  onChange,
  tags,
  stats,
  total,
  view,
  onView,
  group,
  onGroup,
  actions,
}: {
  filters: QuestionFilters;
  onChange: (next: QuestionFilters) => void;
  /** Every tag used in this pool, as the API reports them. */
  tags: string[];
  /** The pool's statistics, which the sheet's last block filters on (F-STAT-03). */
  stats?: StatsOffer;
  /** How many questions the search matches (the API's `total`); `null` while unknown. */
  total: number | null;
  view: ListView;
  onView: (next: ListView) => void;
  group: GroupBy;
  onGroup: (next: GroupBy) => void;
  actions?: ReactNode;
}) {
  const t = useT();

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
    <QuestionSearchBar
      filters={filters}
      onChange={onChange}
      tags={tags}
      stats={stats}
      coach="pool.search"
    >
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
          {actions}
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
    </QuestionSearchBar>
  );
}
