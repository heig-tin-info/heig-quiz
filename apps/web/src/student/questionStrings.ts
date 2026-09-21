/**
 * The French (and English) half of the question-type components.
 *
 * A `qt-*` package ships a complete ENGLISH dictionary and accepts a typed
 * partial override (`StringOverrides`, deviation W2-3): it cannot import
 * `apps/web`, and `apps/web` owns the translations (N-I18N-01). This module
 * is the one place the two meet — every string a student reads inside a
 * question comes from `i18n.tsx` through here.
 */
import type { TFunction } from "../i18n";
import { playerStrings } from "../questionTypes";

export function mcqPlayerStrings(t: TFunction) {
  return {
    chooseOne: t("qt.mcq.chooseOne"),
    chooseSeveral: t("qt.mcq.chooseSeveral"),
    chooseUpTo: t("qt.mcq.chooseUpTo"),
    limitReached: t("qt.mcq.limitReached"),
  };
}

export function shortPlayerStrings(t: TFunction) {
  return {
    label: t("qt.short.player.label"),
    hintText: t("qt.short.hintText"),
    hintNumber: t("qt.short.hintNumber"),
    hintDate: t("qt.short.hintDate"),
    hintTime: t("qt.short.hintTime"),
  };
}

export function clozePlayerStrings(t: TFunction) {
  return {
    blank: t("qt.cloze.blank"),
    choose: t("qt.cloze.choose"),
    hint: t("qt.cloze.player.hint"),
  };
}

/**
 * `code` is the one dictionary with interpolating entries, and the one the
 * app builds TWICE — once for this host and once for `QuestionPlayerHost`.
 * It is built once, in `questionTypes.tsx`, and read here: two copies of
 * fifteen sentences drift, and only one of them is under the key-by-key test
 * of `questionTypes.test.tsx`.
 */
export const codePlayerStrings = (t: TFunction) => playerStrings.code(t);

/** The dictionary a given type's player expects, or `undefined` for an unknown one. */
export function playerStringsFor(type: string, t: TFunction): unknown {
  switch (type) {
    case "mcq":
      return mcqPlayerStrings(t);
    case "short":
      return shortPlayerStrings(t);
    case "cloze":
      return clozePlayerStrings(t);
    case "code":
      return codePlayerStrings(t);
    default:
      return undefined;
  }
}
