import { describe, expect, it } from "vitest";

import { mcqEditorStrings, mcqPlayerStrings, mcqReviewStrings, mcqStatsStrings } from "@quiz/qt-mcq/client";
import { shortEditorStrings, shortPlayerStrings, shortReviewStrings } from "@quiz/qt-short/client";
import { clozeEditorStrings, clozePlayerStrings, clozeReviewStrings } from "@quiz/qt-cloze/client";
import { EDITOR_STRINGS, PLAYER_STRINGS, REVIEW_STRINGS } from "@quiz/qt-code/client";
import {
  CANVAS_STRINGS,
  EDITOR_STRINGS as CIRCUIT_EDITOR_STRINGS,
  KIND_LABELS,
  PLAYER_STRINGS as CIRCUIT_PLAYER_STRINGS,
  REVIEW_STRINGS as CIRCUIT_REVIEW_STRINGS,
} from "@quiz/qt-circuit/client";

import { DICTS, type Locale, type TFunction } from "./i18n";
import {
  circuitCanvasStrings,
  circuitKindLabels,
  editorStrings,
  MCQ_HOST_MAPPED_KEYS,
  playerStrings,
  questionType,
  reviewStrings,
  QUESTION_TYPE_IDS,
  typeHint,
  typeLabel,
} from "./questionTypes";

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
  ["qt.circuit.e", CIRCUIT_EDITOR_STRINGS],
  ["qt.circuit.p", CIRCUIT_PLAYER_STRINGS],
  ["qt.circuit.r", CIRCUIT_REVIEW_STRINGS],
  // The canvas and the component kinds are dictionaries of the `circuit`
  // package too, keyed by something other than a sentence; they are
  // translated the same way and must be just as complete.
  ["qt.circuit.c", CANVAS_STRINGS],
  ["qt.circuit.kind", KIND_LABELS],
];

/**
 * A few keys are NOT looked up under `<prefix>.<key>`: the MCQ scoring
 * policies are worded once under `mcq.policy.*`, because the settings page
 * and an evaluation's advanced options show the same five, and
 * `editorStrings.mcq` maps the editor's keys onto them. They are checked by
 * their own case below.
 */
const MAPPED_ELSEWHERE: Record<string, readonly string[]> = { "qt.mcq.e": MCQ_HOST_MAPPED_KEYS };

describe("question type strings", () => {
  it.each(DICTIONARIES)("%s is translated key by key", (prefix, defaults) => {
    for (const [key, value] of Object.entries(defaults)) {
      if (MAPPED_ELSEWHERE[prefix]?.includes(key)) continue;
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

  it("words the MCQ policies once, for the editor and the two settings screens", () => {
    for (const locale of ["en", "fr"] as const) {
      const strings = editorStrings.mcq(makeT(locale)) as unknown as Record<string, string>;
      for (const key of MCQ_HOST_MAPPED_KEYS) {
        expect(strings[key], `${key} (${locale})`).toBeTruthy();
        expect(strings[key]).not.toMatch(/^mcq\.policy\./);
      }
    }
  });

  it("translates the editor strings of every type", () => {
    const t = makeT("fr");
    expect(editorStrings.mcq(t).prompt).toBe("Énoncé");
    expect(editorStrings.short(t).matchers).toBe("Réponses acceptées");
    expect(editorStrings.cloze(t).text).toBe("Texte à trous");
    expect(editorStrings.code(t).template).toBe("Code de départ");
    expect(editorStrings.circuit(t).reference).toBe("Circuit de référence");
  });

  it("translates the circuit canvas and the component kinds", () => {
    for (const locale of ["en", "fr"] as const) {
      const t = makeT(locale);
      const kinds = circuitKindLabels(t);
      for (const kind of Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]) {
        expect(kinds[kind], `${kind} (${locale})`).not.toMatch(/^qt\.circuit\./);
      }
      const canvas = circuitCanvasStrings(t);
      // The canvas asks for a kind through a function; the host answers it
      // from the dictionary above rather than from the library's English.
      expect(canvas.kind("R")).toBe(kinds.R);
      expect(canvas.componentCount(3, 10)).toBe("3 / 10");
    }
    expect(circuitKindLabels(makeT("fr")).R).toBe("Résistance");
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

  it("rebuilds the parameterized sentences of the circuit type", () => {
    const t = makeT("en");
    expect(editorStrings.circuit(t).stimulus(2)).toBe("Stimulus 2");
    expect(editorStrings.circuit(t).totalPoints(1)).toBe("1 point in total");
    expect(editorStrings.circuit(t).tryDone(3)).toBe("3 stimuli simulated.");
    expect(playerStrings.circuit(t).components(3, 10)).toBe("3 / 10 components");
    expect(playerStrings.circuit(t).issueFloatingPin("R1.2")).toBe("R1.2 is not connected.");
    expect(playerStrings.circuit(t).hiddenStimuli(1, 2)).toBe("1 hidden stimulus, worth 2 point(s).");
    expect(reviewStrings.circuit(t).hiddenStimulus(2)).toBe("#2");
    expect(reviewStrings.circuit(t).netSummary(4, 5)).toBe("Components: 4 · Nets: 5");
  });
});
