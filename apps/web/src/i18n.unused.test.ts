import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { en } from "./i18n/en";
import { fr } from "./i18n/fr";

/**
 * The dictionary only grows back if nothing watches it.
 *
 * `fr` is `Record<keyof Dict, string>`, so TypeScript already guarantees that
 * the two locales carry the SAME keys. What it cannot see is whether the app
 * still reads a key: a screen is rewritten, its strings stay, and the
 * dictionary keeps a paragraph nobody renders (FC-01 found fifty of them).
 *
 * So this test takes the keys of `en` (`i18n/en.ts`) and walks every
 * non-test source of `apps/web/src` and of every `packages/<pkg>/src` looking for each
 * key. A key counts as read when
 *
 *   - it appears as a string literal anywhere — `t("pool.col.name")`,
 *     `"pool.col.name" as keyof Dict`, a `labelKey` in a question-type
 *     package, an entry of a table of keys; a literal is a literal, and
 *     matching them all is what keeps the test from crying wolf; or
 *   - a DYNAMIC prefix covers it. `` t(`eval.state.${state}`) `` builds its
 *     key at run time, and so does `translated(t, defaults, "qt.mcq")`
 *     (`questionTypes.tsx`), which resolves `qt.<type>.<key>`. Every literal
 *     head of a template that interpolates, and every `translated` prefix, is
 *     collected first; a key under one of them is live by construction.
 *
 * The two dictionary files are left out of the corpus — otherwise every key
 * would trivially find itself — but the rest of `i18n/` stays in it, because
 * `formatDuration` in `i18n/index.tsx` reads the `dur.*` keys and nothing
 * else does.
 */

const WEB_SRC = import.meta.dirname;
const REPO = join(WEB_SRC, "..", "..", "..");
const DICTIONARY_FILES = [join(WEB_SRC, "i18n", "en.ts"), join(WEB_SRC, "i18n", "fr.ts")];

/** Every `.ts`/`.tsx` under `dir` that is not a test. */
function sourcesIn(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      sourcesIn(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const keys = Object.keys(en);

const webSources = sourcesIn(WEB_SRC);

const packageSources = readdirSync(join(REPO, "packages")).flatMap((name) => {
  const src = join(REPO, "packages", name, "src");
  try {
    return statSync(src).isDirectory() ? sourcesIn(src) : [];
  } catch {
    return [];
  }
});

/** Every source that could read a key, the dictionaries themselves excluded. */
const corpus = [...webSources, ...packageSources]
  .filter((path) => !DICTIONARY_FILES.includes(path))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n\u0000\n");

/** The literal head of every interpolating template, plus `translated` prefixes. */
const prefixes = [
  ...new Set([
    ...[...corpus.matchAll(/`([A-Za-z0-9_.]*\.)\$\{/g)].map((m) => m[1] ?? ""),
    ...[...corpus.matchAll(/translated\([^,]+,[^,]+,\s*"([^"]+)"\s*\)/g)].map((m) => `${m[1]}.`),
  ]),
].filter((prefix) => prefix !== "");

/** The keys among `candidates` that no literal and no dynamic prefix reads. */
function unread(candidates: string[]): string[] {
  return candidates.filter((key) => {
    const literal = new RegExp(`["'\`]${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
    if (literal.test(corpus)) return false;
    return !prefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
  });
}

describe("the en dictionary", () => {
  it("has keys", () => {
    // A regex that silently matched nothing would make the next cases vacuous.
    expect(keys.length).toBeGreaterThan(1000);
    expect(Object.keys(fr)).toHaveLength(keys.length);
    expect(prefixes.length).toBeGreaterThan(10);
  });

  it("is scanned for in the sources, never in the dictionaries", () => {
    // The walk does reach both files; the filter is what keeps them out.
    for (const file of DICTIONARY_FILES) expect(webSources).toContain(file);
    expect(corpus).not.toContain(`"${keys[0]}": `);
  });

  it("flags a key nobody reads", () => {
    // The honesty check: a scanner that finds everything proves nothing.
    expect(unread(["zz.bogus.neverRendered"])).toEqual(["zz.bogus.neverRendered"]);
  });

  it("carries no key the app never reads", () => {
    expect(unread(keys)).toEqual([]);
  });
});
