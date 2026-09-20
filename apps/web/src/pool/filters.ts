/**
 * The filter bar of the pool screen, as data.
 *
 * `QuestionSearch` in `@quiz/contracts` is what the API parses; this module
 * is the one place that turns the bar's state into that query string, so the
 * screen never builds a URL by hand and the composition is unit-testable.
 * Repeated and comma-separated lists are both accepted server-side; the
 * comma form is used here because it keeps a deep link short and readable.
 */
export interface QuestionFilters {
  /** Full-text search over the internal name and the statement. */
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
}

export const EMPTY_FILTERS: QuestionFilters = {
  q: "",
  types: [],
  tags: [],
  difficulties: [],
  categoryId: null,
  includeDeleted: false,
};

/** How many questions one page asks for; the rest arrives through "Load more". */
export const PAGE_SIZE = 25;

/**
 * `?q=…&type=…&limit=…` for `GET /pools/:id/questions`. The parameters are
 * emitted in a fixed order so two equal filter states produce the same string
 * — which is what makes it usable as a TanStack Query key.
 */
export function questionQuery(filters: QuestionFilters, cursor?: string | null): string {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q) params.set("q", q);
  if (filters.types.length) params.set("type", [...filters.types].join(","));
  if (filters.tags.length) params.set("tag", [...filters.tags].join(","));
  if (filters.difficulties.length) {
    params.set("difficulty", [...filters.difficulties].sort((a, b) => a - b).join(","));
  }
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.includeDeleted) params.set("includeDeleted", "1");
  params.set("limit", String(PAGE_SIZE));
  if (cursor) params.set("cursor", cursor);
  return `?${params.toString()}`;
}

/** How many filters are active, for the "Filters (2)" button and the clear row. */
export function activeFilterCount(filters: QuestionFilters): number {
  return (
    (filters.q.trim() ? 1 : 0) +
    filters.types.length +
    filters.tags.length +
    filters.difficulties.length +
    (filters.includeDeleted ? 1 : 0)
  );
}

/** Adds or removes one value of a multi-valued filter, keeping the input order. */
export function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
