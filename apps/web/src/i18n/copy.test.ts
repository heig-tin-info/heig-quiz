import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { en } from "./en";
import { fr } from "./fr";

/**
 * The copy lint (N-I18N-04): what a machine can check of the Voice rules of
 * `apps/web/DESIGN.md` and of the interface glossary
 * (`docs/spec/01-glossaire-et-domaine.md` §1.5, whose enforced variants
 * this table owns). Each rule names the keys it refuses, per language.
 * `copy.exceptions.json` holds the keys that broke a rule when the lint was
 * born and are not rewritten yet. The list only shrinks: a key that no
 * longer breaks its rule must leave it (the test says so), and a key that
 * newly breaks one is refused. `COPY_LINT_WRITE=1` drops the fixed keys
 * from the list and never adds one; `COPY_LINT_WRITE=all` rewrites it from
 * the current dictionaries, for the PR that changes a rule — its additions
 * show in the JSON diff.
 */

type Lang = "fr" | "en";
type Rule = {
  name: string;
  langs: Lang[];
  /** Why, and what to write instead: the message of a failure. */
  fix: string;
  test: (text: string, key: string) => boolean;
};

/** A rule reads the prose, not a placeholder's name (`{pool}` is a variable): one stands in for it. */
const has = (re: RegExp) => (text: string) => re.test(text.replace(/\{\w+\}/g, "x"));
const suffix = (key: string) => key.split(".").pop() ?? "";
/** A ceiling applies to a label; a string with a placeholder is measured elsewhere. */
const longerThan = (max: number) => (text: string) => !text.includes("{") && text.length > max;
/** A sentence is not a button, whatever its key's suffix. */
const isSentence = (text: string) => /[.:]/.test(text);

/** Keys whose value is a button's label: a verb, at most 24 characters. */
const BUTTON = [
  "add", "remove", "delete", "save", "edit", "create", "submit", "confirm", "cancel", "close",
  "back", "next", "retry", "open", "start", "rename", "apply", "reset", "copy", "download",
  "upload", "import", "export", "publish", "release", "launch", "join", "leave", "send",
  "accept", "decline", "undo", "cta", "action",
];
/** The sub-texts under a ceiling (DESIGN.md, Voice): one sentence, a fact the label does not carry. */
const SUBTEXT = ["desc", "hint", "help"];

const BOTH: Lang[] = ["fr", "en"];
const FR: Lang[] = ["fr"];
const EN: Lang[] = ["en"];

const RULES: Rule[] = [
  // Typography (fr).
  { name: "breaking-space-before-double-punctuation", langs: FR, fix: "a narrow no-break space (U+202F) before : ; ? !", test: has(/[  ][:;?!]/) },
  { name: "guillemets-inner-space", langs: FR, fix: "a narrow no-break space inside « »", test: has(/«[  ]|[  ]»/) },
  { name: "curly-apostrophe", langs: BOTH, fix: "the straight apostrophe, as everywhere else", test: has(/[’‘]/) },
  { name: "parenthesised-plural", langs: FR, fix: "a plural key (.one / .many), never (s) or (e)", test: has(/\((e|s|es)\)/) },
  { name: "recorriger-hyphen", langs: FR, fix: "recorriger, recorrection, without a hyphen", test: has(/re-corr/i) },
  { name: "defaut", langs: FR, fix: "« par défaut »", test: has(/\(défaut\)|\bdéfaut :/i) },
  { name: "cliquez-transitive", langs: FR, fix: "cliquez sur", test: has(/\bcliquez (la|le|les|l'|un|une)\b/i) },
  // Prose (both).
  { name: "em-dash-aside", langs: BOTH, fix: "two sentences, or a colon; no em-dash aside", test: has(/ — /) },
  { name: "semicolon", langs: BOTH, fix: "two sentences; no semicolon chain", test: has(/; /) },
  { name: "filler", langs: FR, fix: "delete the reassurance: a sub-text carries a fact the label does not", test: has(/Rien n'est (bloqué|supprimé)|conviennent à la plupart|revenir à tout moment/i) },
  { name: "filler", langs: EN, fix: "delete the reassurance: a sub-text carries a fact the label does not", test: has(/Nothing is (blocked|deleted)|defaults suit most|come back at any time/i) },
  { name: "generic-masculine", langs: FR, fix: "a neutral turn: les étudiants, a passive, an infinitive", test: has(/\bl'étudiant\b[^.]*\b(il|lui)\b/) },
  // Glossary: one word per concept (§1.5).
  { name: "word-pool", langs: FR, fix: "banque", test: has(/\bpools?\b/i) },
  { name: "word-poll", langs: FR, fix: "sondage", test: has(/\bpolls?\b/i) },
  { name: "word-concept", langs: FR, fix: "notion", test: has(/\bconcepts?\b/i) },
  { name: "word-llm", langs: FR, fix: "IA", test: has(/\bLLM\b|modèle de langage/) },
  { name: "word-llm", langs: EN, fix: "AI", test: has(/\bLLM\b/) },
  { name: "word-staff", langs: FR, fix: "équipe enseignante", test: has(/\bstaff\b/i) },
  { name: "word-runner", langs: FR, fix: "exécuteur", test: has(/\brunners?\b/i) },
  { name: "word-calepin", langs: FR, fix: "bloc-notes", test: has(/calepin/i) },
  { name: "word-anneau", langs: FR, fix: "salle d'attente; the ring is an internal word", test: has(/l'anneau\b/i) },
  { name: "word-jalon", langs: FR, fix: "verrou (an evaluation's checkpoint) or point de contrôle (a project's)", test: has(/\bjalons?\b/i) },
  { name: "word-professeur", langs: FR, fix: "enseignant", test: has(/\bprof(esseur)?s?\b/i) },
  { name: "word-eleve", langs: FR, fix: "étudiant", test: has(/\bélèves?\b/i) },
  { name: "word-quiz", langs: FR, fix: "évaluation, examen or exercice; Quiz is the platform's name only", test: has(/\b(le|un|ce|cet|du|au|ces|les|des|votre|vos|chaque|mon|son|notre|aucun|quel|tout|nouveau|même|dernier|premier)\s+quiz\b/i) },
  { name: "word-editer", langs: FR, fix: "modifier", test: has(/\bédit(er|é|ée|és|ées|ez)\b/i) },
  { name: "word-parametres", langs: FR, fix: "réglages", test: has(/\bparamètres\b/i) },
  { name: "word-sauvegarder", langs: FR, fix: "enregistrer (la sauvegarde de la base reste une sauvegarde)", test: has(/\bsauvegard(er|é|ée|és|ées|ez)\b/i) },
  { name: "word-politique", langs: FR, fix: "règle de notation, correction", test: has(/\bpolitiques?\b/i) },
  { name: "word-marque", langs: FR, fix: "note, points or saisie", test: has(/\b(la|une|les|des|vos|votre|sa|ses|cette)\s+marques?\b/i) },
  { name: "word-gele", langs: FR, fix: "figé", test: has(/\bgelée?s?\b/i) },
  { name: "word-soumettre", langs: FR, fix: "rendre", test: has(/\bsoum(ettre|is|ise|ission)/i) },
  // Ceilings (both).
  { name: "button-over-24", langs: BOTH, fix: "a verb, at most 24 characters", test: (t, k) => BUTTON.includes(suffix(k)) && !isSentence(t) && longerThan(24)(t) },
  { name: "tab-over-18", langs: BOTH, fix: "at most 18 characters", test: (t, k) => /\.tab\.[^.]+$/.test(k) && longerThan(18)(t) },
  { name: "subtext-over-110", langs: BOTH, fix: "one sentence of at most 110 characters, carrying a fact the label does not", test: (t, k) => SUBTEXT.includes(suffix(k)) && longerThan(110)(t) },
];

const DICT: Record<Lang, Record<string, string>> = { fr, en };
const EXCEPTIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "copy.exceptions.json");
const exceptions = JSON.parse(readFileSync(EXCEPTIONS_PATH, "utf8")) as Record<string, string[]>;

/** One check per rule and language: its full name, and the keys it refuses today. */
const checks = RULES.flatMap((rule) =>
  rule.langs.map((lang) => {
    const dict = DICT[lang];
    const name = `${lang}-${rule.name}`;
    return { name, lang, fix: rule.fix, found: Object.keys(dict).filter((key) => rule.test(dict[key]!, key)) };
  }),
);

describe("copy lint (N-I18N-04)", () => {
  const write = process.env["COPY_LINT_WRITE"];
  if (write) {
    it(`rewrites the exception list (${write === "all" ? "from the dictionaries" : "fixed keys dropped"})`, () => {
      const next: Record<string, string[]> = {};
      for (const { name, found } of checks) {
        const allowed = new Set(exceptions[name] ?? []);
        const keys = write === "all" ? found : found.filter((k) => allowed.has(k));
        if (keys.length) next[name] = keys;
      }
      writeFileSync(EXCEPTIONS_PATH, `${JSON.stringify(next, null, 2)}\n`);
    });
    return;
  }

  for (const { name, lang, fix, found } of checks) {
    it(`${name}: ${fix}`, () => {
      const allowed = new Set(exceptions[name] ?? []);
      const fresh = found.filter((k) => !allowed.has(k));
      const stale = [...allowed].filter((k) => !found.includes(k));
      expect(
        fresh.map((k) => `${k}: ${JSON.stringify(DICT[lang][k])}`),
        `new offenders of ${name} (${fix})`,
      ).toEqual([]);
      expect(stale, `keys fixed: remove them from copy.exceptions.json (or COPY_LINT_WRITE=1)`).toEqual([]);
    });
  }

  it("lists exceptions under existing rules only", () => {
    const names = new Set(checks.map((c) => c.name));
    expect(Object.keys(exceptions).filter((n) => !names.has(n))).toEqual([]);
  });
});
