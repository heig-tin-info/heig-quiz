import { describe, expect, it } from "vitest";

import { DOMAINS } from "./domains";
import { en } from "./en";
import { fr } from "./fr";

/**
 * The guard of `domains.ts`: a key lives in the one domain file that lists
 * its first segment, in both languages. The dictionaries spread the files,
 * so a key in two files would silently keep the last one; the prefix rule
 * makes that impossible, and the count catches a file left out of a spread.
 */

type Files = Record<string, Record<string, Record<string, string>>>;
const FILES: Record<"en" | "fr", Files> = {
  en: import.meta.glob("./en/*.ts", { eager: true }),
  fr: import.meta.glob("./fr/*.ts", { eager: true }),
};
const DICTS = { en, fr };

const domainOf = (path: string) => path.replace(/^.*\/(.+)\.ts$/, "$1") as keyof typeof DOMAINS;

describe("the domain files of the dictionaries", () => {
  it("gives each first segment to one domain only", () => {
    const prefixes = Object.values(DOMAINS).flat();
    expect(prefixes).toHaveLength(new Set(prefixes).size);
  });

  for (const lang of ["en", "fr"] as const) {
    it(`${lang}: one file per domain, each holding the keys of its prefixes only`, () => {
      const files = Object.entries(FILES[lang]);
      expect(files.map(([path]) => domainOf(path)).sort()).toEqual(Object.keys(DOMAINS).sort());
      let count = 0;
      for (const [path, mod] of files) {
        const domain = domainOf(path);
        const prefixes: readonly string[] = DOMAINS[domain];
        const keys = Object.keys(mod[domain] ?? {});
        expect(keys.filter((key) => !prefixes.includes(key.split(".")[0] ?? "")), `${lang}/${domain}.ts`).toEqual([]);
        count += keys.length;
      }
      expect(Object.keys(DICTS[lang])).toHaveLength(count);
    });
  }
});
