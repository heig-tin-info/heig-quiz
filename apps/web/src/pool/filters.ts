/**
 * The filter bar of the pool screen, as data.
 *
 * `QuestionSearch` in `@quiz/contracts` is what the API parses; this module
 * is the one place that turns the bar's state into that query string, so the
 * screen never builds a URL by hand and the composition is unit-testable.
 * Repeated and comma-separated lists are both accepted server-side; the
 * comma form is used here because it keeps a deep link short and readable.
 *
 * `q` holds the search box RAW, tokens included: `resolveFilters` runs
 * `searchSyntax.ts` over it and merges what it finds with the chips the sheet
 * set, so `tag:pointeurs` typed in the field and #pointeurs ticked in the
 * sheet are the same filter and neither hides the other.
 *
 * The statistics bounds (F-STAT-03) are the one part the API never sees: the
 * pool screen already holds every question's statistics (ADR-038 §7), so it
 * filters its rows against them itself (`matchesStats`) instead of a second
 * route re-reading the history per search.
 */
import type { QuestionSort, QuestionStats } from "@quiz/contracts";

import { parseSearch } from "./searchSyntax";

export type { QuestionSort };
export type SortDir = "asc" | "desc";

export interface QuestionFilters {
  /**
   * The search box as typed. Free text plus the tokens of `searchSyntax.ts`;
   * `resolveFilters` is what separates the two.
   */
  q: string;
  types: string[];
  tags: string[];
  difficulties: number[];
  /**
   * `null` is "every category". The API filters on one category id and has
   * no "uncategorized" filter (`searchWhere` in the pool service), so the
   * tree offers "All questions" and the categories themselves, nothing else.
   */
  categoryId: string | null;
  includeDeleted: boolean;
  /** Published version bounds, from `version:` in the search box. */
  versionMin: number | null;
  versionMax: number | null;
  /**
   * Bounds on the item analysis (ADR-038, F-STAT-03): the success rate in
   * whole percent, SIGNED like `p`, and the median time in seconds
   * (ADR-039). The API knows nothing of them: `matchesStats` applies them in
   * the page, on the pool's statistics map, and `questionQuery` never sends
   * them.
   */
  rateMin: number | null;
  rateMax: number | null;
  timeMin: number | null;
  timeMax: number | null;
  /**
   * Whether a question WITHOUT the figure a bound reads stays in the list —
   * no statistics at all, or no time yet. Hidden by default: "success under
   * 40 %" is not answered by a question nobody has answered.
   */
  withoutStats: boolean;
  /** The sorted column, and its direction. The server sorts, never the page. */
  sort: QuestionSort;
  dir: SortDir;
}

/**
 * Newest change first: the column a teacher who left the screen yesterday
 * wants at the top. The API's own default (`QuestionSearch`) is the same one,
 * which is why neither parameter is sent while it holds.
 */
const DEFAULT_SORT: QuestionSort = "updated";
const DEFAULT_DIR: SortDir = "desc";

/**
 * Every filter the sheet and the chips set, at rest: what "Clear" puts back.
 * The search text, the category and the sort are not among them — each
 * clearing control decides about the text itself, and the other two are not
 * filters the sheet owns.
 */
export const NO_FILTERS = {
  types: [],
  tags: [],
  difficulties: [],
  includeDeleted: false,
  versionMin: null,
  versionMax: null,
  rateMin: null,
  rateMax: null,
  timeMin: null,
  timeMax: null,
  withoutStats: false,
} satisfies Partial<QuestionFilters>;

export const EMPTY_FILTERS: QuestionFilters = {
  q: "",
  ...NO_FILTERS,
  categoryId: null,
  sort: DEFAULT_SORT,
  dir: DEFAULT_DIR,
};

/** How many questions one page asks for; the rest arrives through "Load more". */
export const PAGE_SIZE = 25;

/**
 * The page size while a statistics bound is set — the API's maximum. The
 * bounds apply in the page, so the screen loads the WHOLE search before it
 * says what matches; in pages of 200 rather than 25, a pool of a few hundred
 * questions takes one or two requests.
 */
export const STATS_PAGE_SIZE = 200;

const union = <T>(a: T[], b: T[]): T[] => [...a, ...b.filter((v) => !a.includes(v))];

/**
 * The filters the API is actually asked for: the search box's tokens merged
 * into the chips, and `q` reduced to the free text. Everything downstream —
 * the query string, the chip row, the filter count — reads this and not the
 * raw state, so there is one answer to "what is filtering this list".
 */
export function resolveFilters(filters: QuestionFilters): QuestionFilters {
  const parsed = parseSearch(filters.q);
  const min = [filters.versionMin, parsed.versionMin].filter((v): v is number => v !== null);
  const max = [filters.versionMax, parsed.versionMax].filter((v): v is number => v !== null);
  return {
    ...filters,
    q: parsed.q,
    types: union(filters.types, parsed.types),
    tags: union(filters.tags, parsed.tags),
    difficulties: union(filters.difficulties, parsed.difficulties).sort((a, b) => a - b),
    // Two bounds on one screen intersect: the narrower one is the one the
    // reader can see a reason for.
    versionMin: min.length === 0 ? null : Math.max(...min),
    versionMax: max.length === 0 ? null : Math.min(...max),
  };
}

/**
 * `?q=…&type=…&limit=…` for `GET /pools/:id/questions`. The parameters are
 * emitted in a fixed order so two equal filter states produce the same string
 * — which is what makes it usable as a TanStack Query key. `sort` and `dir`
 * are omitted while they hold their default, for the same reason: a key that
 * changes shape on a value that changed nothing refetches for nothing.
 */
export function questionQuery(filters: QuestionFilters, cursor?: string | null): string {
  const resolved = resolveFilters(filters);
  const params = new URLSearchParams();
  const q = resolved.q.trim();
  if (q) params.set("q", q);
  if (resolved.types.length) params.set("type", [...resolved.types].join(","));
  if (resolved.tags.length) params.set("tag", [...resolved.tags].join(","));
  if (resolved.difficulties.length) {
    params.set("difficulty", [...resolved.difficulties].sort((a, b) => a - b).join(","));
  }
  if (resolved.categoryId) params.set("categoryId", resolved.categoryId);
  if (resolved.includeDeleted) params.set("includeDeleted", "1");
  if (resolved.versionMin !== null) params.set("versionMin", String(resolved.versionMin));
  if (resolved.versionMax !== null) params.set("versionMax", String(resolved.versionMax));
  if (resolved.sort !== DEFAULT_SORT) params.set("sort", resolved.sort);
  if (resolved.dir !== DEFAULT_DIR) params.set("dir", resolved.dir);
  params.set("limit", String(hasStatsFilter(resolved) ? STATS_PAGE_SIZE : PAGE_SIZE));
  if (cursor) params.set("cursor", cursor);
  return `?${params.toString()}`;
}

/** How many filters are active, for the "Filters (2)" button and the clear row. */
export function activeFilterCount(filters: QuestionFilters): number {
  const resolved = resolveFilters(filters);
  return (
    (resolved.q.trim() ? 1 : 0) +
    resolved.types.length +
    resolved.tags.length +
    resolved.difficulties.length +
    (resolved.includeDeleted ? 1 : 0) +
    // The two bounds are one filter: "version 2 to 4" is one thing to remove.
    (resolved.versionMin !== null || resolved.versionMax !== null ? 1 : 0) +
    // Likewise each statistics range; `withoutStats` only qualifies them.
    (hasRateBound(resolved) ? 1 : 0) +
    (hasTimeBound(resolved) ? 1 : 0)
  );
}

type StatsBounds = Pick<QuestionFilters, "rateMin" | "rateMax" | "timeMin" | "timeMax" | "withoutStats">;

const hasRateBound = (f: StatsBounds) => f.rateMin !== null || f.rateMax !== null;
const hasTimeBound = (f: StatsBounds) => f.timeMin !== null || f.timeMax !== null;
/** A range typed backwards ("60 to 20") means the same span as the right way round. */
const inRange = (value: number, a: number | null, b: number | null) => {
  const [min, max] = a !== null && b !== null && a > b ? [b, a] : [a, b];
  return (min === null || value >= min) && (max === null || value <= max);
};

/** A success rate `p` in whole percent, signed: the figure the panel shows and the bounds compare. */
export const ratePercent = (p: number): number => Math.round(p * 100);

/** Whether a statistics bound is set: the list is then filtered in the page. */
export function hasStatsFilter(filters: StatsBounds): boolean {
  return hasRateBound(filters) || hasTimeBound(filters);
}

/**
 * Whether a question passes the statistics bounds, given its entry in the
 * pool's statistics (`undefined`: under the threshold, or never answered).
 *
 * The rate is compared in whole percent, as the panel shows it, so "from
 * 73 %" keeps the question whose panel says 73 %. A question without the
 * figure a bound reads — no entry for the rate, no `time` for the time — is
 * kept only with `withoutStats`; a figure that exists and falls outside a
 * bound always hides the question.
 */
export function matchesStats(stats: QuestionStats | undefined, filters: StatsBounds): boolean {
  const rate = hasRateBound(filters);
  const time = hasTimeBound(filters);
  if (!rate && !time) return true;
  if (!stats) return filters.withoutStats;
  if (rate && !inRange(ratePercent(stats.p),filters.rateMin, filters.rateMax)) return false;
  if (!time) return true;
  if (!stats.time) return filters.withoutStats;
  return inRange(stats.time.medianS, filters.timeMin, filters.timeMax);
}

/** Adds or removes one value of a multi-valued filter, keeping the input order. */
export function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
