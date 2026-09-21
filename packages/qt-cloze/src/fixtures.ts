/** Test fixtures for the `cloze` suites (excluded from the build). */
import type { GradeContext, RunnerService } from "@quiz/core/server";
import { CLOZE_CONFIG_VERSION, ClozeConfigSchema, type ClozeConfig } from "./schema.js";

export const noRunner: RunnerService = {
  run() {
    throw new Error("the cloze type must never call the runner");
  },
  health() {
    return Promise.resolve({ ok: false, languages: [], queued: 0, avgMs: null });
  },
};

export function gradeContext(itemPoints: number): GradeContext {
  return {
    seed: 7,
    itemId: "item-1",
    attemptId: "attempt-1",
    itemPoints,
    now: new Date("2026-09-20T10:00:00Z"),
    runner: noRunner,
  };
}

export function config(text: string, over: Partial<ClozeConfig> = {}): ClozeConfig {
  return ClozeConfigSchema.parse({ configVersion: CLOZE_CONFIG_VERSION, text, ...over });
}

/**
 * The example of PLAN-MVP §2.3: one text blank with alternatives, a number, a
 * text blank with an escaped `|`, a dropdown and a weighted regex — inside a
 * fenced code block for two of them.
 */
export const SECRET_TEXT = [
  "La loi de {{Newton|newton}} lie force, masse et accélération : **F = m·a**.",
  "",
  "```c",
  "for (int i = 0; i < {{#10:0}}; i++) {",
  "    total {{+=|+ =}} tab[i];",
  "}",
  "```",
  "",
  "L'unité SI de la force est le {{=newton|joule|watt|pascal}}, de symbole {{2*/^N$/}}.",
  "",
  "| Grandeur | Unité |",
  "| --- | --- |",
  "| Force | {{SET-KEY-MARKER}} |",
].join("\n");

/**
 * The predefined choice set the fixture's TABLE cell uses. Its key is a
 * marker: the option labels legitimately reach the student — they are the
 * dropdown — but which one is correct, and the name of the set they came
 * from, must not. `SECRET_VALUES` below asserts exactly that.
 */
export const SECRET_SETS = [
  {
    key: "SET-KEY-MARKER",
    options: [
      { label: "newton", correct: true },
      { label: "pascal", correct: false },
      { label: "joule", correct: false },
    ],
  },
];

export const SECRET_CONFIG: ClozeConfig = config(SECRET_TEXT, { choiceSets: SECRET_SETS });

/** Values that must never appear in the serialised student view. */
export const SECRET_VALUES = ["Newton", "^N$", "+=", "#10", "SET-KEY-MARKER"];
