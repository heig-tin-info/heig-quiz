import { describe, expect, it } from "vitest";

import { easter, festiveOn, wikipediaUrl } from "./calendar";

const on = (iso: string) => festiveOn(new Date(`${iso}T12:00:00`));

describe("easter", () => {
  it.each([
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2038, "2038-04-25"],
  ])("falls on the Sunday of %i", (year, iso) => {
    const d = easter(year);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual(iso.split("-").map(Number));
    expect(d.getDay()).toBe(0);
  });
});

describe("festiveOn", () => {
  it("holds a period from its first to its last day, across the new year", () => {
    expect(on("2026-12-14")).toBeNull();
    expect(on("2026-12-15")).toBe("xmas");
    expect(on("2027-01-06")).toBe("xmas");
    expect(on("2027-01-07")).toBeNull();
  });

  it("lets the shortest period win: Torvalds over Christmas", () => {
    expect(on("2026-12-27")).toBe("xmas");
    expect(on("2026-12-28")).toBe("torvalds");
  });

  it("finds Easter from Good Friday to Easter Monday", () => {
    expect(on("2027-03-25")).toBeNull();
    expect(on("2027-03-26")).toBe("easter");
    expect(on("2027-03-29")).toBe("easter");
    expect(on("2027-03-30")).toBeNull();
  });

  it("puts Programmers' Day on the 256th day, a day earlier in a leap year", () => {
    expect(on("2026-09-13")).toBe("programmers");
    expect(on("2028-09-12")).toBe("programmers");
    expect(on("2028-09-13")).toBeNull();
  });

  it("puts Ada Lovelace Day on the second Tuesday of October", () => {
    expect(on("2026-10-13")).toBe("ada");
    expect(on("2026-10-06")).toBeNull();
    expect(on("2027-10-12")).toBe("ada");
  });

  it("ignores the time of day", () => {
    expect(festiveOn(new Date(2026, 2, 14, 23, 59))).toBe("pi");
    expect(festiveOn(new Date(2026, 2, 14, 0, 0))).toBe("pi");
  });

  it("finds nothing on an ordinary day", () => {
    expect(on("2026-10-09")).toBeNull();
  });
});

describe("wikipediaUrl", () => {
  it("names the article in the interface language", () => {
    expect(wikipediaUrl("xmas", "fr")).toBe("https://fr.wikipedia.org/wiki/No%C3%ABl");
    expect(wikipediaUrl("programmers", "en")).toBe("https://en.wikipedia.org/wiki/Programmers'_Day");
  });
});
