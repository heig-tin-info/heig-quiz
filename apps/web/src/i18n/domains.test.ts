import { describe, expect, it } from "vitest";

import type { Locale } from "@quiz/domain";

import { de } from "./de";
import { DOMAINS } from "./domains";
import { en } from "./en";
import { fr } from "./fr";
import { it as itDict } from "./it";

/**
 * The guard of `domains.ts`: a key lives in the one domain file that lists
 * its first segment, in every dictionary folder (one per language). The
 * dictionaries spread the files, so a key in two files would silently keep
 * the last one; the prefix rule makes that impossible, and the count catches
 * a file left out of a spread.
 */

type Files = Record<string, Record<string, Record<string, string>>>;
/** Every domain file, by folder: `./en/pool.ts`, `./de/qt.ts`… */
const ALL_FILES: Files = import.meta.glob("./*/*.ts", { eager: true });
/** Keyed by the registry: a language added there is a compile error here until its dictionary is. */
const DICTS: Record<Locale, Record<string, string>> = { en, fr, de, it: itDict };

const langOf = (path: string) => path.split("/")[1] as Locale;
const domainOf = (path: string) => path.replace(/^.*\/(.+)\.ts$/, "$1") as keyof typeof DOMAINS;

describe("the domain files of the dictionaries", () => {
  it("gives each first segment to one domain only", () => {
    const prefixes = Object.values(DOMAINS).flat();
    expect(prefixes).toHaveLength(new Set(prefixes).size);
  });

  it("has one dictionary per folder", () => {
    expect([...new Set(Object.keys(ALL_FILES).map(langOf))].sort()).toEqual(Object.keys(DICTS).sort());
  });

  for (const lang of Object.keys(DICTS) as Locale[]) {
    it(`${lang}: one file per domain, each holding the keys of its prefixes only`, () => {
      const files = Object.entries(ALL_FILES).filter(([path]) => langOf(path) === lang);
      expect(files.map(([path]) => domainOf(path)).sort()).toEqual(Object.keys(DOMAINS).sort());
      let count = 0;
      for (const [path, mod] of files) {
        const domain = domainOf(path);
        const prefixes: readonly string[] = DOMAINS[domain];
        const keys = Object.keys(mod[domain] ?? {});
        expect(
          keys.filter((key) => !prefixes.includes(key.split(".")[0] ?? "")),
          `${lang}/${domain}.ts holds keys whose first segment domains.ts does not list for it`,
        ).toEqual([]);
        count += keys.length;
      }
      expect(Object.keys(DICTS[lang])).toHaveLength(count);
    });
  }
});
