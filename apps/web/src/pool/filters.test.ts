import { describe, expect, it } from "vitest";

import type { QuestionStats } from "@quiz/contracts";

import {
  activeFilterCount,
  EMPTY_FILTERS,
  hasStatsFilter,
  matchesStats,
  questionQuery,
  ratePercent,
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

describe("the statistics bounds (F-STAT-03)", () => {
  const TIME = { n: 12, meanS: 95, medianS: 80, p25S: 52, p75S: 121 };
  const stats = (p: number, time: QuestionStats["time"] = null): QuestionStats => ({
    n: 20,
    p,
    since: null,
    time,
    discrimination: null,
  });

  it("lets everything through while no bound is set", () => {
    expect(hasStatsFilter(EMPTY_FILTERS)).toBe(false);
    expect(matchesStats(undefined, EMPTY_FILTERS)).toBe(true);
    expect(matchesStats(stats(-0.3), EMPTY_FILTERS)).toBe(true);
  });

  it("bounds the rate in whole percent, inclusive, as the panel shows it", () => {
    const f = { ...EMPTY_FILTERS, rateMin: 40, rateMax: 73 };
    expect(matchesStats(stats(0.4), f)).toBe(true);
    expect(matchesStats(stats(0.73), f)).toBe(true);
    expect(matchesStats(stats(0.39), f)).toBe(false);
    expect(matchesStats(stats(0.74), f)).toBe(false);
    // 0.725 rounds to 73 %, what the panel reads.
    expect(matchesStats(stats(0.725), { ...EMPTY_FILTERS, rateMin: 73 })).toBe(true);
  });

  it("reads a range typed backwards as the same span", () => {
    const rate = { ...EMPTY_FILTERS, rateMin: 73, rateMax: 40 };
    expect(matchesStats(stats(0.5), rate)).toBe(true);
    expect(matchesStats(stats(0.8), rate)).toBe(false);
    const time = { ...EMPTY_FILTERS, timeMin: 90, timeMax: 60 };
    expect(matchesStats(stats(0.5, TIME), time)).toBe(true);
  });

  it("rounds a rate to the whole percent the panel shows", () => {
    expect(ratePercent(0.725)).toBe(73);
    expect(ratePercent(-0.08)).toBe(-8);
  });

  it("reads a signed rate:a bound below zero finds the questions that take points away", () => {
    const f = { ...EMPTY_FILTERS, rateMax: -1 };
    expect(matchesStats(stats(-0.08), f)).toBe(true);
    expect(matchesStats(stats(0), f)).toBe(false);
  });

  it("bounds the median time in seconds", () => {
    const f = { ...EMPTY_FILTERS, timeMin: 60, timeMax: 90 };
    expect(matchesStats(stats(0.5, TIME), f)).toBe(true);
    expect(matchesStats(stats(0.5, { ...TIME, medianS: 91 }), f)).toBe(false);
    expect(matchesStats(stats(0.5, { ...TIME, medianS: 59 }), f)).toBe(false);
  });

  it("hides a question without the figure a bound reads, unless asked to keep it", () => {
    const rate = { ...EMPTY_FILTERS, rateMin: 50 };
    expect(matchesStats(undefined, rate)).toBe(false);
    expect(matchesStats(undefined, { ...rate, withoutStats: true })).toBe(true);
    // A rate but no time yet: missing for a time bound, not for a rate bound.
    const time = { ...EMPTY_FILTERS, timeMax: 120 };
    expect(matchesStats(stats(0.9), time)).toBe(false);
    expect(matchesStats(stats(0.9), { ...time, withoutStats: true })).toBe(true);
    expect(matchesStats(stats(0.9), rate)).toBe(true);
  });

  it("never keeps a figure that falls outside a bound, even with the questions without one", () => {
    const f = { ...EMPTY_FILTERS, rateMin: 50, timeMax: 120, withoutStats: true };
    expect(matchesStats(stats(0.2, TIME), f)).toBe(false);
    // The rate passes and the time is missing: kept.
    expect(matchesStats(stats(0.6), f)).toBe(true);
  });

  it("counts each range as one filter, never sends one, and asks for the largest page", () => {
    const f = { ...EMPTY_FILTERS, rateMin: 20, rateMax: 60, timeMin: 30, withoutStats: true };
    expect(hasStatsFilter(f)).toBe(true);
    expect(activeFilterCount(f)).toBe(2);
    expect(activeFilterCount({ ...EMPTY_FILTERS, withoutStats: true })).toBe(0);
    expect(questionQuery(f)).toBe("?limit=200");
    expect(questionQuery({ ...EMPTY_FILTERS, withoutStats: true })).toBe("?limit=25");
  });
});
