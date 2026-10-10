import type { ReactNode } from "react";

import type { ConceptRef, PoolFilterCourse } from "@quiz/contracts";

import { useT, type Dict } from "../i18n";
import { GroupBySwitch, ViewSwitch } from "../ui";
import type { QuestionFilters, Vocabulary } from "./filters";
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
 * is what a habit control is for. The grouping is `GroupBySwitch`, which the
 * classroom's evaluation list draws too.
 *
 * `actions` are the list's own tertiary actions, drawn after the count as
 * `Actions` draws them — today the one "Clear favourites" (F-POOL-10), which
 * acts on the list and is too rare to stand beside the page's primary.
 */
export type ListView = "cards" | "list";

const GROUP_LABEL: Record<GroupBy, keyof Dict> = {
  none: "common.group.none",
  type: "pool.group.type",
  concepts: "pool.group.concepts",
  category: "pool.group.category",
};

export function FilterBar({
  filters,
  onChange,
  concepts,
  vocabulary,
  courses,
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
  /** Every concept this pool's questions use, as the API reports them. */
  concepts: readonly ConceptRef[];
  /** What the typed concept words resolve against. */
  vocabulary: Vocabulary;
  /** The courses the pool is linked to that the caller staffs: the sheet's Course filter (#599 step 7b). */
  courses: readonly PoolFilterCourse[];
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


  return (
    <QuestionSearchBar
      filters={filters}
      onChange={onChange}
      concepts={concepts}
      vocabulary={vocabulary}
      courses={courses}
      stats={stats}
      coach="pool.search"
    >
      <div className="flex flex-wrap items-center gap-2">
        <GroupBySwitch
          name="pool-group"
          value={group}
          onChange={onGroup}
          options={GROUP_BY.map((g) => ({ value: g, label: t(GROUP_LABEL[g]) }))}
        />
        <div className="ml-auto flex items-center gap-3">
          {total === null ? null : (
            <span aria-live="polite" className="text-xs tabular-nums text-fg-faint">
              {t(total === 1 ? "pool.results.one" : "pool.results", { n: total })}
            </span>
          )}
          {actions}
          <ViewSwitch name="pool-view" size="sm" views={["cards", "list"]} value={view} onChange={onView} />
        </div>
      </div>
    </QuestionSearchBar>
  );
}
