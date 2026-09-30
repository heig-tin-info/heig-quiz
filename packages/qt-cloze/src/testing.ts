/**
 * `@quiz/qt-cloze/testing` — the full configuration of the leak test
 * (invariant 4, docs/spec/05 §5.7). TEST-ONLY: nothing in `apps/*` imports it.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { CLOZE_CONFIG_VERSION, ClozeConfigSchema, type ClozeConfig } from "./schema.js";

/**
 * The example of PLAN-MVP §2.3: one text blank with alternatives, a number, a
 * text blank with an escaped `|`, a dropdown and a weighted regex — inside a
 * fenced code block for two of them, and one more dropdown inside a markdown
 * TABLE CELL, where the `|` of the hole is the case the editor protects.
 */
const SECRET_TEXT = [
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

export const SECRET_CONFIG: ClozeConfig = ClozeConfigSchema.parse({
  configVersion: CLOZE_CONFIG_VERSION,
  text: SECRET_TEXT,
});

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
const SECRET_VALUES = ["Newton", "^N$", "+=", "#10", "=NEWTON-MARKER", "=newton"];

export const clozeLeakFixture: StudentLeakFixture<ClozeConfig> = {
  config: SECRET_CONFIG,
  /*
   * A blank publishes its `kind`, never its `mode`, and the regex `flags` say
   * as much about the key as the pattern does.
   */
  forbiddenKeys: [
    // Out of the floor since R-06 (only `code` publishes it, on purpose); here
    // it still names nothing this type may publish.
    "compare",
    "expected",
    "flags",
    "mode",
    "policy",
    "tolerance",
    "value",
  ],
  secrets: SECRET_VALUES,
};
