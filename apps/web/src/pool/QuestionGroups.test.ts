import { describe, expect, it } from "vitest";

import type { QuestionRow } from "@quiz/contracts";

import { groupQuestions, isGroupBy } from "./QuestionGroups";

/*
 * The grouping rule, on rows that would break it if it were written another
 * way: a question wearing two tags, a question wearing none, a question in no
 * category, and a type the registry does not list.
 */

const row = (over: Partial<QuestionRow> & { id: string }): QuestionRow => ({
  type: "mcq",
  internalName: over.id,
  difficulty: 3,
  tags: [],
  categoryId: null,
  latestNumber: 1,
  hasDraftChanges: false,
  updatedAt: "2026-09-18T08:00:00.000Z",
  deprecated: false,
  deletedAt: null,
  ...over,
});

const ROWS = [
  row({ id: "a", type: "code", tags: ["pointeurs", "memoire"], categoryId: "k2" }),
  row({ id: "b", type: "mcq", tags: [], categoryId: "k1" }),
  row({ id: "c", type: "mcq", tags: ["memoire"], categoryId: null }),
];

const LABELS = {
  type: (id: string) => `T:${id}`,
  category: (id: string) => `C:${id}`,
  noTag: "No tag",
  noCategory: "No category",
};

const TYPES = ["mcq", "short", "cloze", "code"];
const CATEGORIES = ["k1", "k2"];

const group = (by: Parameters<typeof groupQuestions>[1]) =>
  groupQuestions(ROWS, by, LABELS, TYPES, CATEGORIES);

describe("groupQuestions", () => {
  it("hands back one unlabelled section when nothing groups", () => {
    expect(group("none")).toEqual([{ key: "all", label: null, rows: ROWS }]);
  });

  it("cuts by type in the registry's order, not in the rows' order", () => {
    expect(group("type").map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["T:mcq", ["b", "c"]],
      ["T:code", ["a"]],
    ]);
  });

  it("repeats a question under each of its tags, and gathers the untagged last", () => {
    expect(group("tags").map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["#memoire", ["a", "c"]],
      ["#pointeurs", ["a"]],
      ["No tag", ["b"]],
    ]);
  });

  it("cuts by category in the tree's order, the uncategorized last", () => {
    expect(group("category").map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["C:k1", ["b"]],
      ["C:k2", ["a"]],
      ["No category", ["c"]],
    ]);
  });

  it("keeps the server's order inside a section", () => {
    const rows = [row({ id: "z", type: "mcq" }), row({ id: "a", type: "mcq" })];
    expect(groupQuestions(rows, "type", LABELS, TYPES, CATEGORIES)[0]!.rows.map((r) => r.id)).toEqual(
      ["z", "a"],
    );
  });

  it("puts a value the given order does not know at the end", () => {
    const rows = [row({ id: "x", type: "essay" }), row({ id: "y", type: "mcq" })];
    expect(groupQuestions(rows, "type", LABELS, TYPES, CATEGORIES).map((g) => g.label)).toEqual([
      "T:mcq",
      "T:essay",
    ]);
  });

  it("gives every section a key of its own, even for one repeated row", () => {
    const keys = group("tags").map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("isGroupBy", () => {
  it("guards what comes back out of localStorage", () => {
    expect(isGroupBy("tags")).toBe(true);
    expect(isGroupBy("colour")).toBe(false);
  });
});
