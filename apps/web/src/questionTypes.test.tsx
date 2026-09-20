import { describe, expect, it } from "vitest";

import { mcqEditorStrings, mcqPlayerStrings, mcqReviewStrings, mcqStatsStrings } from "@quiz/qt-mcq/client";
import { shortEditorStrings, shortPlayerStrings, shortReviewStrings } from "@quiz/qt-short/client";
import { clozeEditorStrings, clozePlayerStrings, clozeReviewStrings } from "@quiz/qt-cloze/client";
import { EDITOR_STRINGS, PLAYER_STRINGS, REVIEW_STRINGS } from "@quiz/qt-code/client";

import { DICTS, type Locale, type TFunction } from "./i18n";
import { editorStrings, playerStrings, questionType, QUESTION_TYPE_IDS, typeHint, typeLabel } from "./questionTypes";

/*
 * A `qt-*` package ships English defaults and takes a `strings` override
 * (deviation W2-3); `apps/web` is what translates. This suite is the proof
 * that the translation is COMPLETE: every key a package exposes has an entry
 * in both dictionaries, so a French teacher never meets an English label and
 * a key renamed in a package fails here instead of on screen.
 */

function makeT(locale: Locale): TFunction {
  return (key, vars) => {
    const raw = DICTS[locale][key as string] ?? String(key);
    return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
  };
}

const DICTIONARIES: [string, object][] = [
  ["qt.mcq.e", mcqEditorStrings],
  ["qt.mcq.p", mcqPlayerStrings],
  ["qt.mcq.r", mcqReviewStrings],
  ["qt.mcq.s", mcqStatsStrings],
  ["qt.short.e", shortEditorStrings],
  ["qt.short.p", shortPlayerStrings],
  ["qt.short.r", shortReviewStrings],
  ["qt.cloze.e", clozeEditorStrings],
  ["qt.cloze.p", clozePlayerStrings],
  ["qt.cloze.r", clozeReviewStrings],
  ["qt.code.e", EDITOR_STRINGS],
  ["qt.code.p", PLAYER_STRINGS],
  ["qt.code.r", REVIEW_STRINGS],
];

describe("question type strings", () => {
  it.each(DICTIONARIES)("%s is translated key by key", (prefix, defaults) => {
    for (const [key, value] of Object.entries(defaults)) {
      // A parameterized sentence is rebuilt by hand in `questionTypes.tsx`;
      // its key still has to exist, with or without the `.one` variant.
      const full = `${prefix}.${key}`;
      const exists = (locale: Locale) =>
        DICTS[locale][full] !== undefined || typeof value === "function";
      expect(exists("en"), `${full} (en)`).toBe(true);
      expect(exists("fr"), `${full} (fr)`).toBe(true);
    }
  });

  it("gives every type a label and a hint in both languages", () => {
    for (const locale of ["en", "fr"] as const) {
      const t = makeT(locale);
      for (const id of QUESTION_TYPE_IDS) {
        const client = questionType(id)!;
        expect(typeLabel(t, id)).not.toBe(client.labelKey);
        expect(typeHint(t, id)).not.toBe(client.hintKey);
      }
    }
  });

  it("translates the editor strings of every type", () => {
    const t = makeT("fr");
    expect(editorStrings.mcq(t).prompt).toBe("Énoncé");
    expect(editorStrings.short(t).matchers).toBe("Réponses acceptées");
    expect(editorStrings.cloze(t).text).toBe("Texte à trous");
    expect(editorStrings.code(t).template).toBe("Code de départ");
  });

  it("rebuilds the parameterized sentences of the code type", () => {
    const t = makeT("en");
    expect(editorStrings.code(t).lockedRegions(1)).toBe("1 locked region");
    expect(editorStrings.code(t).lockedRegions(3)).toBe("3 locked regions");
    expect(editorStrings.code(t).tryResult(2, 3)).toBe("2 of 3 cases pass.");
    expect(editorStrings.code(t).removeCase("stdin")).toBe("Remove the case stdin");
    expect(playerStrings.code(t).limits(2000, 128)).toBe("2000 ms · 128 MB");
    expect(playerStrings.code(t).hiddenCases(1, 2)).toBe("1 hidden case, worth 2 points.");
  });
});
