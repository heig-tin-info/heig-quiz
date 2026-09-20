import { describe, expect, it } from "vitest";

import { activeFilterCount, EMPTY_FILTERS, questionQuery, toggle } from "./filters";

describe("questionQuery", () => {
  it("asks for one page and nothing else when no filter is set", () => {
    expect(questionQuery(EMPTY_FILTERS)).toBe("?limit=25");
  });

  it("composes every filter into the query the API parses", () => {
    const query = questionQuery({
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
