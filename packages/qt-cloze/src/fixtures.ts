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
 * fenced code block for two of them, and one more dropdown inside a markdown
 * TABLE CELL, where the `|` of the hole is the case the editor protects.
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
  "| Force | {{=NEWTON-MARKER|pascal|joule}} |",
].join("\n");

export const SECRET_CONFIG: ClozeConfig = config(SECRET_TEXT);

/**
 * Values that must never appear in the serialised student view.
 *
 * The last two are the dropdown case, and they are the reason the fixture
 * holds one at all: the option LABELS legitimately travel — they are the list
 * the student picks from — so the marker is placed in the `=` POSITION, i.e.
 * the mark that says which one is right. `=NEWTON-MARKER` can only appear in
 * the output if the raw body leaked; `NEWTON-MARKER` alone is allowed to, and
 * `"correct"` proves the index list stayed behind (decision D4: what travels
 * is the canonical option id, never the key).
 */
export const SECRET_VALUES = ["Newton", "^N$", "+=", "#10", "=NEWTON-MARKER", "=newton"];
