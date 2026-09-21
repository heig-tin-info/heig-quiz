/**
 * "Group by" for the pool's questions, as data.
 *
 * The teacher asked for the same four groupings in both readings of the list
 * (the table and the cards), so neither of the two draws them: they both take
 * the sections this module produces, and the rule lives in one place with a
 * unit test on it.
 *
 * The rule: the rows keep the order the SERVER sent them inside a section —
 * the sort is the server's answer and a grouping must not quietly re-sort it —
 * and the sections themselves are ordered by something stable (the registry's
 * order for a type, the alphabet for a tag, the tree for a category). A
 * question wearing three tags appears in three sections, because `tags` is the
 * one grouping whose key is not a single value; every other one partitions.
 * The rows with nothing to group on land in a last section of their own.
 */
import type { QuestionRow } from "@quiz/contracts";

export type GroupBy = "none" | "type" | "tags" | "category";

export const GROUP_BY: readonly GroupBy[] = ["none", "type", "tags", "category"];

export function isGroupBy(value: string): value is GroupBy {
  return (GROUP_BY as readonly string[]).includes(value);
}

export interface QuestionGroup {
  /** Unique within the list; part of every row key, since a row may repeat. */
  key: string;
  /** The heading, or `null` for the single section of `none`. */
  label: string | null;
  rows: QuestionRow[];
}

export interface GroupLabels {
  type: (id: string) => string;
  /** "Pointeurs / Arithmétique", or the id when the tree does not hold it. */
  category: (id: string) => string;
  noTag: string;
  noCategory: string;
}

export function groupQuestions(
  rows: QuestionRow[],
  by: GroupBy,
  labels: GroupLabels,
  /** The registry's order, so the type sections read the same as the pickers. */
  typeOrder: readonly string[],
  /** Depth-first order of the category tree, for the same reason. */
  categoryOrder: readonly string[],
): QuestionGroup[] {
  if (by === "none") return [{ key: "all", label: null, rows }];

  const buckets = new Map<string, QuestionRow[]>();
  const push = (key: string, row: QuestionRow) => {
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  };

  if (by === "type") {
    for (const row of rows) push(row.type, row);
    const keys = [...buckets.keys()].sort(byIndexThenName(typeOrder));
    return keys.map((key) => ({ key: `type:${key}`, label: labels.type(key), rows: buckets.get(key)! }));
  }

  if (by === "tags") {
    for (const row of rows) {
      if (row.tags.length === 0) push("", row);
      else for (const tag of row.tags) push(tag, row);
    }
    const tags = [...buckets.keys()].filter((k) => k !== "").sort((a, b) => a.localeCompare(b));
    const groups = tags.map((tag) => ({ key: `tag:${tag}`, label: `#${tag}`, rows: buckets.get(tag)! }));
    const untagged = buckets.get("");
    if (untagged) groups.push({ key: "tag:", label: labels.noTag, rows: untagged });
    return groups;
  }

  for (const row of rows) push(row.categoryId ?? "", row);
  const ids = [...buckets.keys()].filter((k) => k !== "").sort(byIndexThenName(categoryOrder));
  const groups = ids.map((id) => ({
    key: `cat:${id}`,
    label: labels.category(id),
    rows: buckets.get(id)!,
  }));
  const loose = buckets.get("");
  if (loose) groups.push({ key: "cat:", label: labels.noCategory, rows: loose });
  return groups;
}

/** The given order first, then anything it does not know, alphabetically. */
function byIndexThenName(order: readonly string[]) {
  return (a: string, b: string) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === ib) return a.localeCompare(b);
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  };
}
