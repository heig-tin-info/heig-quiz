import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dictionary only grows back if nothing watches it.
 *
 * `fr` is `Record<keyof Dict, string>`, so TypeScript already guarantees that
 * the two locales carry the SAME keys. What it cannot see is whether the app
 * still reads a key: a screen is rewritten, its strings stay, and the
 * dictionary keeps a paragraph nobody renders (FC-01 found fifty of them).
 *
 * So this test reads the `en` block out of `i18n.tsx` and walks every
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
 * `i18n.tsx` itself is scanned WITHOUT its two dictionary blocks — otherwise
 * every key would trivially find itself — but WITH the rest of the file,
 * because `formatDuration` at the bottom reads the `dur.*` keys and nothing
 * else does.
 */

const WEB_SRC = import.meta.dirname;
const REPO = join(WEB_SRC, "..", "..", "..");
const I18N = join(WEB_SRC, "i18n.tsx");

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

/** The lines of a `const <name> = {` … `};` block, header and closer excluded. */
function blockBounds(lines: string[], header: string): [number, number] {
  const start = lines.findIndex((line) => line.startsWith(header));
  expect(start, `\`${header}\` not found in i18n.tsx`).toBeGreaterThan(-1);
  const end = lines.indexOf("};", start);
  expect(end, `end of \`${header}\` not found in i18n.tsx`).toBeGreaterThan(start);
  return [start, end];
}

const i18nLines = readFileSync(I18N, "utf8").split("\n");
const [enStart, enEnd] = blockBounds(i18nLines, "const en = {");
const [frStart, frEnd] = blockBounds(i18nLines, "const fr: Record<keyof Dict, string> = {");

const keys = i18nLines
  .slice(enStart + 1, enEnd)
  .map((line) => /^ {2}"([^"]+)":/.exec(line)?.[1])
  .filter((key): key is string => key !== undefined);

/** `i18n.tsx` minus the two dictionaries: the code that reads them, alone. */
const i18nCode = [
  ...i18nLines.slice(0, enStart + 1),
  ...i18nLines.slice(enEnd, frStart + 1),
  ...i18nLines.slice(frEnd),
].join("\n");

const packageSources = readdirSync(join(REPO, "packages")).flatMap((name) => {
  const src = join(REPO, "packages", name, "src");
  try {
    return statSync(src).isDirectory() ? sourcesIn(src) : [];
  } catch {
    return [];
  }
});

const corpus = [...sourcesIn(WEB_SRC), ...packageSources]
  .map((path) => (path === I18N ? i18nCode : readFileSync(path, "utf8")))
  .join("\n\u0000\n");

/** The literal head of every interpolating template, plus `translated` prefixes. */
const prefixes = [
  ...new Set([
    ...[...corpus.matchAll(/`([A-Za-z0-9_.]*\.)\$\{/g)].map((m) => m[1] ?? ""),
    ...[...corpus.matchAll(/translated\([^,]+,[^,]+,\s*"([^"]+)"\s*\)/g)].map((m) => `${m[1]}.`),
  ]),
].filter((prefix) => prefix !== "");

describe("the en dictionary", () => {
  it("has keys", () => {
    // A regex that silently matched nothing would make the next case vacuous.
    expect(keys.length).toBeGreaterThan(1000);
    expect(prefixes.length).toBeGreaterThan(10);
  });

  it("carries no key the app never reads", () => {
    const unread = keys.filter((key) => {
      const literal = new RegExp(`["'\`]${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
      if (literal.test(corpus)) return false;
      return !prefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
    });
    expect(unread).toEqual([]);
  });
});
