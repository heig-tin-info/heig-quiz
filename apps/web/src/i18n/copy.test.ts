import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { en } from "./en";
import { fr } from "./fr";

/**
 * The copy lint (N-I18N-04): what a machine can check of the Voice rules of
 * `apps/web/DESIGN.md` and of the interface glossary
 * (`docs/spec/01-glossaire-et-domaine.md` §1.5). Each rule names the keys
 * it refuses; `copy.exceptions.json` holds the keys that broke a rule when
 * the lint was born and are not rewritten yet. The list only shrinks: a key
 * that no longer breaks its rule must leave the list (the test says so), and
 * a key that newly breaks one is refused. `COPY_LINT_WRITE=1` rewrites the
 * list from the current dictionaries, for the PR that fixes a batch.
 */

type Lang = "fr" | "en";
type Rule = {
  name: string;
  lang: Lang;
  /** Why, and what to write instead: the message of a failure. */
  fix: string;
  test: (text: string, key: string) => boolean;
};

const has = (re: RegExp) => (text: string) => re.test(text);
const suffix = (key: string) => key.split(".").pop() ?? "";
const suffixIn = (names: string[]) => (key: string) => names.includes(suffix(key));

/** Keys whose value is a button's label: a verb, at most 24 characters. */
const BUTTON = [
  "add", "remove", "delete", "save", "edit", "create", "submit", "confirm", "cancel", "close",
  "back", "next", "retry", "open", "start", "rename", "apply", "reset", "copy", "download",
  "upload", "import", "export", "publish", "release", "launch", "join", "leave", "send",
  "accept", "decline", "undo", "done", "cta", "action",
];
const SUBTEXT = ["desc", "hint", "help", "caption", "footnote", "sub"];

const longerThan = (max: number) => (text: string) => !text.includes("{") && text.length > max;

export const RULES: Rule[] = [
  // Typography (fr).
  { name: "fr-breaking-space-before-double-punctuation", lang: "fr", fix: "a narrow no-break space (U+202F) before : ; ? !", test: has(/ [:;?!]/) },
  { name: "fr-guillemets-inner-space", lang: "fr", fix: "a narrow no-break space inside « »", test: has(/« | »/) },
  { name: "fr-curly-apostrophe", lang: "fr", fix: "the straight apostrophe, as everywhere else", test: has(/[’‘]/) },
  { name: "fr-parenthesised-plural", lang: "fr", fix: "a plural key (.one / .many), never (s) or (e)", test: has(/\((e|s|es)\)/) },
  { name: "fr-recorriger-hyphen", lang: "fr", fix: "recorriger, recorrection, without a hyphen", test: has(/re-corr/i) },
  { name: "fr-defaut", lang: "fr", fix: "« par défaut »", test: has(/\(défaut\)|\bdéfaut :/i) },
  { name: "fr-cliquez-transitive", lang: "fr", fix: "cliquez sur", test: has(/\bcliquez (la|le|les|l'|un|une)\b/i) },
  // Prose (both).
  { name: "fr-em-dash-aside", lang: "fr", fix: "two sentences, or a colon; no em-dash aside", test: has(/ — /) },
  { name: "en-em-dash-aside", lang: "en", fix: "two sentences, or a colon; no em-dash aside", test: has(/ — /) },
  { name: "fr-semicolon", lang: "fr", fix: "two sentences; no semicolon chain", test: has(/\s; /) },
  { name: "en-semicolon", lang: "en", fix: "two sentences; no semicolon chain", test: has(/; /) },
  { name: "fr-filler", lang: "fr", fix: "delete the reassurance: a sub-text carries a fact the label does not", test: has(/Rien n'est (bloqué|supprimé|écrit|envoyé|perdu|enregistré)|conviennent à la plupart|revenir à tout moment/i) },
  { name: "en-filler", lang: "en", fix: "delete the reassurance: a sub-text carries a fact the label does not", test: has(/Nothing is (blocked|deleted|written|sent|lost)|defaults suit most|come back at any time/i) },
  { name: "fr-generic-masculine", lang: "fr", fix: "a neutral turn: les étudiants, a passive, an infinitive", test: has(/\bl'étudiant\b[^.]*\b(il|lui)\b/) },
  // Glossary (fr): one word per concept, §1.5.
  { name: "fr-word-pool", lang: "fr", fix: "banque", test: has(/\bpools?\b/i) },
  { name: "fr-word-poll", lang: "fr", fix: "sondage", test: has(/\bpolls?\b/i) },
  { name: "fr-word-concept", lang: "fr", fix: "notion", test: has(/\bconcepts?\b/i) },
  { name: "fr-word-llm", lang: "fr", fix: "IA", test: has(/\bLLM\b|modèle de langage/) },
  { name: "fr-word-staff", lang: "fr", fix: "équipe enseignante", test: has(/\bstaff\b/i) },
  { name: "fr-word-runner", lang: "fr", fix: "exécuteur", test: has(/\brunners?\b/i) },
  { name: "fr-word-calepin", lang: "fr", fix: "bloc-notes", test: has(/calepin/i) },
  { name: "fr-word-anneau", lang: "fr", fix: "salle d'attente; the ring is an internal word", test: has(/l'anneau\b/i) },
  { name: "fr-word-jalon", lang: "fr", fix: "verrou (an evaluation's checkpoint) or point de contrôle (a project's)", test: has(/\bjalons?\b/i) },
  { name: "fr-word-professeur", lang: "fr", fix: "enseignant", test: has(/\bprof(esseur)?s?\b/i) },
  { name: "fr-word-eleve", lang: "fr", fix: "étudiant", test: has(/\bélèves?\b/i) },
  { name: "fr-word-quiz", lang: "fr", fix: "évaluation, examen or exercice; Quiz is the platform's name only", test: has(/\b(le|un|ce|cet|du|au|ces|les|des|votre|vos|chaque|mon|son|notre|aucun|quel|tout|nouveau|même|dernier|premier)\s+quiz\b/i) },
  { name: "fr-word-editer", lang: "fr", fix: "modifier", test: has(/\bédit(er|é|ée|és|ées|ez)\b/i) },
  { name: "fr-word-parametres", lang: "fr", fix: "réglages", test: has(/\bparamètres\b/i) },
  { name: "fr-word-sauvegarder", lang: "fr", fix: "enregistrer (la sauvegarde de la base reste une sauvegarde)", test: has(/\bsauvegard(er|é|ée|és|ées|ez)\b/i) },
  { name: "fr-word-politique", lang: "fr", fix: "règle de notation, correction", test: has(/\bpolitiques?\b/i) },
  { name: "fr-word-marque", lang: "fr", fix: "note, points or saisie", test: has(/\bmarques?\b/i) },
  { name: "fr-word-gele", lang: "fr", fix: "figé", test: has(/\bgelée?s?\b/i) },
  { name: "fr-word-soumettre", lang: "fr", fix: "rendre", test: has(/\bsoum(ettre|is|ise|ission)/i) },
  { name: "en-word-llm", lang: "en", fix: "AI", test: has(/\bLLM\b/) },
  // Ceilings (both).
  { name: "fr-button-over-24", lang: "fr", fix: "a verb, at most 24 characters", test: (t, k) => suffixIn(BUTTON)(k) && longerThan(24)(t) },
  { name: "en-button-over-24", lang: "en", fix: "a verb, at most 24 characters", test: (t, k) => suffixIn(BUTTON)(k) && longerThan(24)(t) },
  { name: "fr-tab-over-18", lang: "fr", fix: "at most 18 characters", test: (t, k) => /\.tab\.[^.]+$/.test(k) && longerThan(18)(t) },
  { name: "en-tab-over-18", lang: "en", fix: "at most 18 characters", test: (t, k) => /\.tab\.[^.]+$/.test(k) && longerThan(18)(t) },
  { name: "fr-subtext-over-110", lang: "fr", fix: "one sentence of at most 110 characters, carrying a fact the label does not", test: (t, k) => suffixIn(SUBTEXT)(k) && t.length > 110 },
  { name: "en-subtext-over-110", lang: "en", fix: "one sentence of at most 110 characters, carrying a fact the label does not", test: (t, k) => suffixIn(SUBTEXT)(k) && t.length > 110 },
];

const DICT: Record<Lang, Record<string, string>> = { fr, en };
const EXCEPTIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "copy.exceptions.json");

function offenders(rule: Rule): string[] {
  const dict = DICT[rule.lang];
  return Object.keys(dict).filter((key) => rule.test(dict[key]!, key));
}

function readExceptions(): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(EXCEPTIONS_PATH, "utf8")) as Record<string, string[]>;
  } catch {
    return {};
  }
}

describe("copy lint (N-I18N-04)", () => {
  if (process.env["COPY_LINT_WRITE"]) {
    it("rewrites the exception list from the current dictionaries", () => {
      const next: Record<string, string[]> = {};
      for (const rule of RULES) {
        const keys = offenders(rule);
        if (keys.length) next[rule.name] = keys;
      }
      writeFileSync(EXCEPTIONS_PATH, `${JSON.stringify(next, null, 2)}\n`);
      expect(true).toBe(true);
    });
    return;
  }

  const exceptions = readExceptions();

  for (const rule of RULES) {
    it(`${rule.name}: ${rule.fix}`, () => {
      const found = new Set(offenders(rule));
      const allowed = new Set(exceptions[rule.name] ?? []);
      const fresh = [...found].filter((k) => !allowed.has(k));
      const stale = [...allowed].filter((k) => !found.has(k));
      expect(
        fresh.map((k) => `${k}: ${JSON.stringify(DICT[rule.lang][k])}`),
        `new offenders of ${rule.name} (${rule.fix})`,
      ).toEqual([]);
      expect(stale, `keys fixed: remove them from copy.exceptions.json (or COPY_LINT_WRITE=1)`).toEqual([]);
    });
  }

  it("names no rule twice", () => {
    expect(new Set(RULES.map((r) => r.name)).size).toBe(RULES.length);
  });
});
