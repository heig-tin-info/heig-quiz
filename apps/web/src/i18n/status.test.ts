import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { TranslatedLocale } from "@quiz/domain";

import { de } from "./de";
import { DOMAINS } from "./domains";
import { en } from "./en";
import { it as itDict } from "./it";

/**
 * The translated languages (ADR-140 §2, §7). English and French are
 * written; a translated language is drafted from the English, so it keeps
 * the English placeholders exactly (French may differ), and
 * `<lang>.status.json` maps each key to its review state:
 *
 * - `"1a2b3c4d"`, drafted: the hash of the English the value was drafted
 *   from. When the English changes, the stamp no longer matches and this
 *   test fails until the value is re-drafted and re-stamped: a stale draft
 *   cannot ship silently.
 * - `"r:5e6f7a8b"`, reviewed by a person: the hash of the English and the
 *   translation as they read them. Either one changing makes the review
 *   stale.
 *
 * `I18N_STATUS` drives it, like `COPY_LINT_WRITE` in `copy.test.ts`; from
 * `apps/web`, `I18N_STATUS=<mode> pnpm exec vitest run src/i18n/status.test.ts`:
 * - `stamp`: re-stamp every key that is not validly reviewed from the
 *   current English (a stale review falls back to a draft stamp). The stamp
 *   says "drafted from this English": re-draft first.
 * - `review=de:pool,qt.mcq.,qt.mcq.r.score`: record as reviewed, as they
 *   read today, the keys of a domain (`pool`), under a key prefix ending in
 *   a dot (`qt.mcq.`), or one key. A mark that matches no key fails.
 */

/**
 * Every translated language of the registry (`LOCALE_INFO`): one added there
 * is a compile error here until its dictionary is.
 */
type Lang = TranslatedLocale;
const TRANSLATED: Record<Lang, Record<keyof typeof en, string>> = { de, it: itDict };
type Key = keyof typeof en;

const DIR = dirname(fileURLToPath(import.meta.url));
const pathOf = (lang: Lang) => join(DIR, `${lang}.status.json`);
const hash = (...texts: string[]) => createHash("sha256").update(texts.join("\u0000")).digest("hex").slice(0, 8);

const KEYS = (Object.keys(en) as Key[]).sort();
const domainOf = (key: string) =>
  Object.keys(DOMAINS).find((d) => (DOMAINS[d as keyof typeof DOMAINS] as readonly string[]).includes(key.split(".")[0]!));
const STAMP = "I18N_STATUS=stamp pnpm exec vitest run src/i18n/status.test.ts";
/** `de/pool.ts: pool.a, pool.b`: the files to edit, under `apps/web/src/i18n/`. */
const byFile = (lang: Lang, keys: string[]) =>
  [...new Set(keys.map(domainOf))].map((d) => `${lang}/${d}.ts: ${keys.filter((k) => domainOf(k) === d).join(", ")}`);

describe("the translated languages (ADR-140 §7)", () => {
  const mode = process.env["I18N_STATUS"] ?? "";
  for (const lang of Object.keys(TRANSLATED) as Lang[]) {
    const status = JSON.parse(readFileSync(pathOf(lang), "utf8")) as Record<string, string>;
    const drafted = (k: Key) => hash(en[k]);
    const reviewed = (k: Key) => `r:${hash(en[k], TRANSLATED[lang][k])}`;
    const write = (next: (k: Key) => string) =>
      writeFileSync(pathOf(lang), `${JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, next(k)])), null, 2)}\n`);

    if (mode === "stamp") {
      it(`${lang}: re-stamps ${lang}.status.json from the current English`, () => {
        write((k) => (status[k] === reviewed(k) ? reviewed(k) : drafted(k)));
      });
      continue;
    }
    if (mode.startsWith(`review=${lang}:`)) {
      const marks = mode.slice(`review=${lang}:`.length).split(",").filter(Boolean);
      const matches = (mark: string, k: string) =>
        mark === k || (mark.endsWith(".") && k.startsWith(mark)) || domainOf(k) === mark;
      it(`${lang}: records the review of ${marks.join(", ")}`, () => {
        const marked = new Set(KEYS.filter((k) => marks.some((m) => matches(m, k))));
        expect(
          marks.filter((m) => !KEYS.some((k) => matches(m, k))),
          "marks that match no key (a key, a prefix ending in a dot, or a domain): nothing written",
        ).toEqual([]);
        // A review never stands in for a stamp: a draft older than its English is re-drafted first.
        expect(
          byFile(lang, [...marked].filter((k) => status[k] !== drafted(k) && status[k] !== reviewed(k))),
          `The English of these keys changed since their ${lang} draft: re-draft them, re-stamp (from apps/web: ${STAMP}), then review. Nothing written`,
        ).toEqual([]);
        write((k) => (marked.has(k) ? reviewed(k) : status[k]!));
      });
      continue;
    }

    it(`${lang}: keeps exactly the placeholders of the English`, () => {
      const names = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(" ");
      expect(byFile(lang, KEYS.filter((k) => names(TRANSLATED[lang][k]) !== names(en[k])))).toEqual([]);
    });

    it(`${lang}: every value is stamped with the English it was drafted from`, () => {
      const stale = KEYS.filter((k) => !status[k]?.startsWith("r:") && status[k] !== drafted(k));
      const gone = Object.keys(status).filter((k) => !(k in en));
      expect(
        [...byFile(lang, stale), ...gone],
        `New keys, or keys whose English changed since their ${lang} draft (or gone from English): re-draft them in apps/web/src/i18n/<file> from the current English, then, from apps/web: ${STAMP}`,
      ).toEqual([]);
    });

    it(`${lang}: every review still matches what was reviewed`, () => {
      expect(
        byFile(lang, KEYS.filter((k) => status[k]?.startsWith("r:") && status[k] !== reviewed(k))),
        `The English or the ${lang} value of these reviewed keys changed (apps/web/src/i18n/<file>): re-draft if the English changed, re-stamp (from apps/web: ${STAMP}), then a person re-records the review: I18N_STATUS=review=${lang}:<key>`,
      ).toEqual([]);
    });
  }
});
