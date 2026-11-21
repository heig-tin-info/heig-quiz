# ADR-140 — Interface languages: German and Italian as translated languages, one locale registry

## Status

Accepted (2026-11-21, decided by the product owner on issue #543): §1–§3,
§5, §6, and in §9 that no English or French output changes, that the
documentation stays English and the voice of the translated languages
(settled by the product owner on 2026-11-21, question 77). The registry and
its code rule (§4), the review tracking (§7), §8 and the rollout order are
the orchestrator's design. §7 amended in place on 2026-11-21 by the `de`
pull request, with the mechanism as built.

Scope: the list of interface languages, how a language's copy is made and
released, the run-time fallback, and the code rule that makes a language
cheap to add.

Relations: amends N-I18N-01, N-I18N-04 and N-DATA-07 (spec 03), spec 00
§0.4 and the intro of spec 01 §1.5, in place; keeps two-language the data
of [ADR-081](ADR-081-vocabulaire-de-notions.md) (concept labels),
[ADR-095](ADR-095-catalogue-des-banques-publiques.md) §7 (pool domains)
and [ADR-087](ADR-087-nouveautes-de-la-plateforme.md) (What's new); the
printed words of [ADR-125](ADR-125-copies-papier-pdf-typst.md) §7 follow
§4 below. Open questions 75 (regional `Intl` tags) and 76 (the workspace
portal's fallback); question 77 (the voice of German and Italian) is
settled.

## Context

HEIG-VD is a Swiss school; German- and Italian-speaking students and
teachers, and other Swiss schools, are expected users. Quiz speaks English
and French (N-I18N-01), and both are *written*, not translated
(N-I18N-04): the author of a key writes its English and its French, by the
Voice rules of `apps/web/DESIGN.md`, and a typed `fr` dictionary makes a
missing French key a compile error.

Nobody on the team writes German or Italian at that standard, and the web
dictionary alone holds about 7,000 keys. Before this record, the code
also enumerated the two languages by hand in several places
(`=== "fr"`, `"en" | "fr"`, an `en`/`fr` map in the Teams package), so a
third language would have been a hunt rather than a list of compile errors.

## Decision

1. **Languages.** German (`de`) first, then Italian (`it`), beside English
   and French.

2. **Written and translated languages.** English and French stay
   *written* (N-I18N-04 unchanged for them). German and Italian are
   *translated*: complete, typed dictionaries (a missing key stays a
   compile error), machine-drafted from the English by the agent or person
   who adds the key, with a tracked review state (§7).

3. **Release.** A translated language goes to production, in the language
   picker, once its dictionaries are complete; no "beta" or "machine
   translation" mention.

4. **One list, one registry.** `LOCALES` in `packages/domain/src/locales.ts`
   is the list of the platform's interface languages; the contracts read it
   (`z.enum(LOCALES)`). Beside it: `LOCALE_INFO` (each language's endonym),
   `FALLBACK_LOCALE` (English), `isLocale`, `matchLocale` (the first
   supported base language of a list of BCP-47 tags: `navigator.languages`,
   `Accept-Language`) and `dataLanguage` (§6). The written/translated
   distinction of §2 is a decision, not yet code: it becomes code when a
   translated language needs it. Outside that file, no code compares an
   interface locale to a literal: a per-language value is a
   `Record<Locale, …>` or comes from the registry, so widening `LOCALES`
   names every place to fill as a compile error. Literals that remain
   legitimately: comparisons of two-language data (`ConceptLanguage`, §6),
   the development mocks that model it, and a collation or case folding
   fixed to one language (`localeCompare(…, "fr")`). Two exceptions keep
   their own list:
   - `@quiz/docexport` sits below `@quiz/domain` (`@quiz/core` imports it)
     and keeps its own copy of the union (`Lang`); the API hands it a
     `Locale`, so the compile error appears at that boundary.
   - The workspace portal (`apps/codespace`), a separate deployable with
     its own dictionary, its own `LANGS` and its own `Accept-Language`
     parser (its `CLAUDE.md`), whose fallback is French. It follows a new
     language in a later pull request of its own; whether its fallback
     stays French is open question 76.

5. **Fallback.** A key missing at run time reads its English (unchanged).
   The "Data and privacy" page (N-DATA-07) is a legal text: a reader of a
   translated language reads the English page until a human-reviewed
   translation of it exists. Its sources stay a `Record<Locale, string>`:
   the pull request that adds a language maps it to the English file.

6. **Two-language data stays two-language.** Concept labels (ADR-081), pool
   domains (ADR-095 §7) and What's new entries (ADR-087) keep French and
   English (`CONCEPT_LANGUAGES` of `@quiz/domain`, which the contracts'
   `CONCEPT_LANGS` reads). `dataLanguage(locale)` maps an interface
   language to the data language it reads: its own where the data has it,
   English otherwise. On the server, `readerLocale(req)` gives the
   interface language (a document's words, a name the platform writes) and
   `readerLang(req)` its data language (`apps/api/src/modules/http.ts`).

7. **Review tracking.** Each translated value is tracked against the
   English it was drafted from, and a human review is recorded per key.
   *As built (2026-11-21, the `de` pull request):* one file per translated
   language beside the dictionaries, `apps/web/src/i18n/<lang>.status.json`,
   one line per key, sorted, mapping the key to a short hash of the English
   its value was drafted from, or, once a person has reviewed it, to `r:`
   and a hash of the English and the translation as read (no German key is
   reviewed yet). The test `i18n/status.test.ts` fails on a key whose
   English changed since its draft, naming its file: the value is
   re-drafted, then re-stamped (`I18N_STATUS=stamp`, the rewrite pattern
   of the copy lint). A review whose English or translation changed is
   stale and fails too; the re-stamp turns it back into a draft stamp, and
   a person records it again. `I18N_STATUS=review=<lang>:<marks>` records
   reviews, a mark being one key, a key prefix ending in a dot, or a
   domain; a mark that matches no key fails. The same test holds a
   translated value to exactly the English placeholders, and the copy lint
   (`copy.test.ts`) applies the Voice rules to it, with the German rules of
   §9. The stamp records a claim, it does not check the translation: a
   re-stamp without a re-draft shows only in the diff.

8. **No i18n library.** Dictionaries stay hand-typed TypeScript next to
   their owner (the web app, the server's mail and Teams texts, the
   printed labels of `@quiz/docexport`, the workspace portal): the
   compile-time completeness check is the asset a library would trade
   away. No pluralization engine; the `.one` / `.many` keys stay.

9. **Rollout and voice.** Order: this registry; the web dictionary split
   by domain (a parallel pull request); `de`; then `it`. The built-in help
   files may follow a language later: the help drawer and the assistant's
   corpus fall back to the English topic. No English or French output
   changes: dates and numbers keep their current `Intl` tags (open
   question 75). The voice (product owner, 2026-11-21, question 77): German
   addresses the reader as *Sie*, with Swiss spelling (*ss*, never *ß*) and
   guillemets «…»; Italian uses the formal *Lei* where an address is
   needed, and guillemets «…». The glossary of spec 01 §1.5 gains a column
   per translated language in that language's pull request. Project
   documentation stays English.

10. **Regional formats** (product owner, 2026-11-21; settles open question 75).
    Quiz is a Swiss platform: each language formats dates, times and
    numbers with its regional `Intl` tag, French `fr-CH`, English `en-GB`
    (the British English of `apps/web/DESIGN.md`, and what the mails
    already wrote), German `de-CH` and Italian `it-CH` when they come. The
    tag is the `intl` field of `LOCALE_INFO` (§4), the one source: the web
    app reads it through `intlTag(locale)` beside its i18n machinery, and
    the mails' and Teams parameters' dates through the same field. The bare
    code stays everything else: the page's `<html lang>`, the account's
    `locale`, the dictionaries' key, a collation (`localeCompare`). The
    absolute dates of the account's date format (`iso`, `eu`, `uk`, `us`)
    are written by hand and do not change. This supersedes the sentence of
    §9 that dates and numbers keep their current `Intl` tags.

## Consequences

- Adding a language is one entry in `LOCALES` and `LOCALE_INFO`, then the
  compile errors: the dictionaries, the mail templates and their date tag,
  the Teams app's strings (from the server dictionary), the printed labels,
  Blockly's message pack, the group names, the training course's words,
  the assistant's fixed replies, the privacy page's sources. The Teams
  package's language files and the assistant's help corpus pick a new
  language up from the list. The workspace portal does not: its list is
  widened by hand, in its own pull request (§4).
- Every pull request that adds a key writes two more values its author
  cannot proofread. Tracking a draft against its English keeps a stale
  draft from shipping silently; it does not make the draft good.
- German runs about 30 % longer than English: the length ceilings of the
  copy lint (`copy.test.ts`) and narrow layouts will flag or clip it. The
  German draft keeps four labels over the button ceiling, listed in
  `copy.exceptions.json` under `de-`.
- Nobody reviews German or Italian today; until someone does, those
  readers get machine-drafted copy without a label saying so (§3).
- A German or Italian reader reads concepts, pool domains, What's new and
  the privacy page in English (or French where the data has only French).
- Today's readers see Swiss and British formats (§10): in English the day
  before the month ("Fri 6 Nov"), in French a percentage without a space
  ("85%"); a new language adds its `intl` tag beside its endonym.

## Alternatives considered

- **Write German and Italian like French.** Nobody can, at the standard
  N-I18N-04 sets; the languages would never ship.
- **Partial dictionaries with a per-key English fallback** (`Partial<Dict>`).
  Ships faster, but a screen mixes languages and no check says where;
  rejected for the complete, typed dictionaries of §2.
- **An i18n library or a translation platform** (ICU messages, extraction).
  Loses the compile-time completeness check and adds a build step; rejected
  (§8).
- **A second locale list in `packages/contracts`**, as issue #543 proposed.
  Two lists drift; the contracts already read the domain's.
- **Translated languages fall back to French** for an Italian reader.
  English is the complete source of every key; kept as the one fallback.
