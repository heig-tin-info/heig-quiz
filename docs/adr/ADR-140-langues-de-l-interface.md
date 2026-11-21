# ADR-140 — Interface languages: German and Italian as translated languages, one locale registry

## Status

Accepted (2026-11-21, decided by the product owner on issue #543): §1–§3,
§5, §6, and in §9 that no English or French output changes and that the
documentation stays English. The registry and its code rule (§4), the
review tracking (§7), §8 and the rollout order are the orchestrator's
design; the voice of the translated languages (§9) is an assumption.

Scope: the list of interface languages, how a language's copy is made and
released, the run-time fallback, and the code rule that makes a language
cheap to add.

Relations: amends N-I18N-01, N-I18N-04 and N-DATA-07 (spec 03), spec 00
§0.4 and the intro of spec 01 §1.5, in place; keeps two-language the data
of [ADR-081](ADR-081-vocabulaire-de-notions.md) (concept labels),
[ADR-095](ADR-095-catalogue-des-banques-publiques.md) §7 (pool domains)
and [ADR-087](ADR-087-nouveautes-de-la-plateforme.md) (What's new); the
printed words of [ADR-125](ADR-125-copies-papier-pdf-typst.md) §7 follow
§4 below. Open question 75 (regional `Intl` tags).

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
   stays the single list (the contracts' `z.enum(LOCALES)` reads it; there
   is no second one). Beside it: `LOCALE_INFO` (each language's endonym and
   whether it is `written` or `translated`), `FALLBACK_LOCALE` (English),
   `isLocale`, `matchLocale` (the first supported base language of a list
   of BCP-47 tags: `navigator.languages`, `Accept-Language`) and
   `dataLanguage` (§6). Outside that file, no code compares a locale to a
   literal: a per-language value is a `Record<Locale, …>` or comes from the
   registry, so widening `LOCALES` names every place to fill as a compile
   error. A package below `@quiz/domain` (`@quiz/docexport`, which
   `@quiz/core` imports) keeps its own copy of the union, fed a `Locale` by
   the API, so the error appears at that boundary.

5. **Fallback.** A key missing at run time reads its English (unchanged).
   The "Data and privacy" page (N-DATA-07) is a legal text: a reader of a
   translated language reads the English page until a human-reviewed
   translation of it exists. Its sources are typed per *written* language,
   optional for the others.

6. **Two-language data stays two-language.** Concept labels (ADR-081), pool
   domains (ADR-095 §7) and What's new entries (ADR-087) keep French and
   English. `dataLanguage(locale)` maps an interface language to the data
   language it reads: French for French, English for every other. On the
   server, `readerLocale(req)` gives the interface language (a document's
   words, a name the platform writes) and `readerLang(req)` its data
   language (`apps/api/src/modules/http.ts`).

7. **Review tracking** (lands with the `de` pull request; described here).
   Each translated value records a hash of the English it was drafted
   from; a test refuses a draft whose English has changed since. A human
   review is recorded per key and dropped when the English changes. A
   script reports, per translated language, the drafted, stale and
   reviewed counts.

8. **No i18n library.** Dictionaries stay hand-typed TypeScript next to
   their owner (the web app, the server's mail and Teams texts, the
   printed labels of `@quiz/docexport`, the workspace portal): the
   compile-time completeness check is the asset a library would trade
   away. No pluralization engine; the `.one` / `.many` keys stay.

9. **Rollout and voice.** Order: this registry; the web dictionary split
   by domain (a parallel pull request); `de`; then `it`. The workspace
   portal, the Teams app package and the built-in help files may follow a
   language with an English fallback meanwhile (the help drawer already
   falls back per topic). No English or French output changes: dates and
   numbers keep their current `Intl` tags. Assumed voice, to be confirmed
   by a reviewer of each language: German addresses the reader as *Sie*,
   with Swiss spelling (*ss*, never *ß*) and guillemets «…»; Italian uses
   the formal *Lei* where an address is needed, and guillemets «…». The
   glossary of spec 01 §1.5 gains a column per translated language in
   that language's pull request. Project documentation stays English.

## Consequences

- Adding a language is one entry in `LOCALES` and `LOCALE_INFO`, then the
  compile errors: the dictionaries, the mail templates and their date tag,
  the printed labels, the group names, the training course's words, the
  assistant's fixed replies. The
  Teams package and the assistant's help corpus pick a new language up
  from the list.
- Every pull request that adds a key writes two more values its author
  cannot proofread. The hash check keeps a stale draft from shipping
  silently; it does not make the draft good.
- German runs about 30 % longer than English: the length ceilings of the
  copy lint (`copy.test.ts`) and narrow layouts will flag or clip it.
- Nobody reviews German or Italian today; until someone does, those
  readers get machine-drafted copy without a label saying so (§3).
- A German or Italian reader reads concepts, pool domains, What's new and
  the privacy page in English (or French where the data has only French).

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
