import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { de } from "./de";
import { DOMAINS } from "./domains";
import { en } from "./en";

/**
 * The translated languages (ADR-140 §2, §7). English and French are
 * written; a translated language is drafted from the English, so it keeps
 * the English placeholders exactly (French may differ), and
 * `<lang>.status.json` records, per key:
 *
 * - `drafted`: the hash of the English the value was drafted from. When the
 *   English changes, the stamp no longer matches and this test fails until
 *   the value is re-drafted and re-stamped: a stale draft cannot ship
 *   silently.
 * - `reviewed`: the keys a person has read, each with the hash of the
 *   English and the translation as they read them. Either one changing makes
 *   the review stale; the re-stamp drops it.
 *
 * `I18N_STATUS` drives it, like `COPY_LINT_WRITE` in `copy.test.ts`; from
 * `apps/web`, `I18N_STATUS=<mode> pnpm exec vitest run src/i18n/status.test.ts`:
 * - `stamp`: re-stamp every key from the current English, drop stale reviews.
 *   The stamp says "drafted from this English": re-draft first.
 * - `review=de:pool,qt.mcq.`: mark reviewed the keys of a domain (`pool`) or
 *   under a key prefix (`qt.mcq.`), as they read today.
 * - `report`: print the drafted and reviewed counts per domain (add
 *   `--reporter=default`: the agent reporter hides a passing test's output).
 */

const TRANSLATED = { de } satisfies Record<string, Record<keyof typeof en, string>>;
type Lang = keyof typeof TRANSLATED;
type Status = { drafted: Record<string, string>; reviewed: Record<string, string> };

const DIR = dirname(fileURLToPath(import.meta.url));
const pathOf = (lang: Lang) => join(DIR, `${lang}.status.json`);
const hash = (...texts: string[]) => createHash("sha256").update(texts.join("\u0000")).digest("hex").slice(0, 8);
const sorted = (record: Record<string, string>) =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));

const KEYS = Object.keys(en) as (keyof typeof en)[];
const draftStamp = (key: keyof typeof en) => hash(en[key]);
const reviewStamp = (lang: Lang, key: keyof typeof en) => hash(en[key], TRANSLATED[lang][key]);
const domainOf = (key: string) =>
  Object.entries(DOMAINS).find(([, prefixes]) => (prefixes as readonly string[]).includes(key.split(".")[0]!))?.[0];

describe("review state of the translated languages (ADR-140 §7)", () => {
  const mode = process.env["I18N_STATUS"] ?? "";
  for (const lang of Object.keys(TRANSLATED) as Lang[]) {
    const status = JSON.parse(readFileSync(pathOf(lang), "utf8")) as Status;
    const stillReviewed = (key: string) => key in en && status.reviewed[key] === reviewStamp(lang, key as keyof typeof en);

    if (mode === "stamp" || mode.startsWith(`review=${lang}:`)) {
      const marks = mode.startsWith("review=") ? mode.slice(`review=${lang}:`.length).split(",") : [];
      const marked = (key: string) => marks.some((m) => (m.endsWith(".") ? key.startsWith(m) : domainOf(key) === m));
      it(`${lang}: rewrites ${lang}.status.json (${mode})`, () => {
        const drafted = mode === "stamp" ? Object.fromEntries(KEYS.map((k) => [k, draftStamp(k)])) : status.drafted;
        const reviewed = Object.fromEntries(
          KEYS.filter((k) => stillReviewed(k) || (marked(k) && drafted[k] === draftStamp(k))).map((k) => [k, reviewStamp(lang, k)]),
        );
        writeFileSync(pathOf(lang), `${JSON.stringify({ drafted: sorted(drafted), reviewed: sorted(reviewed) }, null, 2)}\n`);
      });
      continue;
    }

    if (mode === "report") {
      it(`${lang}: reports what is left to review`, () => {
        const rows = Object.keys(DOMAINS).map((domain) => {
          const keys = KEYS.filter((k) => domainOf(k) === domain);
          return `${domain.padEnd(12)} ${String(keys.length).padStart(5)} drafted ${String(keys.filter(stillReviewed).length).padStart(5)} reviewed`;
        });
        console.log(`${lang}: drafted / reviewed per domain\n${rows.join("\n")}`);
      });
    }

    it(`${lang}: every value is stamped with the English it was drafted from`, () => {
      const stale = KEYS.filter((k) => status.drafted[k] !== draftStamp(k));
      const gone = Object.keys(status.drafted).filter((k) => !(k in en));
      expect(
        [...stale, ...gone],
        `The English of these keys changed since their ${lang} draft (or they are new, or gone): re-draft their ${lang} value from the current English, then re-stamp with I18N_STATUS=stamp (apps/web/src/i18n/status.test.ts)`,
      ).toEqual([]);
    });

    it(`${lang}: keeps exactly the placeholders of the English`, () => {
      const names = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(" ");
      expect(KEYS.filter((k) => names(TRANSLATED[lang][k]) !== names(en[k]))).toEqual([]);
    });

    it(`${lang}: every review still matches what was reviewed`, () => {
      expect(
        Object.keys(status.reviewed).filter((k) => !stillReviewed(k)),
        `These reviews are stale (the English or the ${lang} value changed since): the re-stamp (I18N_STATUS=stamp) drops them`,
      ).toEqual([]);
    });
  }
});
