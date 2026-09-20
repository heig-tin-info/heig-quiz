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
    label: t("qt.short.label"),
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
    hint: t("qt.cloze.hint"),
  };
}

/**
 * `code` is the one dictionary with interpolating entries: the package types
 * them as functions, so the host closes over `t` instead of over a literal.
 */
export function codePlayerStrings(t: TFunction) {
  return {
    locked: t("qt.code.locked"),
    editableRegion: (n: number) => t("qt.code.editableRegion", { n }),
    run: t("qt.code.run"),
    running: t("qt.code.running"),
    runUnavailable: t("qt.code.runUnavailable"),
    runFailed: t("qt.code.runFailed"),
    runHint: t("qt.code.runHint"),
    visibleCases: t("qt.code.visibleCases"),
    noVisibleCases: t("qt.code.noVisibleCases"),
    hiddenCases: (count: number, points: number) =>
      count === 1
        ? t("qt.code.hiddenCase", { points })
        : t("qt.code.hiddenCases", { n: count, points }),
    files: t("qt.code.files"),
    caseName: t("qt.code.caseName"),
    stdin: t("qt.code.stdin"),
    expected: t("qt.code.expected"),
    got: t("qt.code.got"),
    verdict: t("qt.code.verdict"),
    passed: t("qt.code.passed"),
    failed: t("qt.code.failed"),
    notRun: t("qt.code.notRun"),
    timedOut: t("qt.code.timedOut"),
    outOfMemory: t("qt.code.outOfMemory"),
    compileFailed: t("qt.code.compileFailed"),
    compileOk: t("qt.code.compileOk"),
    allOrNothing: t("qt.code.allOrNothing"),
    limits: (timeMs: number, memoryMb: number) => t("qt.code.limits", { timeMs, memoryMb }),
  };
}

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
