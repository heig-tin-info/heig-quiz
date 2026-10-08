import { iconNames } from "lucide-react/dynamic";
import aliases from "virtual:lucide-aliases";
import { describe, expect, it } from "vitest";

import { searchIcons } from "./IconCatalogue";
import { POOL_ICON_COMPONENTS } from "./PoolIcon";
import { CUSTOM_ICON_KEYWORDS, CUSTOM_ICON_NAMES } from "./customIcons";
import {
  DEFAULT_COURSE_ICON,
  DEFAULT_POOL_ICON,
  ICON_SEARCH_LIMIT,
  POOL_ICON_GROUPS,
  POOL_ICONS,
} from "./poolIcons";

/*
 * The curated shelf is a list of STRINGS drawn by a static map, so nothing
 * but a test says whether lucide still ships them and whether the map still
 * covers them. A renamed icon, or a name added to the list and forgotten in
 * the map, would otherwise reach a teacher's pool as the default square
 * months after the change that caused it.
 */

describe("poolIcons", () => {
  it("offers only icons this lucide ships or Quiz draws", () => {
    const catalogue = new Set<string>([...iconNames, ...CUSTOM_ICON_NAMES]);
    expect([...POOL_ICONS, DEFAULT_POOL_ICON, DEFAULT_COURSE_ICON].filter((n) => !catalogue.has(n))).toEqual([]);
  });

  it("draws every curated name, and draws nothing else", () => {
    const shelf = [DEFAULT_POOL_ICON, DEFAULT_COURSE_ICON, ...POOL_ICONS].sort();
    expect(Object.keys(POOL_ICON_COMPONENTS).sort()).toEqual(shelf);
  });

  it("holds no duplicate, and not the default twice", () => {
    expect(new Set(POOL_ICONS).size).toBe(POOL_ICONS.length);
    expect(POOL_ICONS).not.toContain(DEFAULT_POOL_ICON);
    expect(POOL_ICONS).not.toContain(DEFAULT_COURSE_ICON);
  });

  it("puts every custom icon on the shelf, under a name lucide does not use", () => {
    const lucide = new Set<string>([...iconNames, ...Object.keys(aliases)]);
    expect(CUSTOM_ICON_NAMES.filter((n) => lucide.has(n))).toEqual([]);
    expect(CUSTOM_ICON_NAMES.filter((n) => !POOL_ICONS.includes(n))).toEqual([]);
    expect(
      Object.keys(CUSTOM_ICON_KEYWORDS).filter((n) => !CUSTOM_ICON_NAMES.includes(n as never)),
    ).toEqual([]);
  });

  it("stays a shelf of groups a teacher scans, not a catalogue", () => {
    expect(new Set(POOL_ICON_GROUPS.map((g) => g.id)).size).toBe(POOL_ICON_GROUPS.length);
    for (const group of POOL_ICON_GROUPS) expect(group.icons.length).toBeLessThanOrEqual(24);
  });

  it("searches the whole catalogue and caps what it returns", () => {
    expect(searchIcons("flask")).toContain("flask-conical");
    expect(searchIcons("")).toHaveLength(ICON_SEARCH_LIMIT);
    expect(searchIcons("zzzqqq")).toEqual([]);
    expect(searchIcons("a", 5)).toHaveLength(5);
  });

  it("finds a custom icon by its name and by its keywords", () => {
    expect(searchIcons("python")[0]).toBe("python");
    expect(searchIcons("octocat")).toContain("github");
    expect(searchIcons("ladder")).toContain("plc");
  });
});

/*
 * lucide lists ~250 aliases beside its canonical names (#165). The catalogue
 * offers each glyph once, under its canonical name, and a pool saved under
 * an alias before that keeps drawing the same glyph.
 */
describe("lucide aliases", () => {
  const KNOWN_ALIAS = "bar-chart-3";
  const ITS_CANONICAL = "chart-column";

  it("maps a known alias onto its canonical name, and not the reverse", () => {
    expect(aliases[KNOWN_ALIAS]).toBe(ITS_CANONICAL);
    expect(aliases[ITS_CANONICAL]).toBeUndefined();
  });

  it("lists no alias and no name twice", () => {
    const all = searchIcons("", Infinity);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((name) => name in aliases)).toEqual([]);
  });

  it("finds an icon by its alias, and lists it once", () => {
    expect(searchIcons(KNOWN_ALIAS)).toContain(ITS_CANONICAL);
    expect(searchIcons(KNOWN_ALIAS)).not.toContain(KNOWN_ALIAS);
    expect(searchIcons("chart-column").filter((n) => n === ITS_CANONICAL)).toHaveLength(1);
  });
});
