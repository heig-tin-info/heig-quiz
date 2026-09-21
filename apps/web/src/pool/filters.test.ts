import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  EMPTY_FILTERS,
  questionQuery,
  resolveFilters,
  toggle,
} from "./filters";

describe("questionQuery", () => {
  it("asks for one page and nothing else when no filter is set", () => {
    expect(questionQuery(EMPTY_FILTERS)).toBe("?limit=25");
  });

  it("composes every filter into the query the API parses", () => {
    const query = questionQuery({
      ...EMPTY_FILTERS,
      q: "  pointeurs ",
      types: ["code", "mcq"],
      tags: ["pointers", "memory"],
      difficulties: [4, 2],
      categoryId: "cat-1",
      includeDeleted: true,
    });
    const params = new URLSearchParams(query.slice(1));
    expect(params.get("q")).toBe("pointeurs");
    expect(params.get("type")).toBe("code,mcq");
    expect(params.get("tag")).toBe("pointers,memory");
    // Ascending, so two equal states give one query key.
    expect(params.get("difficulty")).toBe("2,4");
    expect(params.get("categoryId")).toBe("cat-1");
    expect(params.get("includeDeleted")).toBe("1");
    expect(params.get("limit")).toBe("25");
  });

  it("leaves the category out when every category is wanted", () => {
    expect(questionQuery({ ...EMPTY_FILTERS, categoryId: null })).not.toContain("categoryId");
    expect(questionQuery({ ...EMPTY_FILTERS, categoryId: "cat-1" })).toContain("categoryId=cat-1");
  });

  it("appends the cursor of the next page", () => {
    expect(questionQuery(EMPTY_FILTERS, "c-42")).toBe("?limit=25&cursor=c-42");
    expect(questionQuery(EMPTY_FILTERS, null)).toBe("?limit=25");
  });

  it("is stable for equal states", () => {
    const a = questionQuery({ ...EMPTY_FILTERS, tags: ["a"], difficulties: [3, 1] });
    const b = questionQuery({ ...EMPTY_FILTERS, tags: ["a"], difficulties: [1, 3] });
    expect(a).toBe(b);
  });
});

describe("activeFilterCount", () => {
  it("counts every active filter, and the category is not one", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, categoryId: "cat-1" })).toBe(0);
    expect(
      activeFilterCount({
        ...EMPTY_FILTERS,
        q: "ptr",
        types: ["code"],
        tags: ["a", "b"],
        difficulties: [5],
        includeDeleted: true,
      }),
    ).toBe(6);
  });

  it("ignores a whitespace-only search", () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: "   " })).toBe(0);
  });
});

describe("toggle", () => {
  it("adds at the end and removes in place", () => {
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("questionQuery · sort and version", () => {
  it("sends nothing while the sort is the API's own default", () => {
    expect(questionQuery(EMPTY_FILTERS)).not.toContain("sort");
    expect(questionQuery(EMPTY_FILTERS)).not.toContain("dir");
  });

  it("names the column and the direction once either leaves the default", () => {
    const params = new URLSearchParams(
      questionQuery({ ...EMPTY_FILTERS, sort: "name", dir: "asc" }).slice(1),
    );
    expect(params.get("sort")).toBe("name");
    expect(params.get("dir")).toBe("asc");
  });

  it("sends the direction alone when only it changed", () => {
    const params = new URLSearchParams(questionQuery({ ...EMPTY_FILTERS, dir: "asc" }).slice(1));
    expect(params.get("sort")).toBe(null);
    expect(params.get("dir")).toBe("asc");
  });

  it("carries the version bounds", () => {
    const params = new URLSearchParams(
      questionQuery({ ...EMPTY_FILTERS, versionMin: 2, versionMax: 4 }).slice(1),
    );
    expect(params.get("versionMin")).toBe("2");
    expect(params.get("versionMax")).toBe("4");
  });

  it("keeps the parameter order stable, cursor last", () => {
    expect(questionQuery({ ...EMPTY_FILTERS, sort: "name", dir: "asc" }, "c-1")).toBe(
      "?sort=name&dir=asc&limit=25&cursor=c-1",
    );
  });
});

describe("resolveFilters", () => {
  it("merges the search box tokens into the chips and keeps the free text", () => {
    const resolved = resolveFilters({
      ...EMPTY_FILTERS,
      q: "tag:pointeurs type:code difficulty:>3 version:>1 segfault",
      tags: ["memoire"],
    });
    expect(resolved.q).toBe("segfault");
    expect(resolved.tags).toEqual(["memoire", "pointeurs"]);
    expect(resolved.types).toEqual(["code"]);
    expect(resolved.difficulties).toEqual([4, 5]);
    expect(resolved.versionMin).toBe(2);
    expect(resolved.versionMax).toBe(null);
  });

  it("never lists the same value twice when both sides carry it", () => {
    const resolved = resolveFilters({ ...EMPTY_FILTERS, q: "tag:memoire", tags: ["memoire"] });
    expect(resolved.tags).toEqual(["memoire"]);
  });

  it("puts a token of the field into the query the API parses", () => {
    const params = new URLSearchParams(
      questionQuery({ ...EMPTY_FILTERS, q: 'type:mcq "null pointer"' }).slice(1),
    );
    expect(params.get("type")).toBe("mcq");
    expect(params.get("q")).toBe("null pointer");
  });

  it("counts a token of the field as an active filter", () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: "tag:a tag:b" })).toBe(2);
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: "version:>2" })).toBe(1);
  });
});
