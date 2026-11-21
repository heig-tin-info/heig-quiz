import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LABELS } from "@quiz/docexport";
import { type Locale, LOCALES } from "@quiz/domain";

import { de } from "./de";
import { en } from "./en";
import { fr } from "./fr";
import { it as itDict } from "./it";

/**
 * The copy lint (N-I18N-04): what a machine can check of the Voice rules of
 * `apps/web/DESIGN.md` and of the interface glossary
 * (`docs/spec/01-glossaire-et-domaine.md` §1.5, whose enforced variants
 * this table owns). Each rule names the keys it refuses, per language:
 * the written English and French, and the translated German and Italian
 * (ADR-140), which are drafted by the same rules.
 * `copy.exceptions.json` holds the keys that broke a rule when the lint was
 * born and are not rewritten yet. The list only shrinks: a key that no
 * longer breaks its rule must leave it (the test says so), and a key that
 * newly breaks one is refused. `COPY_LINT_WRITE=1` drops the fixed keys
 * from the list and never adds one; `COPY_LINT_WRITE=all` rewrites it from
 * the current dictionaries, for the PR that changes a rule — its additions
 * show in the JSON diff.
 */

/**
 * The dictionaries the lint reads, one per interface language: the written
 * English and French, the translated German and Italian (ADR-140). Keyed by
 * the registry: a language added there is a compile error here until its
 * dictionary is.
 */
const DICTS: Record<Locale, Record<keyof typeof en, string>> = { en, fr, de, it: itDict };
const DICT: Record<Locale, Record<string, string>> = DICTS;
type Rule = {
  name: string;
  langs: Locale[];
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

/** The keys that speak of an account's identity and its end (ADR-117): the glossary's anonymized and dormant hold there. */
const ACCOUNT_KEY = /^(account|admin\.inactive)\./;
/**
 * The keys that speak of the components of the mean (ADR-131): the
 * glossary's component holds there. By prefix: a circuit's electrical
 * components are not these, and the rest of `gbook.` may speak of a group
 * project.
 */
const COMPONENT_KEY = /^(courses\.(settings\.)?components|gbook\.(settings|head|noComponent|componentMean|mean\.components|refusal\.component))/;

/** « Répartition » names a group set (refused) unless it is a distribution (glossary §1.5). */
const REPARTITION = /\brépartitions?\b(?! (des (notes|réponses|points|scores)|par question)\b)/i;

/** Every language of the dictionary. */
const ALL = Object.keys(DICT) as Locale[];
const FR: Locale[] = ["fr"];
const EN: Locale[] = ["en"];
const DE: Locale[] = ["de"];
const IT: Locale[] = ["it"];

/** Prose with its placeholders and inline code taken out: `dir` in backticks is a command, not an address. */
const prose = (re: RegExp) => (text: string) => has(re)(text.replace(/`[^`]*`/g, "x"));

const RULES: Rule[] = [
  // Typography (fr).
  { name: "breaking-space-before-double-punctuation", langs: FR, fix: "a narrow no-break space (U+202F) before : ; ? !", test: has(/[  ][:;?!]/) },
  { name: "guillemets-inner-space", langs: FR, fix: "a narrow no-break space inside « »", test: has(/«[  ]|[  ]»/) },
  { name: "curly-apostrophe", langs: ALL, fix: "the straight apostrophe, as everywhere else", test: has(/[’‘]/) },
  { name: "parenthesised-plural", langs: FR, fix: "a plural key (.one / .many), never (s) or (e)", test: has(/\((e|s|es)\)/) },
  { name: "recorriger-hyphen", langs: FR, fix: "recorriger, recorrection, without a hyphen", test: has(/re-corr/i) },
  { name: "defaut", langs: FR, fix: "« par défaut »", test: has(/\(défaut\)|\bdéfaut :/i) },
  { name: "cliquez-transitive", langs: FR, fix: "cliquez sur", test: has(/\bcliquez (la|le|les|l'|un|une)\b/i) },
  // Typography (de): Swiss spelling, Swiss quotation marks.
  { name: "eszett", langs: DE, fix: "ss: Swiss German writes no ß", test: has(/ß/) },
  { name: "quotation-marks", langs: DE, fix: "guillemets «…», never „…“ or “…”", test: has(/[„“”]/) },
  // Typography (it): accents, never an apostrophe for one; Swiss quotation marks.
  { name: "apostrophe-accent", langs: IT, fix: "the accent: è, È, perché, più, già, può, cioè", test: has(/(^|[^\p{L}])(E|e|perche|piu|gia|puo|cioe|pero|sara|verra|attivita|qualita|unita|modalita|possibilita|citta)'(?![\p{L}])/iu) },
  { name: "quotation-marks", langs: IT, fix: "guillemets «…», never “…” or „…“", test: has(/[„“”]/) },
  // Prose (all).
  { name: "em-dash-aside", langs: ALL, fix: "two sentences, or a colon; no em-dash aside", test: has(/ — /) },
  { name: "semicolon", langs: ALL, fix: "two sentences; no semicolon chain", test: has(/; /) },
  { name: "informal-address", langs: DE, fix: "Sie, Ihr: the reader is never addressed as du or ihr", test: prose(/\b([Dd]u|[Dd]ein(e|em|en|er|es)?|[Dd]ir|[Dd]ich|[Ee]uch|[Ee]uer|[Ee]ure[mnrs]?)\b/) },
  // «Gestisci le tue app» is Teams' own menu, quoted as Teams names it (copy.exceptions.json).
  { name: "informal-address", langs: IT, fix: "lei (lowercase), or an infinitive: the reader is never addressed as tu or voi", test: prose(/(^|[^\p{L}'])(tu|tuo|tua|tuoi|tue|ti|te|voi|vostr[oaie])(?![\p{L}'])/iu) },
  { name: "capitalised-lei", langs: IT, fix: "lei, sua, suo, le in lowercase: the formal address is never capitalised", test: (t) => /[\p{Ll},;] (Lei|Sua|Suo|Sue|Suoi|Le)(?![\p{L}'])/u.test(t.replace(/`[^`]*`/g, "x")) },
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
  // A teacher's seat in a classroom (ADR-018): s'inscrire; rejoindre stays a group's (F-PROJ-22).
  { name: "word-join-classroom", langs: FR, fix: "s'inscrire comme étudiant; rejoindre is a group's word", test: has(/\brejoindre (comme|la classe|cette classe|une classe)\b/i) },
  // A group set (ADR-070, 2026-11-17): « groupes », shown by its name; « répartition des notes / des réponses / par question » is a distribution, and stays.
  { name: "word-repartition", langs: FR, fix: "groupes: a group set is « groupes », shown by its own name", test: has(REPARTITION) },
  { name: "word-codespace", langs: ALL, fix: "workspace, espace de travail, Arbeitsbereich; codespace is an internal word", test: has(/\bcodespaces?\b/i) },
  // A component of the mean (ADR-131): never a group, which is the students' (ADR-070), nor a category, which is a pool's.
  { name: "word-component", langs: FR, fix: "composante", test: (t, k) => COMPONENT_KEY.test(k) && has(/\b(groupes?|catégories?)\b/i)(t) },
  { name: "word-component", langs: EN, fix: "component", test: (t, k) => COMPONENT_KEY.test(k) && has(/\b(groups?|categor(y|ies))\b/i)(t) },
  // An account's end (ADR-117): anonymized, never deleted; dormant, never archived (a classroom's state).
  { name: "word-account-deleted", langs: FR, fix: "anonymisé: the results stay, only the identity leaves", test: (t, k) => ACCOUNT_KEY.test(k) && has(/supprim/i)(t) },
  { name: "word-account-deleted", langs: EN, fix: "anonymized: the results stay, only the identity leaves", test: (t, k) => ACCOUNT_KEY.test(k) && has(/\bdelet/i)(t) },
  { name: "word-account-archived", langs: FR, fix: "en sommeil (a dormant account); archivé is a classroom's", test: (t, k) => ACCOUNT_KEY.test(k) && has(/archiv/i)(t) },
  { name: "word-account-archived", langs: EN, fix: "dormant; archived is a classroom's", test: (t, k) => ACCOUNT_KEY.test(k) && has(/archiv/i)(t) },
  // A student's request on a graded question (ADR-139): a contestation, never a claim nor an appeal.
  { name: "word-contestation", langs: FR, fix: "contestation, contester", test: has(/\b(réclamations?|recours)\b/i) },
  // The German never-words of the glossary (§1.5), each wrong wherever it stands: Schüler,
  // Dozent, Lehrer, Rückmeldung, einreichen, Benotung, Evaluation, and «das/ein Quiz» for an evaluation.
  { name: "word-schueler", langs: DE, fix: "Studierende", test: has(/\bSchüler/i) },
  { name: "word-dozent", langs: DE, fix: "Lehrperson", test: has(/\bDozent/i) },
  { name: "word-lehrer", langs: DE, fix: "Lehrperson, Lehrteam", test: has(/\bLehrer(in|innen|n|s)?\b/i) },
  { name: "word-rueckmeldung", langs: DE, fix: "Korrektur", test: has(/Rückmeldung/i) },
  { name: "word-einreichen", langs: DE, fix: "abgeben, Abgabe", test: has(/\b(einreich|eingereicht)/i) },
  { name: "word-benotung", langs: DE, fix: "Korrektur, korrigieren", test: has(/\bbenot/i) },
  { name: "word-evaluation", langs: DE, fix: "Test, Prüfung or Übung", test: has(/\bEvaluation/i) },
  { name: "word-quiz", langs: DE, fix: "Test, Prüfung or Übung; Quiz is the platform's name only", test: has(/\b(das|ein|dieses|diesem|dem|des|jedes|jedem|kein|keinem|ihr|ihrem|ihres|neues)\s+Quiz(?![-\w])/i) },
  // The Italian never-words of the glossary (§1.5), each wrong wherever it stands: voto, alunno,
  // allievo, professore, insegnante, feedback, sottomettere, and «il/un/questo quiz» for an evaluation.
  { name: "word-voto", langs: IT, fix: "nota: Swiss Italian", test: has(/\bvot[oi]\b/i) },
  { name: "word-alunno", langs: IT, fix: "studente in a label, a neutral turn in prose", test: has(/\b(alunn|alliev)[oaie]\b/i) },
  { name: "word-professore", langs: IT, fix: "docente, team docente", test: has(/\b(professor[ei]|professoress[ae]|insegnant[ei])\b/i) },
  { name: "word-feedback", langs: IT, fix: "correzione", test: has(/\bfeedback\b/i) },
  { name: "word-sottomettere", langs: IT, fix: "consegnare, consegna", test: has(/\bsottome(tt|ss)/i) },
  { name: "word-quiz", langs: IT, fix: "valutazione, esame or esercizio; Quiz is the platform's name only", test: has(/\b(il|un|questo|quel|ogni|nessun|del|al|nel|dal|sul|i|dei|ai|nei|dai|sui|nuovo|primo|ultimo|stesso|suo|proprio)\s+quiz\b/i) },
  // Ceilings (all).
  { name: "button-over-24", langs: ALL, fix: "a verb, at most 24 characters", test: (t, k) => BUTTON.includes(suffix(k)) && !isSentence(t) && longerThan(24)(t) },
  { name: "tab-over-18", langs: ALL, fix: "at most 18 characters", test: (t, k) => /\.tab\.[^.]+$/.test(k) && longerThan(18)(t) },
  // A summary tile of the activities page shares its label row with a chip: at 390 px, 20 characters take two lines (ADR-140).
  { name: "tile-label-over-20", langs: ALL, fix: "at most 20 characters", test: (t, k) => /^activities\.summary\.[^.]+$/.test(k) && longerThan(20)(t) },
  { name: "subtext-over-110", langs: ALL, fix: "one sentence of at most 110 characters, carrying a fact the label does not", test: (t, k) => SUBTEXT.includes(suffix(k)) && longerThan(110)(t) },
];

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

  it("scopes word-component to the keys of the components of the mean, and to no circuit's", () => {
    const scoped = Object.keys(en).filter((key) => COMPONENT_KEY.test(key));
    expect(scoped).toEqual(expect.arrayContaining(["courses.components.add", "gbook.settings.component", "gbook.head.in", "gbook.noComponent.help"]));
    expect(scoped.filter((key) => !/^(courses|gbook)\./.test(key))).toEqual([]);
  });

  it("lists exceptions under existing rules only", () => {
    const names = new Set(checks.map((c) => c.name));
    expect(Object.keys(exceptions).filter((n) => !names.has(n))).toEqual([]);
  });
});

/** The French help pages speak the interface's words: no « répartition » for a group set there either. */
const HELP_FR = import.meta.glob("../help/*.fr.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("copy lint of the French help pages (N-I18N-04)", () => {
  it("never calls a group set a « répartition »", () => {
    expect(Object.keys(HELP_FR).length).toBeGreaterThan(0);
    expect(Object.keys(HELP_FR).filter((file) => REPARTITION.test(HELP_FR[file]!))).toEqual([]);
  });
});

/**
 * The fixed words of an exported document (ADR-125): a student reads them on
 * a hand-out or on their own copy, so the same rules hold, with no
 * exception, and every word is short — a label, or one sentence of a toast's
 * length at most.
 */
const DOCUMENT_WORDS = Object.fromEntries(LOCALES.map((lang): [Locale, Record<string, string>] => [lang, { ...LABELS[lang] }]));
const DOCUMENT_WORD_MAX = 80;

describe("copy lint of a document's fixed words (N-I18N-04, ADR-125)", () => {
  it.each(LOCALES)("%s: every rule holds, every word is short", (lang) => {
    const words = DOCUMENT_WORDS[lang]!;
    const offenders = RULES.filter((rule) => rule.langs.includes(lang)).flatMap((rule) =>
      Object.keys(words)
        .filter((key) => rule.test(words[key]!, key))
        .map((key) => `${rule.name} (${rule.fix}): ${key} = ${JSON.stringify(words[key])}`),
    );
    expect(offenders).toEqual([]);
    expect(Object.keys(words).filter((key) => words[key]!.length > DOCUMENT_WORD_MAX)).toEqual([]);
  });
});
