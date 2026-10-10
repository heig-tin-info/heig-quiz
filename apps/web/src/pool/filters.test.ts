import { describe, expect, it } from "vitest";

import type { Concept, QuestionStats } from "@quiz/contracts";

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

const P = "00000000-0000-4000-8000-00000000000a";
const M1 = "00000000-0000-4000-8000-00000000000b";
const M2 = "00000000-0000-4000-8000-00000000000c";
const concept = (id: string, fr: [string, string?], en: [string, string?]): Concept => ({
  id,
  status: "validated",
  mergedInto: null,
  labels: { fr: fr[0], en: en[0] },
  qualifiers: { fr: fr[1] ?? "", en: en[1] ?? "" },
  descriptions: { fr: "", en: "" },
  aliases: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
});
/** A pointer in two languages, and two homonyms told apart by their qualifier. */
const VOCABULARY = [
  concept(P, ["Pointeur"], ["Pointer"]),
  concept(M1, ["Adresse", "mémoire"], ["Address", "memory"]),
  concept(M2, ["Adresse", "réseau"], ["Address", "network"]),
];

describe("questionQuery", () => {
  // The exact query of a few states, parameter order included.
  it.each([
    // No category, no sort: nothing but the page size.
    ["asks for one page and nothing else when no filter is set", EMPTY_FILTERS, undefined, "?limit=25"],
    ["appends the cursor of the next page", EMPTY_FILTERS, "c-42", "?limit=25&cursor=c-42"],
    ["appends no cursor for a null one", EMPTY_FILTERS, null, "?limit=25"],
    [
      "keeps the parameter order stable, cursor last",
      { ...EMPTY_FILTERS, sort: "name" as const, dir: "asc" as const },
      "c-1",
      "?sort=name&dir=asc&limit=25&cursor=c-1",
    ],
  ])("%s", (_, filters, cursor, expected) => {
    expect(questionQuery(filters, undefined, cursor)).toBe(expected);
  });

  it("composes every filter into the query the API parses", () => {
    const query = questionQuery({
      ...EMPTY_FILTERS,
      q: "  pointeurs ",
      types: ["code", "mcq"],
      concepts: [P, M1],
      difficulties: [4, 2],
      categoryId: "cat-1",
      includeDeleted: true,
    });
    const params = new URLSearchParams(query.slice(1));
    expect(params.get("q")).toBe("pointeurs");
    expect(params.get("type")).toBe("code,mcq");
    expect(params.get("concept")).toBe(`${P},${M1}`);
    // Ascending, so two equal states give one query key.
    expect(params.get("difficulty")).toBe("2,4");
    expect(params.get("categoryId")).toBe("cat-1");
    expect(params.get("includeDeleted")).toBe("1");
    expect(params.get("limit")).toBe("25");
  });

  it("sends the category when one is picked", () => {
    expect(questionQuery({ ...EMPTY_FILTERS, categoryId: "cat-1" })).toContain("categoryId=cat-1");
  });

  it("is stable for equal states", () => {
    const a = questionQuery({ ...EMPTY_FILTERS, concepts: [P], difficulties: [3, 1] });
    const b = questionQuery({ ...EMPTY_FILTERS, concepts: [P], difficulties: [1, 3] });
    expect(a).toBe(b);
  });
});

describe("activeFilterCount", () => {
  it.each([
    ["nothing", EMPTY_FILTERS, 0],
    ["the category, which is not a filter", { ...EMPTY_FILTERS, categoryId: "cat-1" }, 0],
    [
      "every active filter",
      { ...EMPTY_FILTERS, q: "ptr", types: ["code"], concepts: [P, M1], difficulties: [5], includeDeleted: true },
      6,
    ],
    ["a whitespace-only search as nothing", { ...EMPTY_FILTERS, q: "   " }, 0],
    // A token of the search field is a filter like a chip.
    ["two concept words of the field", { ...EMPTY_FILTERS, q: "#a tag:b" }, 2],
    ["a version token of the field", { ...EMPTY_FILTERS, q: "version:>2" }, 1],
    // A statistics range counts once, and "without statistics" alone is none.
    ["two ranges and without-stats", { ...EMPTY_FILTERS, rateMin: 20, rateMax: 60, timeMin: 30, withoutStats: true }, 2],
    ["without-stats alone", { ...EMPTY_FILTERS, withoutStats: true }, 0],
  ])("counts %s", (_, filters, count) => {
    expect(activeFilterCount(filters)).toBe(count);
  });
});

describe("toggle", () => {
  it("adds at the end and removes in place", () => {
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("questionQuery · sort and version", () => {
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

});

describe("resolveFilters", () => {
  it("merges the search box tokens into the chips and keeps the free text", () => {
    const resolved = resolveFilters({
      ...EMPTY_FILTERS,
      q: "#pointer type:code difficulty:>3 version:>1 segfault",
      concepts: [M1],
    }, VOCABULARY);
    expect(resolved.q).toBe("segfault");
    expect(resolved.concepts).toEqual([M1, P]);
    expect(resolved.words).toEqual([{ word: "pointer", ids: [P] }]);
    expect(resolved.pending).toBe(false);
    expect(resolved.types).toEqual(["code"]);
    expect(resolved.difficulties).toEqual([4, 5]);
    expect(resolved.versionMin).toBe(2);
    expect(resolved.versionMax).toBe(null);
  });

  it("never lists the same value twice when both sides carry it", () => {
    const resolved = resolveFilters({ ...EMPTY_FILTERS, q: "#pointeur", concepts: [P] }, VOCABULARY);
    expect(resolved.concepts).toEqual([P]);
  });

  // ADR-081 third addendum §7: a word filters on every concept it may designate.
  it.each([
    ["a label in the other language", "#pointers", [P]],
    ["the tags' spelling", "tag:#pointeur", [P]],
    ["no merely close spelling", "#pointr", []],
    ["homonyms, inclusively", "#adresse", [M1, M2]],
    ["one homonym by its qualifier", '#"adresse (réseau)"', [M2]],
  ])("resolves %s", (_, q, ids) => {
    const resolved = resolveFilters({ ...EMPTY_FILTERS, q }, VOCABULARY);
    expect([...resolved.concepts].sort()).toEqual([...ids].sort());
  });

  it("filters nothing on a word that designates no concept, and says which", () => {
    const resolved = resolveFilters({ ...EMPTY_FILTERS, q: "#inductance" }, VOCABULARY);
    expect(resolved.words).toEqual([{ word: "inductance", ids: [] }]);
    expect(resolved.concepts).toEqual([]);
    expect(questionQuery({ ...EMPTY_FILTERS, q: "#inductance" }, VOCABULARY)).toBe("?limit=25");
  });

  it("is pending while the vocabulary is not there", () => {
    expect(resolveFilters({ ...EMPTY_FILTERS, q: "#pointer" }).pending).toBe(true);
    expect(resolveFilters({ ...EMPTY_FILTERS, q: "pointer" }).pending).toBe(false);
  });

  it("puts a token of the field into the query the API parses", () => {
    const params = new URLSearchParams(
      questionQuery({ ...EMPTY_FILTERS, q: 'type:mcq "null pointer"' }).slice(1),
    );
    expect(params.get("type")).toBe("mcq");
    expect(params.get("q")).toBe("null pointer");
  });
});

describe("the course filter (#599 step 7b)", () => {
  const PRG1 = { id: "00000000-0000-4000-8000-0000000000c1", name: "Programmation 1", code: "PRG1" };
  const PRG2 = { id: "00000000-0000-4000-8000-0000000000c2", name: "Programmation 2", code: "PRG2" };
  const COURSES = [PRG1, PRG2];

  it("sends the course ticked in the sheet", () => {
    const params = new URLSearchParams(questionQuery({ ...EMPTY_FILTERS, courseId: PRG2.id }, undefined, null, COURSES).slice(1));
    expect(params.get("course")).toBe(PRG2.id);
  });

  it("resolves a typed course by its code, else its name, whatever the case, and keeps the rest as text", () => {
    const byCode = resolveFilters({ ...EMPTY_FILTERS, q: "ptr course:prg1" }, undefined, COURSES);
    expect(byCode).toMatchObject({ q: "ptr", course: PRG1, courseMiss: null });
    const byName = resolveFilters({ ...EMPTY_FILTERS, q: 'course:"programmation 2"' }, undefined, COURSES);
    expect(byName.course).toEqual(PRG2);
  });

  it("filters nothing on a course that is not on offer, and says which", () => {
    const resolved = resolveFilters({ ...EMPTY_FILTERS, q: "course:ALGO" }, undefined, COURSES);
    expect(resolved).toMatchObject({ course: null, courseMiss: "ALGO" });
    expect(questionQuery({ ...EMPTY_FILTERS, q: "course:ALGO" }, undefined, null, COURSES)).toBe("?limit=25");
  });

  it("counts as one filter, ticked or typed", () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: "course:PRG1" })).toBe(1);
    expect(activeFilterCount({ ...EMPTY_FILTERS, courseId: PRG1.id })).toBe(1);
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

  // In whole percent, inclusive, as the panel shows it: 0.725 rounds to 73 %.
  it.each([
    [0.4, 40, 73, true],
    [0.73, 40, 73, true],
    [0.39, 40, 73, false],
    [0.74, 40, 73, false],
    [0.725, 73, null, true],
  ])("bounds a rate of %s by [%s, %s]: %s", (p, rateMin, rateMax, kept) => {
    expect(matchesStats(stats(p), { ...EMPTY_FILTERS, rateMin, rateMax })).toBe(kept);
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

  it("never sends a range, and asks for the largest page", () => {
    const f = { ...EMPTY_FILTERS, rateMin: 20, rateMax: 60, timeMin: 30, withoutStats: true };
    expect(hasStatsFilter(f)).toBe(true);
    expect(questionQuery(f)).toBe("?limit=200");
    expect(questionQuery({ ...EMPTY_FILTERS, withoutStats: true })).toBe("?limit=25");
  });
});
